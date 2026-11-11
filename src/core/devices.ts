import * as fs from 'node:fs';
import * as path from 'node:path';

/** Pseudo-device for sessions pushed by versions before 0.5.0, which shared one folder (`projects/<key>`). */
export const LEGACY_SOURCE = '@shared';

/** A device's folder name: also what other devices read from the store, so it must never leave `devices/`. */
const SAFE_DEVICE_DIR = /^\w[\w.-]{0,63}$/;

export const isSafeDeviceDir = (name: string): boolean => SAFE_DEVICE_DIR.test(name) && !name.includes('..');

/** «Taras's MacBook Pro.local» becomes «Taras-s-MacBook-Pro.local»: a safe, readable folder name. */
export function safeDeviceName(raw: string): string {
  const name = raw
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|-+$/g, '')
    .slice(0, 64);
  return isSafeDeviceDir(name) ? name : 'device';
}

export interface DeviceInfo {
  /** Folder name, or `LEGACY_SOURCE`. */
  name: string;
  sessions: number;
  legacy: boolean;
}

const countSessions = (dir: string): number => {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).length;
  } catch {
    return 0;
  }
};

/** Devices of the store that have exported this project. Folder names that are not safe are ignored. */
export function listDevices(root: string, projectKey: string): DeviceInfo[] {
  const out: DeviceInfo[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.join(root, 'devices'));
  } catch {
    // No device has exported anything yet.
  }
  for (const name of names) {
    if (!isSafeDeviceDir(name)) continue;
    const sessions = countSessions(path.join(root, 'devices', name, 'projects', projectKey));
    if (sessions) out.push({ name, sessions, legacy: false });
  }
  const shared = countSessions(path.join(root, 'projects', projectKey));
  if (shared) out.push({ name: LEGACY_SOURCE, sessions: shared, legacy: true });
  return out;
}

/** Where a device's sessions of this project live in the store. */
export function deviceDir(root: string, projectKey: string, device: string): string {
  if (device === LEGACY_SOURCE) return path.join(root, 'projects', projectKey);
  if (!isSafeDeviceDir(device)) throw new Error(`Unsafe device name: ${device}`);
  return path.join(root, 'devices', device, 'projects', projectKey);
}
