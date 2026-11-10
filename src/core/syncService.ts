import { commitAndPush, ensureClone, pullRepo } from './git';
import { Limits } from './limits';
import { Logger, silentLogger } from './logger';
import { CopyOptions, CopyResult, copyTranscripts } from './transcripts';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SyncConfig {
  repoUrl: string;
  /** Local clone of the sync repository. */
  repoDir: string;
  /** `~/.claude/projects/<encoded workspace path>` on this device. */
  localDir: string;
  /** `<repoDir>/projects/<project key>`. */
  remoteDir: string;
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
  /** push only: false when nothing changed. */
  pushed?: boolean;
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
      await ensureClone(this.cfg.repoDir, this.cfg.repoUrl);
      const filter = this.pushFilter();
      let last: CopyResult | undefined;
      // A push can lose a race against another device: pull again and retry once.
      for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
        await pullRepo(this.cfg.repoDir);
        last = copyTranscripts(this.cfg.localDir, this.cfg.remoteDir, filter);
        try {
          const pushed = await commitAndPush(
            this.cfg.repoDir,
            `sync ${this.cfg.hostname}: ${last.copied.length} session(s)`,
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

  pull(): Promise<SyncResult> {
    return this.exclusive(async () => {
      await ensureClone(this.cfg.repoDir, this.cfg.repoUrl);
      await pullRepo(this.cfg.repoDir);
      const r = copyTranscripts(this.cfg.remoteDir, this.cfg.localDir);
      this.log.info(`pull: ${r.copied.length} copied, ${r.conflicts.length} conflicts`);
      return { copied: r.copied, conflicts: r.conflicts, tooLarge: [], tooOld: 0 };
    });
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
