import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Transport } from './transport';

/**
 * End-to-end encryption of the store with a passphrase. The storage (GitHub, Dropbox, a cloud folder) only ever sees
 * `<name>.enc` files and `encryption.json`; the plain transcripts live in a local cache on each device.
 *
 * File format: `CSS1` | 12-byte IV | 16-byte GCM tag | AES-256-GCM ciphertext. The key comes from the passphrase
 * through scrypt with the salt in `encryption.json`, which also holds an encrypted check value to tell a wrong
 * passphrase from a damaged file. The `.enc` suffix keeps older versions of the extension from reading ciphertext as
 * a session.
 */
export const ENCRYPTION_FILE = 'encryption.json';
const SUFFIX = '.enc';
const MAGIC = Buffer.from('CSS1');
const CHECK = 'claude-session-sync';
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export interface EncryptionMeta {
  version: 1;
  kdf: 'scrypt';
  salt: string;
  check: string;
}

/** The passphrase does not open this store. */
export class WrongPassphraseError extends Error {
  constructor() {
    super('The encryption passphrase is not correct for this storage.');
  }
}

export function deriveKey(passphrase: string, saltB64: string): Buffer {
  return crypto.scryptSync(passphrase.normalize('NFC'), Buffer.from(saltB64, 'base64'), 32, SCRYPT);
}

export function encrypt(key: Buffer, plain: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

/** Throws when the data was not made with this key or was changed. */
export function decrypt(key: Buffer, data: Buffer): Buffer {
  if (data.length < 32 || !data.subarray(0, 4).equals(MAGIC)) throw new Error('Not an encrypted Claude Sync file.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(4, 16));
  decipher.setAuthTag(data.subarray(16, 32));
  return Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]);
}

/** New store settings for a passphrase: a random salt and the check value. */
export function newMeta(passphrase: string): { meta: EncryptionMeta; key: Buffer } {
  const salt = crypto.randomBytes(16).toString('base64');
  const key = deriveKey(passphrase, salt);
  const check = encrypt(key, Buffer.from(CHECK)).toString('base64');
  return { meta: { version: 1, kdf: 'scrypt', salt, check }, key };
}

/** The key for this store, or WrongPassphraseError. */
export function openMeta(meta: EncryptionMeta, passphrase: string): Buffer {
  const key = deriveKey(passphrase, meta.salt);
  try {
    if (decrypt(key, Buffer.from(meta.check, 'base64')).toString() === CHECK) return key;
  } catch {
    // falls through
  }
  throw new WrongPassphraseError();
}

export function readMeta(storeRoot: string): EncryptionMeta | undefined {
  const file = path.join(storeRoot, ENCRYPTION_FILE);
  if (!fs.existsSync(file)) return undefined;
  const meta = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<EncryptionMeta>;
  if (meta.version !== 1 || meta.kdf !== 'scrypt' || !meta.salt || !meta.check)
    throw new Error(`${ENCRYPTION_FILE} in the storage is not understood by this version of the extension.`);
  return meta as EncryptionMeta;
}

/** Asks for the passphrase of an encrypted store and returns its key (see `openMeta`), or undefined when the user gives up. */
export type PassphraseSource = (meta: EncryptionMeta) => Promise<Buffer | undefined>;

const sha1 = (data: Buffer): string => crypto.createHash('sha1').update(data).digest('hex');

/** Every regular file under `dir` as `/`-separated relative paths; `.git` and hidden tmp files are skipped. */
function walk(dir: string, base = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith('.')) return [];
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) return walk(path.join(dir, e.name), rel);
    return e.isFile() ? [rel] : [];
  });
}

const abs = (root: string, rel: string): string => path.join(root, ...rel.split('/'));

