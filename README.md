# Session Sync for Claude Code

**English** · [Українська](https://github.com/htar/claude-session-sync/blob/main/README.uk.md) · [Español](https://github.com/htar/claude-session-sync/blob/main/README.es.md) · [简体中文](https://github.com/htar/claude-session-sync/blob/main/README.zh-CN.md)

> Unofficial community extension. Not affiliated with or endorsed by Anthropic. «Claude» and «Claude Code» are trademarks of Anthropic.

Continue a Claude Code session on another device. The extension moves your session history between your computers
without a server of its own: the data travels through something you already use.

## How to use

Commands live in the Command Palette: **Cmd+Shift+P** (Windows and Linux: Ctrl+Shift+P), then type "Claude Sync".

### On the device where you worked

1. Open the project in VS Code.
2. Run **Claude Sync: Push sessions**.
3. The first time, choose how sessions travel (see below). The extension does the rest.

### On the device where you continue

1. Install the extension and open **the same project** (same git remote).
2. Run **Claude Sync: Pull sessions** and choose the same method.
3. Choose **which device** to import from (skipped when only one other device has exported).
4. A list of that device's sessions appears: title, date, size and status. Tick the ones you need, or press "Select all".
5. Run **Claude Sync: Resume a session**, pick one, and a terminal opens with `claude --resume`.

### Rules of thumb

- **Push before you leave a device, Pull before you start on another.**
- Do not continue one session on two devices at once: the extension reports a conflict and overwrites nothing.
- A cloud service does not deliver files instantly: if Pull finds nothing, wait a minute and try again.
- Every device exports to its own folder (named after the device, see `claudeSessionSync.deviceName`), so devices never overwrite each other and you always pick the source yourself.
- Remove what a device exported: **Claude Sync: Delete exported sessions** (asks for confirmation; your own sessions on your devices are never touched).
- Click **Claude Sync** in the status bar (or run **Claude Sync: Manage connection**) to change the method or disconnect. If the storage cannot be reached or you are not signed in, the extension offers to sign in again or pick the storage again (on a new device, pick it once: Dropbox is found even on a non-standard drive).
- Change the method any time: **Claude Sync: Choose sync method**. To forget it altogether: **Claude Sync: Disconnect storage** (nothing is deleted from the storage or from your device).

## Ways to sync

| Method                      | You need                                                                                    | What happens                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub**                  | A GitHub account                                                                            | One-click sign-in through VS Code; a private `claude-sessions` repository is created for you. A public one with that name is refused. |
| **Cloud storage**           | iCloud Drive, Dropbox, OneDrive, Google Drive, MEGA, pCloud, Box, Proton Drive or Nextcloud | You pick the storage from a list, a "Claude Sessions" folder is created at its root, and the cloud client delivers the files.         |
| **Your own git repository** | A private repository you can reach (SSH or a credential helper)                             | Put its address in `claudeSessionSync.repoUrl`.                                                                                       |

## Settings

All settings apply per machine: set them in User settings.

| Setting                               | Default   | What it does                                                              |
| ------------------------------------- | --------- | ------------------------------------------------------------------------- |
| `claudeSessionSync.mode`              | empty     | `github`, `folder` (cloud storage) or `git`. Empty = ask on first use.    |
| `claudeSessionSync.deviceName`        | host name | This device's name in the storage: other devices pick it when importing.  |
| `claudeSessionSync.repoUrl`           | empty     | Address of the private repository for the "own git" method.               |
| `claudeSessionSync.maxFileSizeMB`     | `90`      | Sessions larger than this are not pushed (and you are warned).            |
| `claudeSessionSync.maxSessionAgeDays` | `30`      | Only sessions modified within the last N days are pushed. `0` = no limit. |

## Security

- Sessions contain your code, command output and **possibly secrets**. Send them only to private storage: a private
  repository or your own cloud. The extension warns you before the first Push.
- The GitHub method asks for the `repo` permission (GitHub has nothing narrower for private repositories). The token
  stays inside VS Code, and the extension's code is open.
- With "Optimize Mac Storage" on in iCloud, some sessions may not be downloaded to this Mac yet. The extension tells
  you how many and what to do.

## Limitations

- Sessions of the current project (the first opened folder) are synced, not all projects at once.
- Syncing is manual; there is no background mode.

Source code and issues: https://github.com/htar/claude-session-sync
