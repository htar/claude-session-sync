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
import { GzipStore } from './core/gzipStore';
import { MirrorTransport } from './core/remote';
import { ensurePrivateRepo, githubAuthEnv, isPublicGithubRepo, PublicRepoError } from './core/github';
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

/** The user pressed Cancel on a progress notification. */
class OperationCancelled extends Error {}

/** Cancels the network requests of the operation that is running now (set by `progress`). */
let activeAbort: AbortController | undefined;

/** `fetch` that stops when the running operation is cancelled. */
const cancellableFetch: typeof fetch = (input, init) =>
  fetch(input, activeAbort ? { ...init, signal: init?.signal ?? activeAbort.signal } : init);

/** Local copies the extension keeps per method, inside its own storage folder. Removed on «Disconnect». */
const CACHE_DIR: Record<Mode, string | undefined> = {
  github: 'github-repo',
  git: 'repo',
  dropbox: 'dropbox-cache',
  onedrive: 'onedrive-cache',
  googledrive: 'googledrive-cache',
  folder: undefined,
};

const BUSY_STALE_MS = 10 * 60_000;
const SECTION = 'claudeSessionSync';
const t = vscode.l10n.t;

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
    description: t('Sign in once; a private «claude-sessions» repository is created for you'),
  },
  {
    mode: 'dropbox',
    label: '$(cloud) Dropbox (direct)',
    description: t('Sign in in the browser; no Dropbox app needed on this computer'),
  },
  {
    mode: 'onedrive',
    label: '$(cloud) OneDrive (direct)',
    description: t('Sign in in the browser; no OneDrive app needed on this computer'),
  },
  {
    mode: 'googledrive',
    label: '$(cloud) Google Drive (direct)',
    description: t('Sign in in the browser; files live in a hidden app folder of your Drive'),
  },
  {
    mode: 'folder',
    label: t('$(folder) Cloud folder on this computer'),
    description: t("iCloud Drive, Google Drive, MEGA, pCloud, Box… (the storage's own app syncs it)"),
  },
  {
    mode: 'git',
    label: t('$(repo) My own git repository'),
    description: t('Any private repository you set up yourself (https or ssh)'),
  },
];

const CHANGE_METHOD = t('Change method');
const RESUME = t('Resume a session');
const RELOAD = t('Reload window');
const SHOW_LOG = t('Show log');
const OPEN_SETTINGS = t('Open settings');
const CHOOSE_AGAIN = t('Choose the storage again');
const SIGN_IN_AGAIN = t('Sign in again');
const SIGN_IN_GITHUB = t('Sign in to GitHub');
const TRY_AGAIN = t('Try again');

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
  googledrive: 'Google Drive',
  folder: t('Cloud folder'),
  git: 'Git',
};

function renderStatus(): void {
  if (!statusItem) return;
  const mode = vscode.workspace.getConfiguration(SECTION).get<string>('mode');
  statusItem.text = isMode(mode)
    ? `$(sync) Claude Sync: ${STATUS_LABEL_BY_MODE[mode]}${lastResult ? ` · ${lastResult}` : ''}`
    : t('$(sync) Claude Sync: not connected');
  statusItem.tooltip = t('Change the sync method or disconnect');
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
    push: t('Claude Sync: where should your sessions go? (pick the method you will also use on your other device)'),
    pull: t('Claude Sync: where are the sessions from your other device? (pick the method it pushed with)'),
    none: t('Claude Sync: how should sessions travel between your devices?'),
  }[intent ?? 'none'];
  // A method whose app is not registered yet (empty public id) is not offered.
  const offered = METHODS.filter((m) => !isCloudId(m.mode) || CLOUDS[m.mode].available);
  const pick = await vscode.window.showQuickPick(offered, {
    title,
    placeHolder: t('You can change this later with «Claude Sync: Choose sync method»'),
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
  if (mode === 'github') return t('GitHub (private claude-sessions repository)');
  if (isCloudId(mode)) return CLOUDS[mode].where;
  if (mode === 'folder') return cfg.get<string>('syncFolder', '') || t('a cloud folder');
  if (mode === 'git') return cfg.get<string>('repoUrl', '') || t('your git repository');
  return t('nowhere yet');
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

const TRY_ANYWAY = t('Try anyway');
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
      t(
        'Claude Sync: VS Code cannot store the sign-in on this computer (no keyring), so you will have to sign in again next time. GitHub or a git repository do not have this limit.',
      ),
    );
  }
}

