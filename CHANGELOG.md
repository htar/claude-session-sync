# Changelog

## 0.7.0

- New method **OneDrive (direct)**: the same browser sign-in as Dropbox, through the Microsoft Graph API (the app folder
  `Apps/Session Sync for Claude Code`, scope `Files.ReadWrite.AppFolder`). Files over 4 MB go through an upload
  session. Microsoft rotates the refresh token, so the new one is saved on every refresh.
- Internals: one OAuth module and one local-cache transport shared by all direct cloud methods.

## 0.6.0

- New method **Dropbox (direct)**: sign in once in the browser (OAuth with PKCE) and the extension talks to the Dropbox
  API itself, so the Dropbox app does not have to be installed. Files live in `Apps/Session Sync for Claude Code`
  (the app has access to that folder only). The token is kept in VS Code's secret storage and removed by «Disconnect».
- «Choose sync method» now reports the real storage path instead of «a cloud folder».

## 0.5.1

- Status-bar item «Claude Sync» and command «Manage connection»: change the sync method or disconnect in one place.
  The Push/Pull message has a «Manage connection» button too.
- When the chosen storage is not reachable or you are not signed in, the extension offers to sign in to GitHub again,
  pick the cloud storage again, or open the repository setting, then retries the command.
- Dropbox is found through its own `info.json`, so a non-standard location (another drive, several accounts) no longer
  asks for the folder by hand.

## 0.5.0

- Each device now exports to its own folder (`devices/<device name>/…`, name from the new `claudeSessionSync.deviceName`
  setting, default the host name). Pushes from different devices no longer touch the same files.
- Pull asks which device to import from, then which of its sessions. Sessions pushed by older versions are offered as
  «Shared (before 0.5.0)».
- New command «Delete exported sessions»: removes one device's stored sessions of the current project (with a
  confirmation; never your local sessions, other projects or the store itself).

## 0.4.2

- New command «Disconnect storage»: forgets the chosen method and storage (nothing is deleted from the storage or from
  this device).
- «Choose sync method» now really starts clean: the previous cloud folder is forgotten and the storage is asked for
  right away.
- Every Push and Pull message says where the sessions went, with a «Change method» button.

## 0.4.1

- Documentation: the README is now in English, with Ukrainian, Spanish and Simplified Chinese versions on GitHub and a
  language switcher at the top.

## 0.4.0

- Three ways to sync, chosen on first use (and changeable with «Choose sync method»): GitHub with a private
  `claude-sessions` repository created automatically after the editor's GitHub sign-in, cloud storage (iCloud Drive, Dropbox, OneDrive,
  Google Drive, MEGA, pCloud, Box, Proton Drive, Nextcloud or any synced folder: you pick the storage and a «Claude Sessions» folder is created at its root; the folder is asked for only when the
  storage is not in its usual place), or your own git repository (as before).
- Pull now shows what the storage holds (title, date, size, new / newer / differs) and takes only the sessions you tick; a
  «select all» button pulls everything.
- A public repository named `claude-sessions` is refused.
- iCloud sessions that are not downloaded yet are reported instead of silently missed.
- Temporary files are hidden while a copy is in progress, so a cloud client never shows half a session.

## 0.3.0

- First Marketplace release: publisher `tkhmelovskyi`, icon, repository links, renamed to «Session Sync for Claude Code».

## 0.2.0

- Push limits: `claudeSessionSync.maxFileSizeMB` (default 90) leaves out sessions GitHub would reject and reports them,
  `claudeSessionSync.maxSessionAgeDays` (default 30, `0` = no limit) leaves out the long tail of old sessions.
- «Resume a session» no longer reads every transcript whole (4.7 s on 87 sessions / 524 MB before): the title is read
  from the head of the file.
- The picker orders sessions by the time of the last entry instead of the file's mtime, which after a pull is the pull
  time. A title is taken from the user's own text block, not from IDE context blocks.

## 0.1.0

- Commands: Push sessions, Pull sessions, Resume a session.
- Transcripts sync through a private git repository, keyed by the workspace's git remote so paths may differ per device.
- Diverged sessions are reported as conflicts and never overwritten.