function writeAtomic(file: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function removeEmptyDirs(dir: string, isRoot = true): void {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('.')) removeEmptyDirs(path.join(dir, e.name), false);
  }
  if (!isRoot && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

/**
 * Wraps any transport. While the store has no `encryption.json` it is a pass-through (`root` is the inner one). Once
 * it has, `root` is a local plain cache: `refresh` decrypts what changed in the store into it, and `publish`
 * encrypts what changed in it back into the store.
 */
export class EncryptingTransport implements Transport {
  private key: Buffer | undefined;
  /** plain rel → hash of the plain content as last synced with the store. */
  private synced = new Map<string, string>();
  /** plain rel → hash of its `.enc` file as last decrypted, so unchanged files are not decrypted again. */
  private cipherSeen = new Map<string, string>();

  constructor(
    private readonly inner: Transport,
    private readonly plainRoot: string,
    private readonly passphrase: PassphraseSource,
  ) {}

  get root(): string {
    return this.key ? this.plainRoot : this.inner.root;
  }

  get encrypted(): boolean {
    return this.key !== undefined;
  }

  async refresh(): Promise<void> {
    await this.inner.refresh();
    const meta = readMeta(this.inner.root);
    if (!meta) {
      this.key = undefined;
      return;
    }
    if (!this.key) {
      const key = await this.passphrase(meta);
      if (!key) throw new Error('The storage is encrypted, and no passphrase was given.');
      this.key = key;
    }
    this.decryptAll();
  }

  /**
   * Turns encryption on for a store that has none yet and publishes the settings; from now on every device pushes
   * encrypted copies. `removePlain` deletes the unencrypted copies already in the store (each device pushes its
   * sessions again, encrypted). Returns the new settings, or undefined when it was already on.
   */
  async enable(passphrase: string, opts: { removePlain?: boolean } = {}): Promise<EncryptionMeta | undefined> {
    await this.inner.refresh();
    if (readMeta(this.inner.root)) return undefined;
    if (opts.removePlain) {
      for (const rel of walk(this.inner.root)) fs.rmSync(abs(this.inner.root, rel));
      removeEmptyDirs(this.inner.root);
    }
    this.key = createEncryption(this.inner.root, passphrase);
    this.synced.clear();
    this.cipherSeen.clear();
    fs.rmSync(this.plainRoot, { recursive: true, force: true });
    fs.mkdirSync(this.plainRoot, { recursive: true });
    await this.inner.publish('turn on encryption', 1);
    return readMeta(this.inner.root);
  }

  async publish(message: string, copied: number): Promise<boolean> {
    const key = this.key;
    if (!key) return this.inner.publish(message, copied);
    const plain = new Set(walk(this.plainRoot));
    let changed = 0;
    for (const rel of plain) {
      const data = fs.readFileSync(abs(this.plainRoot, rel));
      const hash = sha1(data);
      if (this.synced.get(rel) === hash) continue;
      const cipher = encrypt(key, data);
      writeAtomic(abs(this.inner.root, rel + SUFFIX), cipher);
      this.synced.set(rel, hash);
      this.cipherSeen.set(rel, sha1(cipher));
      changed++;
    }
    for (const rel of [...this.synced.keys()]) {
      if (plain.has(rel)) continue;
      fs.rmSync(abs(this.inner.root, rel + SUFFIX), { force: true });
      this.synced.delete(rel);
      this.cipherSeen.delete(rel);
      changed++;
    }
    removeEmptyDirs(this.inner.root);
    return (await this.inner.publish(message, changed)) || changed > 0;
  }

  /** Makes the plain cache equal to the store's `.enc` files; unchanged files are not decrypted again. */
  private decryptAll(): void {
    const key = this.key;
    if (!key) return;
    const inStore = new Set(
      walk(this.inner.root)
        .filter((r) => r.endsWith(SUFFIX))
        .map((r) => r.slice(0, -SUFFIX.length)),
    );
    const next = new Map<string, string>();
    const seen = new Map<string, string>();
    for (const rel of inStore) {
      const cipher = fs.readFileSync(abs(this.inner.root, rel + SUFFIX));
      const cipherHash = sha1(cipher);
      seen.set(rel, cipherHash);
      const target = abs(this.plainRoot, rel);
      const known = this.synced.get(rel);
      if (known && this.cipherSeen.get(rel) === cipherHash && fs.existsSync(target)) {
        next.set(rel, known);
        continue;
      }
      const data = decrypt(key, cipher);
      writeAtomic(target, data);
      next.set(rel, sha1(data));
    }
    this.cipherSeen = seen;
    for (const rel of walk(this.plainRoot)) {
      if (!inStore.has(rel)) fs.rmSync(abs(this.plainRoot, rel));
    }
    removeEmptyDirs(this.plainRoot);
    this.synced = next;
  }
}

/** Writes `encryption.json` for a new passphrase into the store and returns the key. */
export function createEncryption(storeRoot: string, passphrase: string): Buffer {
  const { meta, key } = newMeta(passphrase);
  fs.mkdirSync(storeRoot, { recursive: true });
  fs.writeFileSync(path.join(storeRoot, ENCRYPTION_FILE), `${JSON.stringify(meta, null, 2)}\n`);
  return key;
}