async function cloudTransport(context: vscode.ExtensionContext, cloud: CloudProvider): Promise<Transport | undefined> {
  const http = retryingFetch(cancellableFetch);
  let refresh = await context.secrets.get(tokenKey(cloud)).then(
    (t) => t,
    () => undefined,
  );
  if (!refresh && vscode.env.remoteName) {
    const pick = await vscode.window.showWarningMessage(
      t(
        'Claude Sync: this window runs remotely ({0}), so the {1} browser sign-in may not reach it. GitHub or a git repository work everywhere.',
        vscode.env.remoteName,
        cloud.label,
      ),
      TRY_ANYWAY,
      CHANGE_METHOD,
    );
    if (pick === CHANGE_METHOD) await vscode.commands.executeCommand(`${SECTION}.chooseMode`);
    if (pick !== TRY_ANYWAY) return undefined;
  }
  if (!refresh) {
    const tokens = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('Claude Sync: finish signing in to {0} in your browser…', cloud.label),
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
          void vscode.window.showErrorMessage(t('Claude Sync: {0}', e instanceof Error ? e.message : String(e)));
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
    new GzipStore(cloud.store(http, token)),
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
    openLabel: t('Use this folder'),
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
    const OTHER = t('Another folder…');
    const choice = await vscode.window.showQuickPick([...STORAGES.map((s) => s.label), OTHER], {
      title: t('Claude Sync: which cloud storage do you use?'),
      placeHolder: t('A «Claude Sessions» folder will be created at its root'),
    });
    if (!choice) return undefined;
    const storage = STORAGES.find((s) => s.label === choice);
    const found = storage
      ? storageRoots(storage, { home: os.homedir(), platform: process.platform, env: process.env })
      : [];
    let root = found.length === 1 ? found[0] : undefined;
    if (found.length > 1)
      root = (await vscode.window.showQuickPick(found, { title: t('Which {0} account?', choice) })) ?? undefined;
    else if (!found.length) {
      if (storage)
        void vscode.window.showInformationMessage(
          t('Claude Sync: {0} was not found in its usual place. Pick its folder.', choice),
        );
      root = await pickFolderByHand(
        storage ? t('Pick the {0} folder on this computer', choice) : t('Pick the synced folder on this computer'),
      );
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
      t(
        'Claude Sync: set a valid claudeSessionSync.repoUrl (https, ssh or git@host:owner/repo of a PRIVATE repository).',
      ),
      OPEN_SETTINGS,
    );
    if (pick) await vscode.commands.executeCommand('workbench.action.openSettings', `${SECTION}.repoUrl`);
    return undefined;
  }
  if (await isPublicGithubRepo(repoUrl))
    throw new PublicRepoError(
      t(
        '{0} is a PUBLIC repository: your sessions (code, command output, maybe secrets) would be visible to everyone. Make it private on GitHub, or use another repository.',
        repoUrl,
      ),
    );
  return new GitTransport(path.join(context.globalStorageUri.fsPath, 'repo'), repoUrl, undefined, step);
}

