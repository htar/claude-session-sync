import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isValidRepoUrl, remoteOf } from './core/git';
import { DeviceInfo } from './core/devices';
import { ensureSyncFolder, STORAGES, storageRoots } from './core/storages';
import { ensurePrivateRepo, githubAuthEnv } from './core/github';
import { Limits, MB, parseLimits } from './core/limits';
import { Logger } from './core/logger';
import { claudeProjectsDir, encodeProjectDir, projectKey } from './core/paths';
import { SyncResult, SyncService } from './core/syncService';
import { listSessions } from './core/transcripts';
import { FolderTransport, GitTransport, Transport } from './core/transport';

const WARNED_KEY = 'pushWarningAccepted';
const SECTION = 'claudeSessionSync';

function channelLogger(channel: vscode.OutputChannel): Logger {
  const write = (level: string) => (m: string) => {
    channel.appendLine(`[${new Date().toISOString()}] ${level} ${m}`);
  };
  return { info: write('INFO'), warn: write('WARN'), error: write('ERROR') };
}

interface Session {
  service: SyncService;
  localDir: string;
  folder: string;
  limits: Limits;
  /** Where the sessions go, for messages: «GitHub», the cloud folder or the repository address. */
  where: string;
}

type Mode = 'github' | 'folder' | 'git';

const METHODS: (vscode.QuickPickItem & { mode: Mode })[] = [
  {
    mode: 'github',
    label: '$(github) GitHub (automatic)',
    description: 'Sign in once; a private «claude-sessions» repository is created for you',
  },
  {
    mode: 'folder',
    label: '$(cloud) Cloud storage',
    description: 'iCloud Drive, Dropbox, OneDrive, Google Drive, MEGA, pCloud, Box…',
  },
  {
    mode: 'git',
    label: '$(repo) My own git repository',
    description: 'Any private repository you set up yourself (https or ssh)',
  },
];

const CHANGE_METHOD = 'Change method';

/** Errors that mean «cannot reach or not signed in», as opposed to a bug. */
const isAccessError = (m: string): boolean =>
  /Sync folder not found|HTTP 40[13]|authentication failed|could not read (username|password)|permission denied|not authorized|repository not found|sign.?in/i.test(
    m,
  );

const isMode = (v: unknown): v is Mode => v === 'github' || v === 'folder' || v === 'git';

/** The saved method, or a one-time question on first use. `forceAsk` is «Choose sync method». */
async function chooseMode(cfg: vscode.WorkspaceConfiguration, forceAsk: boolean): Promise<Mode | undefined> {
  const saved = cfg.get<string>('mode');
  if (!forceAsk && isMode(saved)) return saved;
  const pick = await vscode.window.showQuickPick(METHODS, {
    title: 'Claude Sync: how should sessions travel between your devices?',
    placeHolder: 'You can change this later with «Claude Sync: Choose sync method»',
  });
  if (!pick) return undefined;
  await cfg.update('mode', pick.mode, vscode.ConfigurationTarget.Global);
  // A new choice starts clean: the folder of the previous cloud storage must not be reused.
  if (forceAsk) await cfg.update('syncFolder', '', vscode.ConfigurationTarget.Global);
  return pick.mode;
}

/** Human-readable place of the saved method, for messages. */
function describeMethod(cfg: vscode.WorkspaceConfiguration): string {
  const mode = cfg.get<string>('mode');
  if (mode === 'github') return 'GitHub (private claude-sessions repository)';
  if (mode === 'folder') return cfg.get<string>('syncFolder', '') || 'a cloud folder';
  if (mode === 'git') return cfg.get<string>('repoUrl', '') || 'your git repository';
  return 'nowhere yet';
}

async function githubTransport(context: vscode.ExtensionContext): Promise<Transport> {
  const authed = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
  const { cloneUrl } = await ensurePrivateRepo(authed.accessToken);
  const token = async () =>
    (await vscode.authentication.getSession('github', ['repo'], { createIfNone: false }))?.accessToken ??
    authed.accessToken;
  return new GitTransport(path.join(context.globalStorageUri.fsPath, 'github-repo'), cloneUrl, async () =>
    githubAuthEnv(await token()),
  );
}

