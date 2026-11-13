import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isValidRepoUrl, remoteOf } from './core/git';
import { defaultDeviceName, DeviceInfo } from './core/devices';
import { ensureSyncFolder, STORAGES, storageRoots } from './core/storages';
import { CLOUDS, CloudId, CloudProvider, isCloudId } from './core/cloud';
import { EncryptingTransport, EncryptionMeta, openMeta, WrongPassphraseError } from './core/encryption';
import { scanSessions } from './core/secrets';
import { classifyError, redactSecrets } from './core/errors';
import { retryingFetch } from './core/http';
import { signIn, tokenProvider } from './core/oauth';
import { MirrorTransport } from './core/remote';
import { ensurePrivateRepo, githubAuthEnv } from './core/github';
import { Limits, MB, parseLimits } from './core/limits';
import { Logger } from './core/logger';
import { claudeProjectsDir, encodeProjectDir, projectKey, sanitizeProjectKey } from './core/paths';
import { DeviceNameTakenError, SyncResult, SyncService } from './core/syncService';
import { listSessions } from './core/transcripts';
import { FolderTransport, GitTransport, Transport } from './core/transport';

const WARNED_KEY = 'pushWarningAccepted';
const INSTALL_KEY = 'installId';

/** Tells this installation from another computer that happens to have the same device name. */
const DEVICE_NAME_KEY = 'defaultDeviceName';

/**
 * The host name is remembered on first use: on a Mac it changes with the network («MacBook-Pro-2»), and a new name
 * would look like a new device with none of the sessions pushed before.
 */
function deviceNameOf(context: vscode.ExtensionContext, configured: string): string {
  if (configured) return configured;
  let name = context.globalState.get<string>(DEVICE_NAME_KEY);
  if (!name) {
    // An installation that already pushed keeps the name it pushed under, or its exports would look foreign.
    const pushedBefore = context.globalState.get<string>(INSTALL_KEY) !== undefined;
    name = pushedBefore ? os.hostname() : defaultDeviceName(os.hostname(), installIdOf(context));
    void context.globalState.update(DEVICE_NAME_KEY, name);
  }
  return name;
}

function installIdOf(context: vscode.ExtensionContext): string {
  let id = context.globalState.get<string>(INSTALL_KEY);
  if (!id) {
    id = randomUUID();
    void context.globalState.update(INSTALL_KEY, id);
  }
  return id;
}

/** Thrown by a command's body to run the whole command again (after the user changed a setting it depends on). */
class RetryCommand extends Error {}

/** Local copies the extension keeps per method, inside its own storage folder. Removed on «Disconnect». */
const CACHE_DIR: Record<Mode, string | undefined> = {
  github: 'github-repo',
  git: 'repo',
  dropbox: 'dropbox-cache',
  onedrive: 'onedrive-cache',
  folder: undefined,
};

const BUSY_STALE_MS = 10 * 60_000;
const SECTION = 'claudeSessionSync';

