import { commitAndPush, ensureClone, pullRepo } from './git';
import { Logger, silentLogger } from './logger';
import { CopyResult, copyTranscripts } from './transcripts';

export interface SyncConfig {
  repoUrl: string;
  /** Local clone of the sync repository. */
  repoDir: string;
  /** `~/.claude/projects/<encoded workspace path>` on this device. */
  localDir: string;
  /** `<repoDir>/projects/<project key>`. */
  remoteDir: string;
  hostname: string;
}

export interface SyncResult {
  copied: string[];
  conflicts: string[];
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
      let last: CopyResult | undefined;
      // A push can lose a race against another device: pull again and retry once.
      for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
        await pullRepo(this.cfg.repoDir);
        last = copyTranscripts(this.cfg.localDir, this.cfg.remoteDir);
        try {
          const pushed = await commitAndPush(
            this.cfg.repoDir,
            `sync ${this.cfg.hostname}: ${last.copied.length} session(s)`,
          );
          this.log.info(`push: ${last.copied.length} copied, ${last.conflicts.length} conflicts, pushed=${pushed}`);
          return { copied: last.copied, conflicts: last.conflicts, pushed };
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
      return { copied: r.copied, conflicts: r.conflicts };
    });
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