async function pickFolderByHand(title: string): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    defaultUri: vscode.Uri.file(os.homedir()),
    title,
    openLabel: 'Use this folder',
  });
  return picked?.[0]?.fsPath;
}

/**
 * The user names the storage; «Claude Sessions» is created at its root. Only when the storage's app folder is
 * not where it is expected does the user have to point at it.
 */
async function folderTransport(cfg: vscode.WorkspaceConfiguration): Promise<Transport | undefined> {
  let folder = cfg.get<string>('syncFolder', '').trim();
  if (!folder || !path.isAbsolute(folder)) {
    const OTHER = 'Another folder…';
    const choice = await vscode.window.showQuickPick([...STORAGES.map((s) => s.label), OTHER], {
      title: 'Claude Sync: which cloud storage do you use?',
      placeHolder: 'A «Claude Sessions» folder will be created at its root',
    });
    if (!choice) return undefined;
    const storage = STORAGES.find((s) => s.label === choice);
    const found = storage
      ? storageRoots(storage, { home: os.homedir(), platform: process.platform, env: process.env })
      : [];
    let root = found.length === 1 ? found[0] : undefined;
    if (found.length > 1)
      root = (await vscode.window.showQuickPick(found, { title: `Which ${choice} account?` })) ?? undefined;
    else if (!found.length) {
      if (storage)
        void vscode.window.showInformationMessage(
          `Claude Sync: ${choice} was not found in its usual place. Pick its folder.`,
        );
      root = await pickFolderByHand(`Pick the ${storage ? choice : 'synced'} folder on this computer`);
    }
    if (!root) return undefined;
    folder = ensureSyncFolder(root);
    await cfg.update('syncFolder', folder, vscode.ConfigurationTarget.Global);
  }
  return new FolderTransport(folder);
}

async function gitTransport(context: vscode.ExtensionContext, cfg: vscode.WorkspaceConfiguration) {
  const repoUrl = cfg.get<string>('repoUrl', '').trim();
  if (!isValidRepoUrl(repoUrl)) {
    const pick = await vscode.window.showErrorMessage(
      'Claude Sync: set a valid claudeSessionSync.repoUrl (https, ssh or git@host:owner/repo of a PRIVATE repository).',
      'Open settings',
    );
    if (pick) await vscode.commands.executeCommand('workbench.action.openSettings', `${SECTION}.repoUrl`);
    return undefined;
  }
  return new GitTransport(path.join(context.globalStorageUri.fsPath, 'repo'), repoUrl);
}

async function openSession(context: vscode.ExtensionContext, log: Logger): Promise<Session | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) {
    void vscode.window.showErrorMessage('Claude Sync: open a folder first.');
    return;
  }
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const mode = await chooseMode(cfg, false);
  if (!mode) return;
  const transport = await {
    github: () => githubTransport(context),
    folder: () => folderTransport(cfg),
    git: () => gitTransport(context, cfg),
  }[mode]();
  if (!transport) return;
  const localDir = path.join(claudeProjectsDir(cfg.get<string>('claudeDir', '')), encodeProjectDir(folder));
  const key = projectKey(await remoteOf(folder), folder);
  const limits = parseLimits({
    maxFileSizeMB: cfg.get('maxFileSizeMB'),
    maxSessionAgeDays: cfg.get('maxSessionAgeDays'),
  });
  const deviceName = cfg.get<string>('deviceName', '').trim() || os.hostname();
  const service = new SyncService({ transport, localDir, projectKey: key, deviceName, limits }, log);
  return { service, localDir, folder, limits, where: describeMethod(vscode.workspace.getConfiguration(SECTION)) };
}

async function confirmFirstPush(context: vscode.ExtensionContext): Promise<boolean> {
  if (context.globalState.get<boolean>(WARNED_KEY)) return true;
  const ok = await vscode.window.showWarningMessage(
    'Session transcripts contain your code, command output and possibly secrets. Send them only to a PRIVATE place you control (a private repository or your own cloud folder).',
    { modal: true },
    'I understand, push',
  );
  if (ok) await context.globalState.update(WARNED_KEY, true);
  return Boolean(ok);
}


