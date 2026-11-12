import * as fs from 'node:fs';
import * as path from 'node:path';
import { Transport } from './transport';

/** The refresh token is gone or revoked, or the service rejected the sign-in: the user has to sign in again. */
export class CloudAuthError extends Error {}

export interface RemoteFile {
  /** Path relative to the app folder, `/`-separated, no leading slash. */
  rel: string;
  size: number;
}

/** What a cloud service has to offer: a flat list of files under the app's own folder and three file operations. */
export interface RemoteStore {
  list(): Promise<RemoteFile[]>;
  download(rel: string): Promise<Buffer>;
  upload(rel: string, data: Buffer): Promise<void>;
  /** Deleting a file that is already gone is not an error. */
  remove(rel: string): Promise<void>;
}

const isHidden = (name: string): boolean => name.startsWith('.');

/** Every regular file under `dir`, as `/`-separated paths relative to it; hidden files (tmp copies) are skipped. */
function walk(dir: string, base = ''): RemoteFile[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (isHidden(e.name)) return [];
    const rel = base ? `${base}/${e.name}` : e.name;
    return e.isDirectory()
      ? walk(path.join(dir, e.name), rel)
      : [{ rel, size: fs.statSync(path.join(dir, e.name)).size }];
  });
}

function pruneEmptyDirs(dir: string, isRoot = true): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) pruneEmptyDirs(path.join(dir, e.name), false);
  }
  if (!isRoot && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

const localPath = (root: string, rel: string): string => path.join(root, ...rel.split('/'));

/**
 * A cloud service's app folder, mirrored into a local cache that the rest of the extension reads and writes like any
 * folder. `refresh` makes the cache equal to the cloud; `publish` uploads what changed in it and deletes what is gone.
 */
export class MirrorTransport implements Transport {
  private remote = new Map<string, number>();

  constructor(
    readonly root: string,
    private readonly store: RemoteStore,
  ) {}

  async refresh(): Promise<void> {
    fs.mkdirSync(this.root, { recursive: true });
    const listed = await this.store.list();
    this.remote = new Map(listed.map((f) => [f.rel, f.size]));
    for (const f of listed) {
      const local = localPath(this.root, f.rel);
      if (fs.existsSync(local) && fs.statSync(local).size === f.size) continue;
      const data = await this.store.download(f.rel);
      fs.mkdirSync(path.dirname(local), { recursive: true });
      const tmp = path.join(path.dirname(local), `.${path.basename(local)}.tmp-${process.pid}`);
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, local);
    }
    for (const f of walk(this.root)) {
      if (!this.remote.has(f.rel)) fs.rmSync(localPath(this.root, f.rel));
    }
    pruneEmptyDirs(this.root);
  }

  async publish(): Promise<boolean> {
    const local = walk(this.root);
    const localRels = new Set(local.map((f) => f.rel));
    let changed = false;
    for (const f of local) {
      if (this.remote.get(f.rel) === f.size) continue;
      await this.store.upload(f.rel, fs.readFileSync(localPath(this.root, f.rel)));
      this.remote.set(f.rel, f.size);
      changed = true;
    }
    for (const rel of [...this.remote.keys()]) {
      if (localRels.has(rel)) continue;
      await this.store.remove(rel);
      this.remote.delete(rel);
      changed = true;
    }
    return changed;
  }
}
