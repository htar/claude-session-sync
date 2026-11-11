import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Env {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

export interface Storage {
  id: string;
  label: string;
  /** Where the provider's app keeps its folder, relative to home. */
  home: string[];
  /** macOS File Provider mounts in `~/Library/CloudStorage`: entry-name prefix, and the folder inside it that is the drive. */
  cloudStorage?: { prefix: string; inner?: string };
  /** Windows: environment variables that name the folder, and drive-letter paths. */
  winEnv?: string[];
  winDrives?: string;
}

/** The sessions live in this folder at the storage's root, away from the user's own files. */
export const SYNC_FOLDER = 'Claude Sessions';

export const STORAGES: Storage[] = [
  { id: 'icloud', label: 'iCloud Drive', home: ['Library/Mobile Documents/com~apple~CloudDocs', 'iCloudDrive'] },
  { id: 'dropbox', label: 'Dropbox', home: ['Dropbox'], cloudStorage: { prefix: 'Dropbox' } },
  {
    id: 'onedrive',
    label: 'OneDrive',
    home: ['OneDrive'],
    cloudStorage: { prefix: 'OneDrive' },
    winEnv: ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'],
  },
  {
    id: 'gdrive',
    label: 'Google Drive',
    home: ['Google Drive/My Drive', 'Google Drive'],
    cloudStorage: { prefix: 'GoogleDrive-', inner: 'My Drive' },
    winDrives: 'GHIJKLMNOPQRSTUVWXYZ',
  },
  { id: 'mega', label: 'MEGA', home: ['MEGA'] },
  { id: 'pcloud', label: 'pCloud', home: ['pCloud Drive', 'pCloudDrive'] },
  { id: 'box', label: 'Box', home: ['Box'], cloudStorage: { prefix: 'Box' } },
  { id: 'proton', label: 'Proton Drive', home: ['Proton Drive'], cloudStorage: { prefix: 'ProtonDrive-' } },
  { id: 'nextcloud', label: 'Nextcloud', home: ['Nextcloud'] },
];

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const listDir = (p: string): string[] => {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
};

/**
 * Roots of the chosen storage on this machine (one per signed-in account). Empty when its app's folder is not
 * where it is expected, and the caller falls back to asking the user for the folder.
 */
export function storageRoots(storage: Storage, e: Env): string[] {
  const out: string[] = [];
  const add = (p: string | undefined): void => {
    if (p && isDir(p) && !out.includes(p)) out.push(p);
  };
  if (storage.cloudStorage && e.platform === 'darwin') {
    const base = path.join(e.home, 'Library', 'CloudStorage');
    for (const entry of listDir(base)) {
      if (entry.startsWith(storage.cloudStorage.prefix)) add(path.join(base, entry, storage.cloudStorage.inner ?? ''));
    }
  }
  for (const rel of storage.home) add(path.join(e.home, rel));
  if (e.platform === 'win32') {
    for (const name of storage.winEnv ?? []) add(e.env[name]);
    for (const letter of storage.winDrives ?? '') add(`${letter}:\\My Drive`);
  }
  return out;
}

/** `<root>/Claude Sessions`, created when missing. */
export function ensureSyncFolder(root: string): string {
  const dir = path.join(root, SYNC_FOLDER);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