async function openSession(
  context: vscode.ExtensionContext,
  log: Logger,
  intent?: 'push' | 'pull',
): Promise<Session | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) {
    void vscode.window.showErrorMessage(t('Claude Sync: open a folder first.'));
    return;
  }
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const mode = await chooseMode(cfg, false, intent);
  if (!mode) return;
  const inner = await {
    github: () => githubTransport(context),
    dropbox: () => cloudTransport(context, CLOUDS.dropbox),
    onedrive: () => cloudTransport(context, CLOUDS.onedrive),
    googledrive: () => cloudTransport(context, CLOUDS.googledrive),
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
  const hits = await scanSessions(localDir, pending);
  if (!hits.size) return new Set();
  const titles = new Map(listSessions(localDir).map((x) => [`${x.id}.jsonl`, x.title]));
  const lines = [...hits].map(([name, kinds]) => `• ${titles.get(name) ?? name}: ${kinds.join(', ')}`);
  const LEAVE_OUT = hits.size === 1 ? t('Push without it') : t('Push without them');
  const ANYWAY = t('Push anyway');
  const pick = await vscode.window.showWarningMessage(
    t('{0} session(s) look like they contain credentials.', hits.size),
    {
      modal: true,
      detail: `${lines.slice(0, 10).join('\n')}${lines.length > 10 ? `\n${t('…and {0} more', lines.length - 10)}` : ''}\n\n${t('Revoke any key that has already left this computer. Checking can be turned off with claudeSessionSync.scanSecrets.')}`,
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
      title: t('Claude Sync: the storage is encrypted'),
      prompt: attempt
        ? t('That passphrase does not open this storage. Try again.')
        : t('Enter the encryption passphrase you chose on your other device.'),
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
    t(
      'Session transcripts contain your code, command output and possibly secrets. Send them only to a PRIVATE place you control (a private repository or your own cloud folder).',
    ),
    { modal: true },
    t('I understand, push'),
  );
  if (ok) await context.globalState.update(WARNED_KEY, true);
  return Boolean(ok);
}

function report(verb: 'push' | 'pull', r: SyncResult, limits: Limits, where: string, device: string): void {
  const older = r.tooOld > 0 ? ` ${t('{0} older than {1} days left out.', r.tooOld, limits.maxAgeDays)}` : '';
  const push = verb === 'push';
  const nothing = r.pushed === false;
  const done = push
    ? t('{0} session(s) pushed to {1} as «{2}».', r.copied.length, where, device)
    : t('{0} session(s) pulled from «{1}» in {2}.', r.copied.length, device, where);
  const none = push
    ? t('Nothing new to push to {0} as «{1}».', where, device)
    : t('Nothing new to pull from «{0}» in {1}.', device, where);
  lastResult = `${nothing ? (push ? t('nothing new to push') : t('nothing new to pull')) : push ? t('pushed {0}', r.copied.length) : t('pulled {0}', r.copied.length)} · ${new Date().toLocaleTimeString()}`;
  renderStatus();
  const canResume = verb === 'pull' && r.copied.length > 0;
  const MANAGE = t('Manage connection');
  const buttons = [...(canResume ? [RESUME, RELOAD] : []), MANAGE];
  void vscode.window
    .showInformationMessage(
      `Claude Sync: ${nothing ? none : done}${older}` +
        (canResume && !nothing
          ? ` ${t('If they are not in the Claude Code session list yet, reload the window.')}`
          : ''),
      ...buttons,
    )
    .then((pick) => {
      if (pick === RESUME) return vscode.commands.executeCommand(`${SECTION}.resume`);
      if (pick === RELOAD) return vscode.commands.executeCommand('workbench.action.reloadWindow');
      return pick ? vscode.commands.executeCommand(`${SECTION}.manage`) : undefined;
    });
  if (r.tooLarge.length) {
    void vscode.window.showWarningMessage(
      t(
        'Claude Sync: {0} session(s) are over {1} MB and were NOT pushed: {2}',
        r.tooLarge.length,
        Math.round(limits.maxFileBytes / MB),
        r.tooLarge.join(', '),
      ),
    );
  }
  if (r.failed?.length) {
    void vscode.window
      .showWarningMessage(
        t(
          'Claude Sync: {0} session(s) could not be read or written and were skipped (the rest went through): {1}. See the log.',
          r.failed.length,
          r.failed.join(', '),
        ),
        SHOW_LOG,
      )
      .then((pick) => (pick ? vscode.commands.executeCommand(`${SECTION}.showLog`) : undefined));
  }
  if (r.notDownloaded) {
    void vscode.window.showWarningMessage(
      t(
        'Claude Sync: {0} session(s) are still in iCloud and not downloaded to this Mac yet. Open the folder in Finder (right-click → Download Now), then pull again.',
        r.notDownloaded,
      ),
    );
  }
  if (r.conflicts.length) {
    void vscode.window.showWarningMessage(
      t(
        'Claude Sync: {0} session(s) were continued on two devices and were NOT overwritten: {1}',
        r.conflicts.length,
        r.conflicts.join(', '),
      ),
    );
  }
}

const mb = (bytes: number) =>
  bytes < MB ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / MB).toFixed(1)} MB`;

const deviceLabel = (d: DeviceInfo): string => (d.legacy ? t('Shared (before 0.5.0)') : d.name);

/** Which device's export to work with. Skips the question when there is only one candidate. */
async function chooseDevice(
  service: SyncService,
  opts: { includeOwn: boolean; title: string; where: string; lastUsed?: string },
): Promise<DeviceInfo | undefined> {
  const all = await progress(t('Claude Sync: looking at the storage…'), () => service.devices());
  const devices = all.filter((d) => opts.includeOwn || d.name !== service.device);
  if (!devices.length) {
    void vscode.window
      .showWarningMessage(
        opts.includeOwn
          ? t('Claude Sync: nothing has been exported for this project to {0} yet.', opts.where)
          : t(
              'Claude Sync: no other device has exported this project to {0}. On the other device run «Push sessions» first, with the same method and the same project (git remote) as here.',
              opts.where,
            ),
        CHANGE_METHOD,
        SHOW_LOG,
      )
      .then((pick) => {
        if (pick === CHANGE_METHOD) return vscode.commands.executeCommand(`${SECTION}.chooseMode`);
        if (pick) return vscode.commands.executeCommand(`${SECTION}.showLog`);
        return undefined;
      });
    return undefined;
  }
  if (devices.length === 1 && !opts.includeOwn) return devices[0];
  // The device used last time comes first, so the usual choice is one Enter away.
  devices.sort((a, b) => Number(b.name === opts.lastUsed) - Number(a.name === opts.lastUsed));
  const pick = await vscode.window.showQuickPick(
    devices.map((d) => ({
      label:
        deviceLabel(d) +
        (d.name === service.device ? ` ${t('(this device)')}` : '') +
        (d.name === opts.lastUsed ? ` ${t('(last used)')}` : ''),
      description: t('{0} session(s)', d.sessions),
      device: d,
    })),
    { title: opts.title, placeHolder: t('Choose a device') },
  );
  return pick?.device;
}

const STATUS_LABEL: Record<string, string> = {
  new: t('new on this device'),
  updated: t('newer than your copy'),
  conflict: t('differs from your copy'),
};

/** Lets the user tick the sessions to bring over. Returns their ids, or undefined when cancelled or nothing is left to pull. */
async function chooseSessionsToPull(service: SyncService, from: string): Promise<string[] | undefined> {
  const sessions = (await progress(t('Claude Sync: looking at the storage…'), () => service.available(from))).filter(
    (x) => x.status !== 'same',
  );
  if (!sessions.length) {
    void vscode.window.showInformationMessage(t('Claude Sync: everything in the storage is already on this device.'));
    return undefined;
  }
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { id: string }>();
  qp.canSelectMany = true;
  qp.matchOnDetail = true;
  qp.title = t('Claude Sync: which sessions to pull? ({0} available)', sessions.length);
  qp.placeholder = t('Tick the sessions you want on this device, then press Enter');
  qp.items = sessions.map((x) => ({
    id: x.id,
    label: x.title,
    description: `${new Date(x.lastActivity).toLocaleString()} · ${mb(x.bytes)} · ${STATUS_LABEL[x.status] ?? x.status}`,
    detail: x.id,
  }));
  const all = { iconPath: new vscode.ThemeIcon('check-all'), tooltip: t('Select all') };
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
  vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (p, token) => {
      const abort = new AbortController();
      activeAbort = abort;
      token.onCancellationRequested(() => {
        abort.abort();
      });
      currentStep = (message) => {
        p.report({ message });
      };
      try {
        return await task();
      } catch (e) {
        if (abort.signal.aborted) throw new OperationCancelled();
        throw e;
      } finally {
        currentStep = undefined;
        if (activeAbort === abort) activeAbort = undefined;
      }
    },
  );

/** The `claude` binary inside the installed Claude Code extension, if there is one; `why` says what was looked at. */
function bundledClaude(log: Logger): string | undefined {
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  if (!ext) {
    const similar = vscode.extensions.all.filter((e) => /claude/i.test(e.id)).map((e) => e.id);
    log.info(`Resume: extension anthropic.claude-code not found (claude-like: ${similar.join(', ') || 'none'}).`);
    return undefined;
  }
  const file = path.join(
    ext.extensionPath,
    'resources',
    'native-binary',
    process.platform === 'win32' ? 'claude.exe' : 'claude',
  );
  const exists = fs.existsSync(file);
  log.info(
    `Resume: Claude Code ${ext.packageJSON ? String((ext.packageJSON as { version?: string }).version) : '?'} at ${ext.extensionPath}; binary ${file} ${exists ? 'found' : 'MISSING'}.`,
  );
  return exists ? file : undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Claude Session Sync');
  const log = channelLogger(channel);
  log.info(`Claude Session Sync ${String((context.extension.packageJSON as { version?: string }).version)} started.`);

  /** The chosen storage cannot be reached or the account is not signed in: offer to reconnect instead of a bare error. */
  const reconnect = async (message: string): Promise<boolean> => {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    const mode = cfg.get<string>('mode');
    if (mode === 'github') {
      const pick = await vscode.window.showErrorMessage(
        t('Claude Sync: no access to GitHub ({0}).', message),
        SIGN_IN_GITHUB,
        CHANGE_METHOD,
      );
      if (pick === SIGN_IN_GITHUB) {
        await vscode.authentication.getSession('github', ['repo'], { forceNewSession: true });
        return true;
      }
      if (pick) await vscode.commands.executeCommand(`${SECTION}.chooseMode`);
      return false;
    }
    if (mode === 'folder') {
      const pick = await vscode.window.showErrorMessage(
        t('Claude Sync: the sync folder is not available ({0}).', message),
        CHOOSE_AGAIN,
        CHANGE_METHOD,
      );
      if (pick === CHOOSE_AGAIN) {
        await cfg.update('syncFolder', '', vscode.ConfigurationTarget.Global);
        return Boolean(await folderTransport());
      }
      if (pick) await vscode.commands.executeCommand(`${SECTION}.chooseMode`);
      return false;
    }
    if (isCloudId(mode)) {
      const cloud = CLOUDS[mode];
      const pick = await vscode.window.showErrorMessage(
        t('Claude Sync: {0} did not accept the sign-in ({1}).', cloud.label, message),
        SIGN_IN_AGAIN,
        CHANGE_METHOD,
      );
      if (pick === SIGN_IN_AGAIN) {
        await context.secrets.delete(tokenKey(cloud));
        return true;
      }
      if (pick) await vscode.commands.executeCommand(`${SECTION}.chooseMode`);
      return false;
    }
    const pick = await vscode.window.showErrorMessage(
      t(
        'Claude Sync: no access to your git repository ({0}). Check the URL and sign in to git on this computer.',
        message,
      ),
      OPEN_SETTINGS,
      CHANGE_METHOD,
    );
    if (pick === OPEN_SETTINGS)
      await vscode.commands.executeCommand('workbench.action.openSettings', `${SECTION}.repoUrl`);
    else if (pick) await vscode.commands.executeCommand(`${SECTION}.chooseMode`);
    return false;
  };

  /** Two operations at once would use the same local cache. A stale lock (an unanswered dialog) expires. */
  let busySince = 0;
  /** Changing or dropping the method while a push or pull uses its cache would corrupt that cache. */
  const refuseWhileBusy = (): boolean => {
    if (!busySince || Date.now() - busySince >= BUSY_STALE_MS) return false;
    void vscode.window.showInformationMessage(t('Claude Sync: another Claude Sync operation is still running.'));
    return true;
  };

  const advise = async (kind: 'network' | 'full'): Promise<boolean> => {
    const pick = await vscode.window.showErrorMessage(
      kind === 'network'
        ? t('Claude Sync: cannot reach the storage. Check your internet connection and try again.')
        : t('Claude Sync: the storage is full. Free some space there (or choose another method) and try again.'),
      TRY_AGAIN,
      CHANGE_METHOD,
      SHOW_LOG,
    );
    if (pick === CHANGE_METHOD) await vscode.commands.executeCommand(`${SECTION}.chooseMode`);
    if (pick === SHOW_LOG) channel.show();
    return pick === TRY_AGAIN;
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
            if (e instanceof OperationCancelled) {
              log.info('Cancelled by the user.');
              void vscode.window.showInformationMessage(
                t('Claude Sync: cancelled. Nothing was lost; run it again any time.'),
              );
              return;
            }
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
            const pick = await vscode.window.showErrorMessage(t('Claude Sync failed: {0}', message), SHOW_LOG);
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
    const RENAME = t('Use «{0}» on this computer', newName);
    const SAME = t('This is the same computer');
    const pick = await vscode.window.showWarningMessage(
      t(
        'Another computer already pushes as «{0}». Two computers must not share a device name, or their sessions would be mixed up.',
        device,
      ),
      {
        modal: true,
        detail: t(
          'Choose «This is the same computer» only if you reinstalled VS Code on the computer that used this name.',
        ),
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
        {
          label: t('$(arrow-swap) Change sync method'),
          description: t('now: {0}', describeMethod(cfg)),
          id: 'chooseMode',
        },
        ...(connected
          ? [
              {
                label: t('$(lock) Turn on encryption'),
                description: t('Encrypt the stored sessions with a passphrase'),
                id: 'enableEncryption',
              },
              {
                label: t('$(sign-out) Disconnect'),
                description: t('Sign out of this method'),
                id: 'disconnect',
              },
            ]
          : []),
        { label: t('$(output) Show log'), description: '', id: 'log' },
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
            t(
              'Claude Sync: there are no Claude Code sessions for this project on this computer yet (looked in {0}). Start a session in Claude Code first.',
              s.localDir,
            ),
          );
          return;
        }
        const review = vscode.workspace.getConfiguration(SECTION).get<boolean>('scanSecrets', true)
          ? (pending: readonly string[]) => reviewSecrets(s.localDir, pending)
          : undefined;
        const run = (takeOver: boolean) =>
          progress(t('Claude Sync: pushing…'), () => s.service.push({ takeOver, review }));
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
      void vscode.window.showInformationMessage(t('Claude Sync: now using {0}.', where));
    }),
    vscode.commands.registerCommand(`${SECTION}.disconnect`, async () => {
      if (refuseWhileBusy()) return;
      const cfg = vscode.workspace.getConfiguration(SECTION);
      const mode = cfg.get<string>('mode');
      if (!isMode(mode)) {
        void vscode.window.showInformationMessage(t('Claude Sync: nothing is connected.'));
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        t(
          'Disconnect from {0}? Sessions already stored there and on this device are left untouched. The copy the extension keeps for syncing is removed.',
          describeMethod(cfg),
        ),
        { modal: true },
        t('Disconnect'),
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
          ? t('Claude Sync: disconnected. To also revoke GitHub access, sign out of GitHub in the Accounts menu.')
          : t('Claude Sync: disconnected. The next Push or Pull will ask for a method again.'),
      );
    }),
    command('enableEncryption', async (s) => {
      await progress(t('Claude Sync: looking at the storage…'), () => s.transport.refresh());
      if (s.transport.encrypted) {
        void vscode.window.showInformationMessage(t('Claude Sync: {0} is already encrypted.', s.where));
        return;
      }
      const REMOVE = t('Turn on and remove unencrypted copies');
      const KEEP = t('Turn on, keep them');
      const how = await vscode.window.showWarningMessage(
        t('Encrypt the sessions in {0} with a passphrase?', s.where),
        {
          modal: true,
          detail:
            t(
              'Only devices that know the passphrase can read them; the storage sees nothing but encrypted files. You will type the same passphrase once on every other device. If it is lost, the stored sessions cannot be recovered (the ones on your devices are not affected).',
            ) +
            '\n\n' +
            t(
              'Sessions already in the storage are not encrypted. Remove them now and each device pushes its sessions again, encrypted. Devices with an older version of the extension will not see encrypted sessions.',
            ),
        },
        REMOVE,
        KEEP,
      );
      if (!how) return;
      const passphrase = await vscode.window.showInputBox({
        title: t('Claude Sync: choose an encryption passphrase'),
        prompt: t('At least 12 characters. Several unrelated words are easy to type and hard to guess.'),
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (v.length < 12 ? t('At least 12 characters.') : undefined),
      });
      if (!passphrase) return;
      const again = await vscode.window.showInputBox({
        title: t('Claude Sync: type the passphrase again'),
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (v && v !== passphrase ? t('Does not match.') : undefined),
      });
      if (again !== passphrase) return;
      const meta = await progress(t('Claude Sync: turning on encryption…'), () =>
        s.transport.enable(passphrase, { removePlain: how === REMOVE }),
      );
      if (!meta) {
        void vscode.window.showInformationMessage(t('Claude Sync: another device has just turned encryption on.'));
        return;
      }
      await context.secrets.store(passphraseKey(meta), passphrase).then(undefined, () => undefined);
      const pick = await vscode.window.showInformationMessage(
        t(
          'Claude Sync: encryption is on. Push now so this device stores its sessions encrypted; on your other devices, Pull and enter the passphrase.',
        ),
        t('Push now'),
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
        title: t('Claude Sync: import from which device?'),
        lastUsed: context.globalState.get<string>('lastPullDevice'),
      });
      if (!from) return;
      void context.globalState.update('lastPullDevice', from.name);
      const chosen = await chooseSessionsToPull(s.service, from.name);
      if (!chosen) return;
      const result = await progress(t('Claude Sync: pulling…'), () => s.service.pull(from.name, chosen));
      report('pull', result, s.limits, s.where, deviceLabel(from));
    }),
    command('deleteExport', async (s) => {
      const from = await chooseDevice(s.service, {
        includeOwn: true,
        where: s.where,
        title: t('Claude Sync: delete the exported sessions of which device?'),
      });
      if (!from) return;
      const ok = await vscode.window.showWarningMessage(
        t(
          'Delete the {0} session(s) of this project that «{1}» exported to {2}? Sessions on your devices are not touched, but the stored copies cannot be restored from here.',
          from.sessions,
          deviceLabel(from),
          s.where,
        ),
        { modal: true },
        t('Delete'),
      );
      if (!ok) return;
      const { removed } = await progress(t('Claude Sync: deleting…'), () => s.service.removeDevice(from.name));
      void vscode.window.showInformationMessage(
        t('Claude Sync: deleted {0} stored session(s) of «{1}».', removed, deviceLabel(from)),
      );
    }),
    // Resuming only reads local files: no storage, network or sign-in needed.
    vscode.commands.registerCommand(`${SECTION}.resume`, async () => {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!folder) {
        void vscode.window.showErrorMessage(t('Claude Sync: open a folder first.'));
        return;
      }
      const claudeDir = vscode.workspace.getConfiguration(SECTION).get<string>('claudeDir', '').trim();
      const sessions = listSessions(path.join(claudeProjectsDir(claudeDir), encodeProjectDir(folder)));
      if (!sessions.length) {
        void vscode.window.showInformationMessage(t('Claude Sync: no local sessions. Run «Pull sessions» first.'));
        return;
      }
      const pick = await vscode.window.showQuickPick(
        sessions.map((x) => ({
          label: x.title,
          description: new Date(x.lastActivity).toLocaleString(),
          detail: x.id,
        })),
        { placeHolder: t('Choose a session to resume'), matchOnDetail: true },
      );
      if (!pick?.detail) return;
      // `claude` is often not in the terminal's PATH (common on Windows): the Claude Code extension ships its own binary.
      const binary = bundledClaude(log);
      const env = claudeDir ? { CLAUDE_CONFIG_DIR: claudeDir } : undefined;
      log.info(
        `Resume ${pick.detail}: ${binary ? `starting ${binary}` : 'no bundled binary, typing «claude» in a terminal'}; cwd ${folder}.`,
      );
      if (binary) {
        vscode.window
          .createTerminal({
            name: t('Claude (resumed)'),
            cwd: folder,
            env,
            shellPath: binary,
            shellArgs: ['--resume', pick.detail],
          })
          .show();
        return;
      }
      const terminal = vscode.window.createTerminal({ name: t('Claude (resumed)'), cwd: folder, env });
      terminal.show();
      terminal.sendText(`claude --resume ${pick.detail}`);
    }),
  );
}

export function deactivate(): void {}
