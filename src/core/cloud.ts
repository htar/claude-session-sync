import { dropboxOAuth, DropboxClient } from './dropbox';
import { FetchFn, OAuthConfig } from './oauth';
import { onedriveOAuth, OneDriveClient } from './onedrive';
import { RemoteStore } from './remote';

export type CloudId = 'dropbox' | 'onedrive';

/** A cloud service the extension talks to directly through its API (no desktop app needed). */
export interface CloudProvider {
  id: CloudId;
  label: string;
  /** Where the files end up, for messages. */
  where: string;
  oauth: OAuthConfig;
  store: (fetchFn: FetchFn, token: () => Promise<string>) => RemoteStore;
}

export const CLOUDS: Record<CloudId, CloudProvider> = {
  dropbox: {
    id: 'dropbox',
    label: 'Dropbox',
    where: 'Dropbox (Apps/Session Sync for Claude Code)',
    oauth: dropboxOAuth,
    store: (f, t) => new DropboxClient(f, t),
  },
  onedrive: {
    id: 'onedrive',
    label: 'OneDrive',
    where: 'OneDrive (Apps/Session Sync for Claude Code)',
    oauth: onedriveOAuth,
    store: (f, t) => new OneDriveClient(f, t),
  },
};

export const isCloudId = (v: unknown): v is CloudId => typeof v === 'string' && Object.prototype.hasOwnProperty.call(CLOUDS, v);
