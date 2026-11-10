# Changelog

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
