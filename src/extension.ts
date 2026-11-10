import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isValidRepoUrl, remoteOf } from './core/git';
import { Limits, MB, parseLimits } from './core/limits';
import { Logger } from './core/logger';
import { claudeProjectsDir, encodeProjectDir, projectKey } from './core/paths';
import { SyncResult, SyncService } from './core/syncService';
import { listSessions } from './core/transcripts';

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
}

async function openSession(context: vscode.ExtensionContext, log: Logger): Promise<Session | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) {
    void vscode.window.showErrorMessage('Claude Sync: open a folder first.');
    return;
  }
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const repoUrl = cfg.get<string>('repoUrl', '').trim();
  if (!isValidRepoUrl(repoUrl)) {
    const pick = await vscode.window.showErrorMessage(
      'Claude Sync: set a valid claudeSessionSync.repoUrl (https, ssh or git@host:owner/repo of a PRIVATE repository).',
      'Open settings',
    );
    if (pick) await vscode.commands.executeCommand('workbench.action.openSettings', `${SECTION}.repoUrl`);
    return;
  }
  const repoDir = path.join(context.globalStorageUri.fsPath, 'repo');
  const localDir = path.join(claudeProjectsDir(cfg.get<string>('claudeDir', '')), encodeProjectDir(folder));
  const key = projectKey(await remoteOf(folder), folder);
  const limits = parseLimits({
    maxFileSizeMB: cfg.get('maxFileSizeMB'),
    maxSessionAgeDays: cfg.get('maxSessionAgeDays'),
  });
  const service = new SyncService(
    { repoUrl, repoDir, localDir, remoteDir: path.join(repoDir, 'projects', key), hostname: os.hostname(), limits },
    log,
  );
  return { service, localDir, folder, limits };
}

async function confirmFirstPush(context: vscode.ExtensionContext): Promise<boolean> {
  if (context.globalState.get<boolean>(WARNED_KEY)) return true;
  const ok = await vscode.window.showWarningMessage(
    'Session transcripts contain your code, command output and possibly secrets. Push only to a PRIVATE repository you control.',
    { modal: true },
    'I understand, push',
  );
  if (ok) await context.globalState.update(WARNED_KEY, true);
  return Boolean(ok);
}

function report(verb: 'push' | 'pull', r: SyncResult, limits: Limits): void {
  const older = r.tooOld > 0 ? ` ${r.tooOld} older than ${limits.maxAgeDays} days left out.` : '';
  void vscode.window.showInformationMessage(
    r.pushed === false
      ? `Claude Sync: nothing new to ${verb}.${older}`
      : `Claude Sync: ${verb}ed ${r.copied.length} session(s).${older}`,
  );
  if (r.tooLarge.length) {
    void vscode.window.showWarningMessage(
      `Claude Sync: ${r.tooLarge.length} session(s) are over ${Math.round(limits.maxFileBytes / MB)} MB and were NOT pushed ` +
        `(GitHub rejects files over 100 MB): ${r.tooLarge.join(', ')}`,
    );
  }
  if (r.conflicts.length) {
    void vscode.window.showWarningMessage(
      `Claude Sync: ${r.conflicts.length} session(s) were continued on two devices and were NOT overwritten: ${r.conflicts.join(', ')}`,
    );
  }
}

const progress = <T>(title: string, task: () => Promise<T>) =>
  vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Claude Session Sync');
  const log = channelLogger(channel);

  const command = (id: string, body: (s: Session) => Promise<void>, before?: () => Promise<boolean>) =>
    vscode.commands.registerCommand(`${SECTION}.${id}`, async () => {
      try {
        if (before && !(await before())) return;
        const s = await openSession(context, log);
        if (s) await body(s);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log.error(message);
        const pick = await vscode.window.showErrorMessage(`Claude Sync failed: ${message}`, 'Show log');
        if (pick) channel.show();
      }
    });

  context.subscriptions.push(
    channel,
    command(
      'push',
      async (s) => {
        report('push', await progress('Claude Sync: pushing…', () => s.service.push()), s.limits);
      },
      () => confirmFirstPush(context),
    ),
    command('pull', async (s) => {
      report('pull', await progress('Claude Sync: pulling…', () => s.service.pull()), s.limits);
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
