# Privacy Policy

**Session Sync for Claude Code** (the «extension») is an open-source Visual Studio Code extension that copies your
Claude Code session history between your own computers. Source code: https://github.com/htar/claude-session-sync

_Last updated: 2026-11-14._

## The short version

- The extension has **no server of its own**. We, the author, **do not receive, store or see** your sessions, your
  files, your account details or any usage data.
- Your sessions go **only to the storage you choose** (your GitHub repository, your Dropbox, OneDrive or Google Drive,
  a folder on your computer, or your own git repository) and back to your other computers.
- The extension contains **no analytics, no telemetry and no advertising**.

## What the extension handles

| Data                                                                                                                 | Why                                              | Where it goes                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code session files (`~/.claude/projects/…`), which can contain your code, command output and possibly secrets | To copy them to your other computers             | Only to the storage you picked, under your own account. Optionally encrypted with your passphrase before they leave the computer. |
| Sign-in tokens (GitHub, Dropbox, Microsoft, Google)                                                                  | To read and write in your storage on your behalf | Kept in VS Code's secret storage on your computer (the operating system keychain). Sent only to the service they belong to.       |
| A device name and an installation id                                                                                 | To tell your computers apart in the storage      | Stored in the storage next to your sessions.                                                                                      |
| The git remote address of your project                                                                               | To match the same project across computers       | Used as a folder name in the storage.                                                                                             |

## Google user data

Signing in with Google is optional and only used by the «Google Drive (direct)» method.

- The extension requests one scope: `https://www.googleapis.com/auth/drive.appdata`. It gives access **only to the
  hidden application data folder** the extension itself creates in your Google Drive. The extension cannot see, read
  or change any other file in your Drive.
- Data from that folder is used for one purpose: to store and retrieve your Claude Code sessions so you can continue
  them on another computer.
- The data is **not** transferred to us or to anyone else, **not** used for advertising, **not** used to train
  machine-learning models, and **not** read by humans.
- The extension's use and transfer of information received from Google APIs adheres to the
  [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including
  the Limited Use requirements.

Dropbox, Microsoft OneDrive and GitHub are used the same way: only for the files the extension itself stores for you
(an app folder, or your own private repository), and only on your request.

## Your control

- **Disconnect** (command «Claude Sync: Disconnect storage») signs the extension out and removes its local cache and
  the saved sign-in. It does not delete your own sessions.
- **Delete exported sessions** removes what one computer stored in your storage.
- You can revoke the extension's access at any time in your account: Google (myaccount.google.com → Security →
  Third-party access), Dropbox (Settings → Connected apps), Microsoft (account.microsoft.com → Privacy → Apps and
  services), GitHub (Settings → Applications).
- Removing the extension stops all access. Files already in your storage stay there until you delete them.

## Security

Sessions are sent over HTTPS or SSH. The extension checks sessions for API keys and tokens before a push and offers
to leave them out, and can encrypt stored sessions with a passphrase (AES-256-GCM). Because sessions can contain
sensitive material, send them only to private storage that you control.

## Children

The extension is a developer tool and is not directed at children.

## Changes and contact

If this policy changes, the new version is published in this repository with a new date. Questions or requests:
https://github.com/htar/claude-session-sync/issues
