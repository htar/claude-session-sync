import * as fs from 'node:fs';
import * as path from 'node:path';
import { Limits } from './limits';
import { deviceDir, DeviceInfo, LEGACY_SOURCE, listDevices, safeDeviceName } from './devices';
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
  /** Key of the project in the shared store. */
  projectKey: string;
  /** This device's name: its own folder `devices/<name>/projects/<key>` is the only place a push writes to. */
  deviceName: string;
  /** This installation's id: tells two computers with the same device name apart. Without it nothing is checked. */
  installId?: string;
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

/** The device folder of the store belongs to another installation: two machines share one name (e.g. «MacBook-Pro»). */
export class DeviceNameTakenError extends Error {
  constructor(readonly device: string) {
    super(`The device name «${device}» is already used by another computer.`);
  }
}

/** Written once into `devices/<name>/`, so a second computer with the same name is noticed instead of mixed in. */
const DEVICE_MARKER = 'device.json';

/** Serialises operations: two concurrent git commands in one clone corrupt each other's index. */
export class SyncService {
  private queue: Promise<unknown> = Promise.resolve();

  /** The device folder this device exports to. */
  readonly device: string;

  constructor(
    private readonly cfg: SyncConfig,
    private readonly log: Logger = silentLogger,
  ) {
    this.device = safeDeviceName(cfg.deviceName);
  }

  /** `takeOver`: the user confirmed that a folder with this name is this very computer's (a reinstalled editor). */
  push(opts: { takeOver?: boolean } = {}): Promise<SyncResult> {
    return this.exclusive(async () => {
      const filter = this.pushFilter();
      let last: CopyResult | undefined;
      // A push can lose a race against another device: pull again and retry once.
      for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
        await this.cfg.transport.refresh();
        this.claimDevice(opts.takeOver === true);
        last = copyTranscripts(this.cfg.localDir, this.dirOf(this.device), filter);
        try {
          const pushed = await this.cfg.transport.publish(
            `sync ${this.device}: ${last.copied.length} session(s)`,
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

  /** Devices that have exported this project, so the user can choose where to import from. */
  devices(): Promise<DeviceInfo[]> {
    return this.exclusive(async () => {
      await this.cfg.transport.refresh();
      return listDevices(this.cfg.transport.root, this.cfg.projectKey);
    });
  }

  /** What `from` (a device name) holds for this project, newest first, so the user can choose what to pull. */
  available(from: string): Promise<AvailableSession[]> {
    return this.exclusive(async () => {
      await this.cfg.transport.refresh();
      const dir = this.dirOf(from);
      return listSessions(dir).map((s) => ({
        ...s,
        status: sessionStatus(path.join(dir, `${s.id}.jsonl`), path.join(this.cfg.localDir, `${s.id}.jsonl`)),
      }));
    });
  }

  /** Pulls everything `from` holds, or only the sessions with these ids. */
  pull(from: string, ids?: readonly string[]): Promise<SyncResult> {
    return this.exclusive(async () => {
      await this.cfg.transport.refresh();
      const only = ids && new Set(ids.map((id) => `${id}.jsonl`));
      const r = copyTranscripts(this.dirOf(from), this.cfg.localDir, only ? { only } : {});
      this.log.info(
        `pull from ${from}: ${r.copied.length} copied, ${r.conflicts.length} conflicts, ${r.notDownloaded} not downloaded`,
      );
      return { copied: r.copied, conflicts: r.conflicts, tooLarge: [], tooOld: 0, notDownloaded: r.notDownloaded };
    });
  }

  /**
   * Deletes one device's exported sessions of THIS project from the store, and nothing else: not the other
   * projects of that device, not the store itself, and never a path that leaves it. Local sessions are untouched.
   */
  removeDevice(device: string): Promise<{ removed: number; published: boolean }> {
    return this.exclusive(async () => {
      await this.cfg.transport.refresh();
      const root = this.cfg.transport.root;
      const dir = this.dirOf(device);
      const rel = path.relative(root, dir);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel))
        throw new Error('Refusing to delete outside the store.');
      if (!fs.existsSync(dir)) return { removed: 0, published: false };
      const removed = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).length;
      fs.rmSync(dir, { recursive: true });
      // Tidy the folders this left empty, up to (not including) `devices` / `projects` / the store itself.
      const keep = new Set([root, path.join(root, 'devices'), path.join(root, 'projects')]);
      for (let p = path.dirname(dir); !keep.has(p); p = path.dirname(p)) {
        try {
          fs.rmdirSync(p); // fails when something is still inside: then it stays
        } catch {
          break;
        }
      }
      // When nothing but the ownership marker is left, the device is gone completely.
      const deviceRoot = path.join(root, 'devices', device);
      if (device !== LEGACY_SOURCE && fs.existsSync(deviceRoot)) {
        const left = fs.readdirSync(deviceRoot);
        if (left.length === 1 && left[0] === DEVICE_MARKER) fs.rmSync(deviceRoot, { recursive: true });
      }
      const published = await this.cfg.transport.publish(`remove ${device}: ${removed} session(s)`, removed);
      this.log.info(`removed ${device}: ${removed} session(s), published=${published}`);
      return { removed, published };
    });
  }

  private claimDevice(takeOver: boolean): void {
    const id = this.cfg.installId;
    if (!id) return;
    const dir = path.join(this.cfg.transport.root, 'devices', this.device);
    const marker = path.join(dir, DEVICE_MARKER);
    if (fs.existsSync(marker)) {
      let owner: unknown;
      try {
        owner = (JSON.parse(fs.readFileSync(marker, 'utf8')) as { id?: unknown }).id;
      } catch {
        owner = undefined; // unreadable marker: treat the folder as unclaimed
      }
      if (owner === id) return;
      if (typeof owner === 'string' && !takeOver) throw new DeviceNameTakenError(this.device);
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ id, name: this.device }));
  }

  private dirOf(device: string): string {
    return deviceDir(this.cfg.transport.root, this.cfg.projectKey, device);
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
