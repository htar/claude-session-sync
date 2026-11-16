import { promisify } from 'node:util';
import * as zlib from 'node:zlib';
import { RemoteFile, RemoteStore } from './remote';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/** A compressed transcript is stored as `<name>.jsonl.<plain size>.gz`: the size in the name keeps change detection working without downloading. */
const PACKED = /^(.*\.jsonl)\.(\d+)\.gz$/;

/**
 * Wraps a cloud store and keeps session transcripts gzip-compressed in it. The rest of the extension still sees plain
 * `.jsonl` files with their plain size. Files stored uncompressed by earlier versions are read as before and replaced
 * by a compressed copy the next time they are uploaded.
 */
export class GzipStore implements RemoteStore {
  /** plain rel → every name it has in the store. */
  private names = new Map<string, string[]>();

  constructor(private readonly inner: RemoteStore) {}

  async list(): Promise<RemoteFile[]> {
    const out = new Map<string, RemoteFile>();
    this.names = new Map();
    for (const f of await this.inner.list()) {
      const m = PACKED.exec(f.rel);
      const rel = m?.[1] ?? f.rel;
      this.names.set(rel, [...(this.names.get(rel) ?? []), f.rel]);
      // A compressed copy wins over a leftover plain one.
      if (m || !out.has(rel)) out.set(rel, { ...f, rel, size: m ? Number(m[2]) : f.size });
    }
    return [...out.values()];
  }

  async download(rel: string): Promise<Buffer> {
    const names = this.names.get(rel) ?? [rel];
    const name = names.find((n) => PACKED.test(n)) ?? names[0] ?? rel;
    const data = await this.inner.download(name);
    return PACKED.test(name) ? gunzip(data) : data;
  }

  async upload(rel: string, data: Buffer): Promise<void> {
    if (!rel.endsWith('.jsonl')) return this.inner.upload(rel, data);
    const name = `${rel}.${data.length}.gz`;
    await this.inner.upload(name, await gzip(data));
    // Drop the older copies (other size in the name, or the plain one) only after the new one is safely there.
    for (const old of this.names.get(rel) ?? []) if (old !== name) await this.inner.remove(old);
    this.names.set(rel, [name]);
  }

  async remove(rel: string): Promise<void> {
    for (const name of this.names.get(rel) ?? [rel]) await this.inner.remove(name);
    this.names.delete(rel);
  }
}
