import * as path from 'node:path';
import { Limits } from './limits';
import { Logger, silentLogger } from './logger';
import {
  CopyOptions,
  CopyResult,
  copyTranscripts,
  listSessions,
  SessionInfo,
  sessionStatus,
  SessionStatus,
} from './transcripts';
import { Transport } from './transport';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SyncConfig {
  transport: Transport;
  /** `~/.claude/projects/<encoded workspace path>` on this device. */
  localDir: string;
  /** Key of the project in the shared store: `<transport.root>/projects/<key>`. */
  projectKey: string;
  hostname: string;
  /** Push only: a pull takes everything the repository holds. */
  limits?: Limits;
  /** Clock for the age limit, injectable for tests. */
  now?: () => number;
}

export interface SyncResult {
  copied: string[];
  conflicts: string[];
  /** Over the size limit: left out of the push (GitHub rejects files over 100 MB). */
  tooLarge: string[];
  /** How many sessions older than the age limit were left out of the push. */
  tooOld: number;
  /** iCloud files not downloaded to this device yet (pull only). */
  notDownloaded?: number;
  /** push only: false when nothing changed. */
  pushed?: boolean;
}

/** A session held by the shared store, with what a pull would do to this device's copy. */
export interface AvailableSession extends SessionInfo {
  status: SessionStatus;
}

const MAX_PUSH_ATTEMPTS = 2;

/** Serialises operations: two concurrent git commands in one clone corrupt each other's index. */
export class SyncService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cfg: SyncConfig,
    private readonly log: Logger = silentLogger,
  ) {}

  push(): Promise<SyncResult> {
    return this.exclusive(async () => {
      const filter = this.pushFilter();
      let last: CopyResult | undefined;
      // A push can lose a race against another device: pull again and retry once.
      for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
        await this.cfg.transport.refresh();
        last = copyTranscripts(this.cfg.localDir, this.remoteDir, filter);
        try {
          const pushed = await this.cfg.transport.publish(
            `sync ${this.cfg.hostname}: ${last.copied.length} session(s)`,
            last.copied.length,
          );
          this.log.info(
            `push: ${last.copied.length} copied, ${last.conflicts.length} conflicts, ` +
              `${last.tooLarge.length} too large, ${last.tooOld} too old, pushed=${pushed}`,
          );
          return {
            copied: last.copied,
            conflicts: last.conflicts,
            tooLarge: last.tooLarge,
            tooOld: last.tooOld,
            pushed,
          };
        } catch (e) {
          this.log.warn(`push attempt ${attempt} failed: ${String(e)}`);
          if (attempt === MAX_PUSH_ATTEMPTS) throw e;
        }
      }
      throw new Error('unreachable');
    });
  }

  /** What the shared store holds for this project, newest first, so the user can choose what to pull. */
  available(): Promise<AvailableSession[]> {
    return this.exclusive(async () => {
      await this.cfg.transport.refresh();
      return listSessions(this.remoteDir).map((s) => ({
        ...s,
        status: sessionStatus(
          path.join(this.remoteDir, `${s.id}.jsonl`),
          path.join(this.cfg.localDir, `${s.id}.jsonl`),
        ),
      }));
    });
  }

  /** Pulls everything, or only the sessions with these ids. */
  pull(ids?: readonly string[]): Promise<SyncResult> {
    return this.exclusive(async () => {
      await this.cfg.transport.refresh();
      const only = ids && new Set(ids.map((id) => `${id}.jsonl`));
      const r = copyTranscripts(this.remoteDir, this.cfg.localDir, only ? { only } : {});
      this.log.info(
        `pull: ${r.copied.length} copied, ${r.conflicts.length} conflicts, ${r.notDownloaded} not downloaded`,
      );
      return { copied: r.copied, conflicts: r.conflicts, tooLarge: [], tooOld: 0, notDownloaded: r.notDownloaded };
    });
  }

  private get remoteDir(): string {
    return path.join(this.cfg.transport.root, 'projects', this.cfg.projectKey);
  }

  /** The age cut-off is fixed once per push, so a retry after a lost race uses the same one. */
  private pushFilter(): CopyOptions {
    const { limits, now = Date.now } = this.cfg;
    return {
      maxBytes: limits?.maxFileBytes,
      modifiedAfterMs: limits?.maxAgeDays ? now() - limits.maxAgeDays * DAY_MS : undefined,
    };
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