function report(verb: 'push' | 'pull', r: SyncResult, limits: Limits, where: string, device: string): void {
  const older = r.tooOld > 0 ? ` ${r.tooOld} older than ${limits.maxAgeDays} days left out.` : '';
  const via = verb === 'push' ? `to ${where} as «${device}»` : `from «${device}» in ${where}`;
  void vscode.window
    .showInformationMessage(
      r.pushed === false
        ? `Claude Sync: nothing new to ${verb} ${via}.${older}`
        : `Claude Sync: ${verb}ed ${r.copied.length} session(s) ${via}.${older}`,
      'Manage connection',
    )
    .then((pick) => (pick ? vscode.commands.executeCommand(`${SECTION}.manage`) : undefined));
  if (r.tooLarge.length) {
    void vscode.window.showWarningMessage(
      `Claude Sync: ${r.tooLarge.length} session(s) are over ${Math.round(limits.maxFileBytes / MB)} MB and were NOT pushed: ${r.tooLarge.join(', ')}`,
    );
  }
  if (r.notDownloaded) {
    void vscode.window.showWarningMessage(
      `Claude Sync: ${r.notDownloaded} session(s) are still in iCloud and not downloaded to this Mac yet. ` +
        'Open the folder in Finder (right-click → Download Now), then pull again.',
    );
  }
  if (r.conflicts.length) {
    void vscode.window.showWarningMessage(
      `Claude Sync: ${r.conflicts.length} session(s) were continued on two devices and were NOT overwritten: ${r.conflicts.join(', ')}`,
    );
  }
}