function channelLogger(channel: vscode.OutputChannel): Logger {
  const write = (level: string) => (m: string) => {
    channel.appendLine(`[${new Date().toISOString()}] ${level} ${redactSecrets(m)}`);
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
  /** The storage, wrapped so it can be encrypted. */
  transport: EncryptingTransport;
}

type Mode = 'github' | CloudId | 'folder' | 'git';

const METHODS: (vscode.QuickPickItem & { mode: Mode })[] = [
  {
    mode: 'github',
    label: '$(github) GitHub (automatic)',
    description: 'Sign in once; a private «claude-sessions» repository is created for you',
  },
  {
    mode: 'dropbox',
    label: '$(cloud) Dropbox (direct)',
    description: 'Sign in in the browser; no Dropbox app needed on this computer',
  },
  {
    mode: 'onedrive',
    label: '$(cloud) OneDrive (direct)',
    description: 'Sign in in the browser; no OneDrive app needed on this computer',
  },
  {
    mode: 'folder',
    label: '$(folder) Cloud folder on this computer',
    description: "iCloud Drive, Google Drive, MEGA, pCloud, Box… (the storage's own app syncs it)",
  },
  {
    mode: 'git',
    label: '$(repo) My own git repository',
    description: 'Any private repository you set up yourself (https or ssh)',
  },
];

const CHANGE_METHOD = 'Change method';
const RESUME = 'Resume a session';
const RELOAD = 'Reload window';

/** Errors that mean «cannot reach or not signed in», as opposed to a bug. */
const isAccessError = (m: string): boolean => classifyError(m) === 'access';

/** Step text for the notification that is open right now («Downloading 3/12: …»). */
let currentStep: ((message: string) => void) | undefined;
const step = (message: string): void => {
  currentStep?.(message);
};

let statusItem: vscode.StatusBarItem | undefined;
/** What the last push or pull did, kept in the status bar so the result stays visible after the toast is gone. */
let lastResult = '';

const STATUS_LABEL_BY_MODE: Record<Mode, string> = {
  github: 'GitHub',
  dropbox: 'Dropbox',
  onedrive: 'OneDrive',
  folder: 'Cloud folder',
  git: 'Git',
};

function renderStatus(): void {
  if (!statusItem) return;
  const mode = vscode.workspace.getConfiguration(SECTION).get<string>('mode');
  statusItem.text = isMode(mode)
    ? `$(sync) Claude Sync: ${STATUS_LABEL_BY_MODE[mode]}${lastResult ? ` · ${lastResult}` : ''}`
    : '$(sync) Claude Sync: not connected';
  statusItem.tooltip = 'Change the sync method or disconnect';
  statusItem.show();
}

const isMode = (v: unknown): v is Mode => v === 'github' || isCloudId(v) || v === 'folder' || v === 'git';

/** The saved method, or a one-time question on first use. `forceAsk` is «Choose sync method». */
async function chooseMode(
  cfg: vscode.WorkspaceConfiguration,
  forceAsk: boolean,
  intent?: 'push' | 'pull',
): Promise<Mode | undefined> {
  const saved = cfg.get<string>('mode');
  if (!forceAsk && isMode(saved)) return saved;
  const title = {
    push: 'Claude Sync: where should your sessions go? (pick the method you will also use on your other device)',
    pull: 'Claude Sync: where are the sessions from your other device? (pick the method it pushed with)',
    none: 'Claude Sync: how should sessions travel between your devices?',
  }[intent ?? 'none'];
  const pick = await vscode.window.showQuickPick(METHODS, {
    title,
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
  if (isCloudId(mode)) return CLOUDS[mode].where;
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
  return new GitTransport(
    path.join(context.globalStorageUri.fsPath, 'github-repo'),
    cloneUrl,
    async () => githubAuthEnv(await token()),
    step,
  );
}

const tokenKey = (c: CloudProvider): string => `${c.id}.refreshToken`;

/** Direct access to a cloud service's API: sign in in the browser once, then keep the refresh token in the secret store. */
let secretsWarned = false;

async function saveToken(context: vscode.ExtensionContext, cloud: CloudProvider, token: string): Promise<void> {
  try {
    await context.secrets.store(tokenKey(cloud), token);
  } catch {
    // No keyring (some Linux setups): the sign-in works for now, but cannot be remembered.
    if (secretsWarned) return;
    secretsWarned = true;
    void vscode.window.showWarningMessage(
      'Claude Sync: VS Code cannot store the sign-in on this computer (no keyring), so you will have to sign in again next time. GitHub or a git repository do not have this limit.',
    );
  }
}

async function cloudTransport(context: vscode.ExtensionContext, cloud: CloudProvider): Promise<Transport | undefined> {
  const http = retryingFetch(fetch);
  let refresh = await context.secrets.get(tokenKey(cloud)).then(
    (t) => t,
    () => undefined,
  );
  if (!refresh && vscode.env.remoteName) {
    const pick = await vscode.window.showWarningMessage(
      `Claude Sync: this window runs remotely (${vscode.env.remoteName}), so the ${cloud.label} browser sign-in may not reach it. GitHub or a git repository work everywhere.`,
      'Try anyway',
      CHANGE_METHOD,
    );
    if (pick === CHANGE_METHOD) await vscode.commands.executeCommand(`${SECTION}.chooseMode`);
    if (pick !== 'Try anyway') return undefined;
  }
  if (!refresh) {
    const tokens = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Claude Sync: finish signing in to ${cloud.label} in your browser…`,
        cancellable: true,
      },
      (_p, cancel) => {
        const ctl = new AbortController();
        cancel.onCancellationRequested(() => {
          ctl.abort();
        });
        return signIn(
          http,
          cloud.oauth,
          (url) => {
            void vscode.env.openExternal(vscode.Uri.parse(url));
          },
          { signal: ctl.signal },
        ).catch((e: unknown) => {
          void vscode.window.showErrorMessage(`Claude Sync: ${e instanceof Error ? e.message : String(e)}`);
          return undefined;
        });
      },
    );
    if (!tokens) return undefined;
    refresh = tokens.refreshToken;
    await saveToken(context, cloud, refresh);
  }
  const token = tokenProvider(http, cloud.oauth, refresh, async (t) => {
    await saveToken(context, cloud, t);
  });
  return new MirrorTransport(
    path.join(context.globalStorageUri.fsPath, `${cloud.id}-cache`),
    cloud.store(http, token),
    step,
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
async function folderTransport(): Promise<Transport | undefined> {
  // Read the setting afresh: a WorkspaceConfiguration is a snapshot, and callers may have just cleared the folder.
  const cfg = vscode.workspace.getConfiguration(SECTION);
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
  return new GitTransport(path.join(context.globalStorageUri.fsPath, 'repo'), repoUrl, undefined, step);
}

async function openSession(
  context: vscode.ExtensionContext,
  log: Logger,
  intent?: 'push' | 'pull',
): Promise<Session | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) {
    void vscode.window.showErrorMessage('Claude Sync: open a folder first.');
    return;
  }
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const mode = await chooseMode(cfg, false, intent);
  if (!mode) return;
  const inner = await {
    github: () => githubTransport(context),
    dropbox: () => cloudTransport(context, CLOUDS.dropbox),
    onedrive: () => cloudTransport(context, CLOUDS.onedrive),
    folder: () => folderTransport(),
    git: () => gitTransport(context, cfg),
  }[mode]();
  if (!inner) return;
  const transport = new EncryptingTransport(
    inner,
    path.join(context.globalStorageUri.fsPath, `${mode}-plain`),
    (meta) => askPassphrase(context, meta),
  );
  const localDir = path.join(claudeProjectsDir(cfg.get<string>('claudeDir', '')), encodeProjectDir(folder));
  const key = sanitizeProjectKey(cfg.get<string>('projectKey', '')) || projectKey(await remoteOf(folder), folder);
  const limits = parseLimits({
    maxFileSizeMB: cfg.get('maxFileSizeMB'),
    maxSessionAgeDays: cfg.get('maxSessionAgeDays'),
  });
  const deviceName = deviceNameOf(context, cfg.get<string>('deviceName', '').trim());
  const service = new SyncService(
    { transport, localDir, projectKey: key, deviceName, limits, installId: installIdOf(context) },
    log,
  );
  return {
    service,
    localDir,
    folder,
    limits,
    transport,
    where: describeMethod(vscode.workspace.getConfiguration(SECTION)),
  };
}

/** Before a push: sessions that look like they hold API keys or tokens are shown, and the user decides. */
async function reviewSecrets(localDir: string, pending: readonly string[]): Promise<ReadonlySet<string> | 'cancel'> {
  const hits = scanSessions(localDir, pending);
  if (!hits.size) return new Set();
  const titles = new Map(listSessions(localDir).map((x) => [`${x.id}.jsonl`, x.title]));
  const lines = [...hits].map(([name, kinds]) => `• ${titles.get(name) ?? name}: ${kinds.join(', ')}`);
  const LEAVE_OUT = `Push without ${hits.size === 1 ? 'it' : 'them'}`;
  const ANYWAY = 'Push anyway';
  const pick = await vscode.window.showWarningMessage(
    `${hits.size} session(s) look like they contain credentials.`,
    {
      modal: true,
      detail: `${lines.slice(0, 10).join('\n')}${lines.length > 10 ? `\n…and ${lines.length - 10} more` : ''}\n\nRevoke any key that has already left this computer. Checking can be turned off with claudeSessionSync.scanSecrets.`,
    },
    LEAVE_OUT,
    ANYWAY,
  );
  if (pick === ANYWAY) return new Set();
  if (pick === LEAVE_OUT) return new Set(hits.keys());
  return 'cancel';
}

/** The passphrase is kept per storage (by its salt) in VS Code's secret store, so it is asked once per device. */
const passphraseKey = (meta: EncryptionMeta): string => `encryption.${meta.salt}`;

async function askPassphrase(context: vscode.ExtensionContext, meta: EncryptionMeta): Promise<Buffer | undefined> {
  const saved = await context.secrets.get(passphraseKey(meta)).then(
    (p) => p,
    () => undefined,
  );
  if (saved) {
    try {
      return openMeta(meta, saved);
    } catch {
      await context.secrets.delete(passphraseKey(meta)); // changed on another device: ask again
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const entered = await vscode.window.showInputBox({
      title: 'Claude Sync: the storage is encrypted',
      prompt: attempt
        ? 'That passphrase does not open this storage. Try again.'
        : 'Enter the encryption passphrase you chose on your other device.',
      password: true,
      ignoreFocusOut: true,
    });
    if (!entered) return undefined;
    try {
      const key = openMeta(meta, entered);
      await context.secrets.store(passphraseKey(meta), entered).then(undefined, () => undefined);
      return key;
    } catch (e) {
      if (!(e instanceof WrongPassphraseError)) throw e;
    }
  }
  throw new WrongPassphraseError();
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
  const nothing = r.pushed === false;
  lastResult = `${nothing ? `nothing new to ${verb}` : `${verb}ed ${r.copied.length}`} · ${new Date().toLocaleTimeString()}`;
  renderStatus();
  const canResume = verb === 'pull' && r.copied.length > 0;
  const buttons = [...(canResume ? [RESUME, RELOAD] : []), 'Manage connection'];
  void vscode.window
    .showInformationMessage(
      nothing
        ? `Claude Sync: nothing new to ${verb} ${via}.${older}`
        : `Claude Sync: ${verb}ed ${r.copied.length} session(s) ${via}.${older}` +
            (canResume ? ' If they are not in the Claude Code session list yet, reload the window.' : ''),
      ...buttons,
    )
    .then((pick) => {
      if (pick === RESUME) return vscode.commands.executeCommand(`${SECTION}.resume`);
      if (pick === RELOAD) return vscode.commands.executeCommand('workbench.action.reloadWindow');
      return pick ? vscode.commands.executeCommand(`${SECTION}.manage`) : undefined;
    });
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
  opts: { includeOwn: boolean; title: string; where: string },
): Promise<DeviceInfo | undefined> {
  const all = await progress('Claude Sync: looking at the storage…', () => service.devices());
  const devices = all.filter((d) => opts.includeOwn || d.name !== service.device);
  if (!devices.length) {
    void vscode.window
      .showWarningMessage(
        opts.includeOwn
          ? `Claude Sync: nothing has been exported for this project to ${opts.where} yet.`
          : `Claude Sync: no other device has exported this project to ${opts.where}. ` +
              'On the other device run «Push sessions» first, with the same method and the same project (git remote) as here.',
        CHANGE_METHOD,
        'Show log',
      )
      .then((pick) => {
        if (pick === CHANGE_METHOD) return vscode.commands.executeCommand(`${SECTION}.chooseMode`);
        if (pick) return vscode.commands.executeCommand(`${SECTION}.showLog`);
        return undefined;
      });
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
  vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async (p) => {
    currentStep = (message) => {
      p.report({ message });
    };
    try {
      return await task();
    } finally {
      currentStep = undefined;
    }
  });

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
        return Boolean(await folderTransport());
      }
      if (pick) await vscode.commands.executeCommand(`${SECTION}.chooseMode`);
      return false;
    }
    if (isCloudId(mode)) {
      const cloud = CLOUDS[mode];
      const pick = await vscode.window.showErrorMessage(
        `Claude Sync: ${cloud.label} did not accept the sign-in (${message}).`,
        'Sign in again',
        CHANGE_METHOD,
      );
      if (pick === 'Sign in again') {
        await context.secrets.delete(tokenKey(cloud));
        return true;
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

  /** Two operations at once would use the same local cache. A stale lock (an unanswered dialog) expires. */
  let busySince = 0;
  /** Changing or dropping the method while a push or pull uses its cache would corrupt that cache. */
  const refuseWhileBusy = (): boolean => {
    if (!busySince || Date.now() - busySince >= BUSY_STALE_MS) return false;
    void vscode.window.showInformationMessage('Claude Sync: another Claude Sync operation is still running.');
    return true;
  };

  const advise = async (kind: 'network' | 'full'): Promise<boolean> => {
    const pick = await vscode.window.showErrorMessage(
      kind === 'network'
        ? 'Claude Sync: cannot reach the storage. Check your internet connection and try again.'
        : 'Claude Sync: the storage is full. Free some space there (or choose another method) and try again.',
      'Try again',
      CHANGE_METHOD,
      'Show log',
    );
    if (pick === CHANGE_METHOD) await vscode.commands.executeCommand(`${SECTION}.chooseMode`);
    if (pick === 'Show log') channel.show();
    return pick === 'Try again';
  };

  const command = (id: string, body: (s: Session) => Promise<void>, before?: () => Promise<boolean>) =>
    vscode.commands.registerCommand(`${SECTION}.${id}`, async () => {
      if (refuseWhileBusy()) return;
      busySince = Date.now();
      try {
        let reconnected = false;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            if (before && !(await before())) return;
            const s = await openSession(context, log, id === 'push' || id === 'pull' ? id : undefined);
            if (s) await body(s);
            return;
          } catch (e) {
            if (e instanceof RetryCommand) continue;
            const message = redactSecrets(e instanceof Error ? e.message : String(e));
            log.error(message);
            if (!reconnected && isAccessError(message)) {
              reconnected = true;
              if (await reconnect(message)) continue;
              return;
            }
            const kind = classifyError(message);
            if (kind === 'network' || kind === 'full') {
              if (await advise(kind)) continue;
              return;
            }
            const pick = await vscode.window.showErrorMessage(`Claude Sync failed: ${message}`, 'Show log');
            if (pick) channel.show();
            return;
          }
        }
      } finally {
        busySince = 0;
      }
    });

  /** Two computers with one device name: let the user rename this one, or confirm it is the same computer. */
  const resolveNameClash = async (device: string): Promise<'takeOver' | undefined> => {
    const newName = `${device}-${installIdOf(context).slice(0, 4)}`.slice(0, 64);
    const RENAME = `Use «${newName}» on this computer`;
    const SAME = 'This is the same computer';
    const pick = await vscode.window.showWarningMessage(
      `Another computer already pushes as «${device}». Two computers must not share a device name, or their sessions would be mixed up.`,
      {
        modal: true,
        detail: 'Choose «Same computer» only if you reinstalled VS Code on the computer that used this name.',
      },
      RENAME,
      SAME,
    );
    if (pick === RENAME) {
      await vscode.workspace.getConfiguration(SECTION).update('deviceName', newName, vscode.ConfigurationTarget.Global);
      throw new RetryCommand();
    }
    return pick === SAME ? 'takeOver' : undefined;
  };

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.command = `${SECTION}.manage`;
  statusItem = status;
  const refreshStatus = (): void => {
    lastResult = '';
    renderStatus();
  };
  renderStatus();

  context.subscriptions.push(
    channel,
    status,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) refreshStatus();
    }),
    vscode.commands.registerCommand(`${SECTION}.showLog`, () => {
      channel.show();
    }),
    vscode.commands.registerCommand(`${SECTION}.manage`, async () => {
      const cfg = vscode.workspace.getConfiguration(SECTION);
      const connected = isMode(cfg.get<string>('mode'));
      const items = [
        { label: '$(arrow-swap) Change sync method', description: `now: ${describeMethod(cfg)}`, id: 'chooseMode' },
        ...(connected
          ? [
              {
                label: '$(lock) Turn on encryption',
                description: 'Encrypt the stored sessions with a passphrase',
                id: 'enableEncryption',
              },
              { label: '$(sign-out) Disconnect', description: 'Sign out of this method', id: 'disconnect' },
            ]
          : []),
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
        if (!listSessions(s.localDir).length) {
          void vscode.window.showInformationMessage(
            `Claude Sync: there are no Claude Code sessions for this project on this computer yet (looked in ${s.localDir}). Start a session in Claude Code first.`,
          );
          return;
        }
        const review = vscode.workspace.getConfiguration(SECTION).get<boolean>('scanSecrets', true)
          ? (pending: readonly string[]) => reviewSecrets(s.localDir, pending)
          : undefined;
        const run = (takeOver: boolean) =>
          progress('Claude Sync: pushing…', () => s.service.push({ takeOver, review }));
        let result: SyncResult;
        try {
          result = await run(false);
        } catch (e) {
          if (!(e instanceof DeviceNameTakenError)) throw e;
          if ((await resolveNameClash(e.device)) !== 'takeOver') return;
          result = await run(true);
        }
        if (result.cancelled) return;
        report('push', result, s.limits, s.where, s.service.device);
      },
      () => confirmFirstPush(context),
    ),
    vscode.commands.registerCommand(`${SECTION}.chooseMode`, async () => {
      if (refuseWhileBusy()) return;
      const cfg = vscode.workspace.getConfiguration(SECTION);
      const previous = { mode: cfg.get<string>('mode', ''), syncFolder: cfg.get<string>('syncFolder', '') };
      // A sign-in or storage pick that was cancelled must not leave the old, working method forgotten.
      const restore = async () => {
        await cfg.update('mode', previous.mode, vscode.ConfigurationTarget.Global);
        await cfg.update('syncFolder', previous.syncFolder, vscode.ConfigurationTarget.Global);
      };
      const mode = await chooseMode(cfg, true);
      if (!mode) return;
      // Cloud storage needs its storage picked right away, so the next Push does not ask again.
      let where = describeMethod(vscode.workspace.getConfiguration(SECTION));
      try {
        if (isCloudId(mode)) {
          if (!(await cloudTransport(context, CLOUDS[mode]))) {
            await restore();
            return;
          }
        } else if (mode === 'folder') {
          const transport = await folderTransport();
          if (!transport) {
            await restore();
            return;
          }
          where = transport.root;
        }
      } catch (e) {
        await restore();
        throw e;
      }
      void vscode.window.showInformationMessage(`Claude Sync: now using ${where}.`);
    }),
    vscode.commands.registerCommand(`${SECTION}.disconnect`, async () => {
      if (refuseWhileBusy()) return;
      const cfg = vscode.workspace.getConfiguration(SECTION);
      const mode = cfg.get<string>('mode');
      if (!isMode(mode)) {
        void vscode.window.showInformationMessage('Claude Sync: nothing is connected.');
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        `Disconnect from ${describeMethod(cfg)}? Sessions already stored there and on this device are left untouched. The copy the extension keeps for syncing is removed.`,
        { modal: true },
        'Disconnect',
      );
      if (!ok) return;
      await cfg.update('mode', '', vscode.ConfigurationTarget.Global);
      await cfg.update('syncFolder', '', vscode.ConfigurationTarget.Global);
      for (const cloud of Object.values(CLOUDS)) await context.secrets.delete(tokenKey(cloud));
      const cache = CACHE_DIR[mode];
      if (cache) fs.rmSync(path.join(context.globalStorageUri.fsPath, cache), { recursive: true, force: true });
      // The decrypted copy of an encrypted storage.
      fs.rmSync(path.join(context.globalStorageUri.fsPath, `${mode}-plain`), { recursive: true, force: true });
      void vscode.window.showInformationMessage(
        mode === 'github'
          ? 'Claude Sync: disconnected. To also revoke GitHub access, sign out of GitHub in the Accounts menu.'
          : 'Claude Sync: disconnected. The next Push or Pull will ask for a method again.',
      );
    }),
    command('enableEncryption', async (s) => {
      await progress('Claude Sync: looking at the storage…', () => s.transport.refresh());
      if (s.transport.encrypted) {
        void vscode.window.showInformationMessage(`Claude Sync: ${s.where} is already encrypted.`);
        return;
      }
      const REMOVE = 'Turn on and remove unencrypted copies';
      const KEEP = 'Turn on, keep them';
      const how = await vscode.window.showWarningMessage(
        `Encrypt the sessions in ${s.where} with a passphrase?`,
        {
          modal: true,
          detail:
            'Only devices that know the passphrase can read them; the storage sees nothing but encrypted files. ' +
            'You will type the same passphrase once on every other device. If it is lost, the stored sessions cannot ' +
            'be recovered (the ones on your devices are not affected).\n\n' +
            'Sessions already in the storage are not encrypted. Remove them now and each device pushes its sessions ' +
            'again, encrypted. Devices with an older version of the extension will not see encrypted sessions.',
        },
        REMOVE,
        KEEP,
      );
      if (!how) return;
      const passphrase = await vscode.window.showInputBox({
        title: 'Claude Sync: choose an encryption passphrase',
        prompt: 'At least 12 characters. Several unrelated words are easy to type and hard to guess.',
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (v.length < 12 ? 'At least 12 characters.' : undefined),
      });
      if (!passphrase) return;
      const again = await vscode.window.showInputBox({
        title: 'Claude Sync: type the passphrase again',
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (v && v !== passphrase ? 'Does not match.' : undefined),
      });
      if (again !== passphrase) return;
      const meta = await progress('Claude Sync: turning on encryption…', () =>
        s.transport.enable(passphrase, { removePlain: how === REMOVE }),
      );
      if (!meta) {
        void vscode.window.showInformationMessage('Claude Sync: another device has just turned encryption on.');
        return;
      }
      await context.secrets.store(passphraseKey(meta), passphrase).then(undefined, () => undefined);
      const pick = await vscode.window.showInformationMessage(
        'Claude Sync: encryption is on. Push now so this device stores its sessions encrypted; on your other devices, Pull and enter the passphrase.',
        'Push now',
      );
      // After this command has released the one-operation-at-a-time lock.
      if (pick)
        setTimeout(() => {
          void vscode.commands.executeCommand(`${SECTION}.push`);
        }, 0);
    }),
    command('pull', async (s) => {
      const from = await chooseDevice(s.service, {
        includeOwn: false,
        where: s.where,
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
        where: s.where,
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
    // Resuming only reads local files: no storage, network or sign-in needed.
    vscode.commands.registerCommand(`${SECTION}.resume`, async () => {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!folder) {
        void vscode.window.showErrorMessage('Claude Sync: open a folder first.');
        return;
      }
      const claudeDir = vscode.workspace.getConfiguration(SECTION).get<string>('claudeDir', '').trim();
      const sessions = listSessions(path.join(claudeProjectsDir(claudeDir), encodeProjectDir(folder)));
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
      const terminal = vscode.window.createTerminal({
        name: 'Claude (resumed)',
        cwd: folder,
        // A custom Claude folder must reach Claude Code too, or it would look for the session in ~/.claude.
        env: claudeDir ? { CLAUDE_CONFIG_DIR: claudeDir } : undefined,
      });
      terminal.show();
      terminal.sendText(`claude --resume ${pick.detail}`);
    }),
  );
}

export function deactivate(): void {}
