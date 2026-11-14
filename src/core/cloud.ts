import { dropboxOAuth, DropboxClient } from './dropbox';
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GoogleDriveClient, googleOAuth } from './googledrive';
import { FetchFn, OAuthConfig, TokenFn } from './oauth';
import { onedriveOAuth, OneDriveClient } from './onedrive';
import { RemoteStore } from './remote';

export type CloudId = 'dropbox' | 'onedrive' | 'googledrive';

/** A cloud service the extension talks to directly through its API (no desktop app needed). */
export interface CloudProvider {
  id: CloudId;
  label: string;
  /** Where the files end up, for messages. */
  where: string;
  /** False when the build has no credentials for the service (Google's secret is compiled in, not committed): the method stays hidden. */
  available: boolean;
  oauth: OAuthConfig;
  store: (fetchFn: FetchFn, token: TokenFn) => RemoteStore;
}

export const CLOUDS: Record<CloudId, CloudProvider> = {
  dropbox: {
    id: 'dropbox',
    label: 'Dropbox',
    where: 'Dropbox (Apps/Session Sync for Claude Code)',
    available: true,
    oauth: dropboxOAuth,
    store: (f, t) => new DropboxClient(f, t),
  },
  onedrive: {
    id: 'onedrive',
    label: 'OneDrive',
    where: 'OneDrive (Apps/Session Sync for Claude Code)',
    available: true,
    oauth: onedriveOAuth,
    store: (f, t) => new OneDriveClient(f, t),
  },
  googledrive: {
    id: 'googledrive',
    label: 'Google Drive',
    where: 'Google Drive (hidden app folder, not shown in Drive)',
    available: GOOGLE_CLIENT_SECRET !== '',
    oauth: googleOAuth(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET),
    store: (f, t) => new GoogleDriveClient(f, t),
  },
};

export const isCloudId = (v: unknown): v is CloudId =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(CLOUDS, v);