const mb = (bytes: number) =>
  bytes < MB ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / MB).toFixed(1)} MB`;

const deviceLabel = (d: DeviceInfo): string => (d.legacy ? 'Shared (before 0.5.0)' : d.name);

/** Which device's export to work with. Skips the question when there is only one candidate. */
async function chooseDevice(
  service: SyncService,
  opts: { includeOwn: boolean; title: string },
): Promise<DeviceInfo | undefined> {
  const all = await progress('Claude Sync: looking at the storage…', () => service.devices());
  const devices = all.filter((d) => opts.includeOwn || d.name !== service.device);
  if (!devices.length) {
    void vscode.window.showInformationMessage(
      opts.includeOwn
        ? 'Claude Sync: nothing has been exported for this project yet.'
        : 'Claude Sync: no other device has exported this project yet. Run «Push sessions» on that device first.',
    );
    return undefined;
  }
  if (devices.length === 1 && !opts.includeOwn) return devices[0];
  const pick = await vscode.window.showQuickPick(
    devices.map((d) => ({
      label: deviceLabel(d) + (d.name === service.device ? ' (this device)' : ''),
      description: `${d.sessions} session(s)`,
      device: d,
    })),
    { title: opts.title, placeHolder: 'Choose a device' },
  );
  return pick?.device;
}

const STATUS_LABEL: Record<string, string> = {
  new: 'new on this device',
  updated: 'newer than your copy',
  conflict: 'differs from your copy',
};

/** Lets the user tick the sessions to bring over. Returns their ids, or undefined when cancelled or nothing is left to pull. */
async function chooseSessionsToPull(service: SyncService, from: string): Promise<string[] | undefined> {
  const sessions = (await progress('Claude Sync: looking at the storage…', () => service.available(from))).filter(
    (x) => x.status !== 'same',
  );
  if (!sessions.length) {
    void vscode.window.showInformationMessage('Claude Sync: everything in the storage is already on this device.');
    return undefined;
  }
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { id: string }>();
  qp.canSelectMany = true;
  qp.matchOnDetail = true;
  qp.title = `Claude Sync: which sessions to pull? (${sessions.length} available)`;
  qp.placeholder = 'Tick the sessions you want on this device, then press Enter';
  qp.items = sessions.map((x) => ({
    id: x.id,
    label: x.title,
    description: `${new Date(x.lastActivity).toLocaleString()} · ${mb(x.bytes)} · ${STATUS_LABEL[x.status] ?? x.status}`,
    detail: x.id,
  }));
  const all = { iconPath: new vscode.ThemeIcon('check-all'), tooltip: 'Select all' };
  qp.buttons = [all];
  qp.onDidTriggerButton(() => {
    qp.selectedItems = qp.items;
  });
  return new Promise<string[] | undefined>((resolve) => {
    qp.onDidAccept(() => {
      resolve(qp.selectedItems.map((i) => i.id));
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
    qp.show();
  }).then((ids) => (ids?.length ? ids : undefined));
}

const progress = <T>(title: string, task: () => Promise<T>) =>
  vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Claude Session Sync');
  const log = channelLogger(channel);

  /** The chosen storage cannot be reached or the account is not signed in: offer to reconnect instead of a bare error. */
  const reconnect = async (message: string): Promise<boolean> => {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    const mode = cfg.get<string>('mode');
    if (mode === 'github') {
      const pick = await vscode.window.showErrorMessage(
        `Claude Sync: no access to GitHub (${message}).`,
        'Sign in to GitHub',
        CHANGE_METHOD,
      );
      if (pick === 'Sign in to GitHub') {
        await vscode.authentication.getSession('github', ['repo'], { forceNewSession: true });
        return true;
      }
      if (pick) await vscode.commands.executeCommand(`${SECTION}.chooseMode`);
      return false;
    }
    if (mode === 'folder') {
      const pick = await vscode.window.showErrorMessage(
        `Claude Sync: the sync folder is not available (${message}).`,
        'Choose the storage again',
        CHANGE_METHOD,
      );
      if (pick === 'Choose the storage again') {
        await cfg.update('syncFolder', '', vscode.ConfigurationTarget.Global);
        return Boolean(await folderTransport(cfg));
      }
      if (pick) await vscode.commands.executeCommand(`${SECTION}.chooseMode`);
      return false;
    }
    const pick = await vscode.window.showErrorMessage(
      `Claude Sync: no access to your git repository (${message}). Check the URL and sign in to git on this computer.`,
      'Open settings',
      CHANGE_METHOD,
    );
    if (pick === 'Open settings')
      await vscode.commands.executeCommand('workbench.action.openSettings', `${SECTION}.repoUrl`);
    else if (pick) await vscode.commands.executeCommand(`${SECTION}.chooseMode`);
    return false;
  };

  const command = (id: string, body: (s: Session) => Promise<void>, before?: () => Promise<boolean>) =>
    vscode.commands.registerCommand(`${SECTION}.${id}`, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (before && !(await before())) return;
          const s = await openSession(context, log);
          if (s) await body(s);
          return;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          log.error(message);
          if (attempt === 0 && isAccessError(message)) {
            if (await reconnect(message)) continue;
            return;
          }
          const pick = await vscode.window.showErrorMessage(`Claude Sync failed: ${message}`, 'Show log');
          if (pick) channel.show();
          return;
        }
      }
    });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.command = `${SECTION}.manage`;
  const refreshStatus = (): void => {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    const mode = cfg.get<string>('mode');
    const label = { github: 'GitHub', folder: 'Cloud folder', git: 'Git' }[isMode(mode) ? mode : 'git'];
    status.text = isMode(mode) ? `$(sync) Claude Sync: ${label}` : '$(sync) Claude Sync: not connected';
    status.tooltip = 'Change the sync method or disconnect';
    status.show();
  };
  refreshStatus();

  context.subscriptions.push(
    channel,
    status,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) refreshStatus();
    }),
    vscode.commands.registerCommand(`${SECTION}.manage`, async () => {
      const cfg = vscode.workspace.getConfiguration(SECTION);
      const connected = isMode(cfg.get<string>('mode'));
      const items = [
        { label: '$(arrow-swap) Change sync method', description: `now: ${describeMethod(cfg)}`, id: 'chooseMode' },
        ...(connected ? [{ label: '$(sign-out) Disconnect', description: 'Sign out of this method', id: 'disconnect' }] : []),
        { label: '$(output) Show log', description: '', id: 'log' },
      ];
      const pick = await vscode.window.showQuickPick(items, { title: 'Claude Sync' });
      if (!pick) return;
      if (pick.id === 'log') channel.show();
      else await vscode.commands.executeCommand(`${SECTION}.${pick.id}`);
    }),
    command(
      'push',
      async (s) => {
        report(
          'push',
          await progress('Claude Sync: pushing…', () => s.service.push()),
          s.limits,
          s.where,
          s.service.device,
        );
      },
      () => confirmFirstPush(context),
    ),
    vscode.commands.registerCommand(`${SECTION}.chooseMode`, async () => {
      const cfg = vscode.workspace.getConfiguration(SECTION);
      const mode = await chooseMode(cfg, true);
      if (!mode) return;
      // Cloud storage needs its storage picked right away, so the next Push does not ask again.
      let where = describeMethod(vscode.workspace.getConfiguration(SECTION));
      if (mode === 'folder') {
        const transport = await folderTransport(cfg);
        if (!transport) return;
        where = transport.root;
      }
      void vscode.window.showInformationMessage(`Claude Sync: now using ${where}.`);
    }),
    vscode.commands.registerCommand(`${SECTION}.disconnect`, async () => {
      const cfg = vscode.workspace.getConfiguration(SECTION);
      const mode = cfg.get<string>('mode');
      if (!isMode(mode)) {
        void vscode.window.showInformationMessage('Claude Sync: nothing is connected.');
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        `Disconnect from ${describeMethod(cfg)}? Sessions already stored there and on this device are left untouched.`,
        { modal: true },
        'Disconnect',
      );
      if (!ok) return;
      await cfg.update('mode', '', vscode.ConfigurationTarget.Global);
      await cfg.update('syncFolder', '', vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(
        mode === 'github'
          ? 'Claude Sync: disconnected. To also revoke GitHub access, sign out of GitHub in the Accounts menu.'
          : 'Claude Sync: disconnected. The next Push or Pull will ask for a method again.',
      );
    }),
    command('pull', async (s) => {
      const from = await chooseDevice(s.service, {
        includeOwn: false,
        title: 'Claude Sync: import from which device?',
      });
      if (!from) return;
      const chosen = await chooseSessionsToPull(s.service, from.name);
      if (!chosen) return;
      const result = await progress('Claude Sync: pulling…', () => s.service.pull(from.name, chosen));
      report('pull', result, s.limits, s.where, deviceLabel(from));
    }),
    command('deleteExport', async (s) => {
      const from = await chooseDevice(s.service, {
        includeOwn: true,
        title: 'Claude Sync: delete the exported sessions of which device?',
      });
      if (!from) return;
      const ok = await vscode.window.showWarningMessage(
        `Delete the ${from.sessions} session(s) of this project that «${deviceLabel(from)}» exported to ${s.where}? ` +
          'Sessions on your devices are not touched, but the stored copies cannot be restored from here.',
        { modal: true },
        'Delete',
      );
      if (!ok) return;
      const { removed } = await progress('Claude Sync: deleting…', () => s.service.removeDevice(from.name));
      void vscode.window.showInformationMessage(
        `Claude Sync: deleted ${removed} stored session(s) of «${deviceLabel(from)}».`,
      );
    }),
    command('resume', async (s) => {
      const sessions = listSessions(s.localDir);
      if (!sessions.length) {
        void vscode.window.showInformationMessage('Claude Sync: no local sessions. Run «Pull sessions» first.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        sessions.map((x) => ({
          label: x.title,
          description: new Date(x.lastActivity).toLocaleString(),
          detail: x.id,
        })),
        { placeHolder: 'Choose a session to resume', matchOnDetail: true },
      );
      if (!pick?.detail) return;
      const terminal = vscode.window.createTerminal({ name: 'Claude (resumed)', cwd: s.folder });
      terminal.show();
      terminal.sendText(`claude --resume ${pick.detail}`);
    }),
  );
}

export function deactivate(): void {}
