import * as fs from 'node:fs';
import { commitAndPush, ensureClone, GitEnv, pullRepo } from './git';

/** Where the transcripts of all devices meet: a git clone or a folder that a cloud client keeps in sync. */
export interface Transport {
  /** Directory that holds `projects/<key>/*.jsonl`. */
  readonly root: string;
  /** Makes the shared store current before anything is copied out of it or into it. */
  refresh(): Promise<void>;
  /** Makes what was copied into the store visible to the other devices. False when there was nothing new. */
  publish(message: string, copied: number): Promise<boolean>;
}

export class GitTransport implements Transport {
  constructor(
    readonly root: string,
    private readonly url: string,
    /** Credentials for this call, e.g. a token from the editor's GitHub sign-in. */
    private readonly env: () => Promise<GitEnv> = () => Promise.resolve({}),
    private readonly onProgress: (message: string) => void = () => undefined,
  ) {}

  async refresh(): Promise<void> {
    const env = await this.env();
    this.onProgress('Fetching the repository…');
    await ensureClone(this.root, this.url, env);
    await pullRepo(this.root, env);
  }

  async publish(message: string): Promise<boolean> {
    this.onProgress('Uploading to the repository…');
    return commitAndPush(this.root, message, await this.env());
  }
}

/** A plain folder (iCloud Drive, Dropbox, OneDrive, a network drive): the cloud client does the transport. */
export class FolderTransport implements Transport {
  constructor(readonly root: string) {}

  refresh(): Promise<void> {
    if (!fs.existsSync(this.root) || !fs.statSync(this.root).isDirectory()) {
      return Promise.reject(new Error(`Sync folder not found: ${this.root}`));
    }
    return Promise.resolve();
  }

  publish(_message: string, copied: number): Promise<boolean> {
    return Promise.resolve(copied > 0);
  }
}
