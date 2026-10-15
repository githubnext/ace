# Channel data

Channel data is permanent from the first dogfood channel. Updating or replacing Ace must preserve
it. pi-durable owns the database format, messages, runs, tool results, chats, and their state.

## Locations

| Data                                         | Location                                              |
| -------------------------------------------- | ----------------------------------------------------- |
| Stable channel catalog, databases, and lanes | `~/.local/state/ace/channels/<id>/`                   |
| Canary channel catalog, databases, and lanes | `~/.local/state/ace-canary/channels/<id>/`            |
| Development channels                         | `~/.local/state/ace-dev/channels/<id>/`               |
| A checkout's development build               | `~/.local/state/ace-dev-<hash>/channels/<id>/`        |
| Opened projects                              | `<ACE_HOME>/projects.json`                            |
| Preferences on macOS                         | `~/Library/Application Support/Ace/settings.json`     |
| Team directory URL                           | `<ACE_HOME>/directory.json`                           |
| Provider credentials and `ACE_SECRET`        | OS Keychain; never in channel metadata or preferences |

`ACE_HOME` overrides the host data directory. Canary and development preferences have the same
`-canary` and `-dev` suffixes. A source CLI uses the stable profile unless given `ACE_HOME`; target
the installed app's profile explicitly when backing it up.

Each channel directory holds `channel.json` and pi's `channel.sqlite`. Lanes are worktrees in the
project at `.lane/trees/<prefix>/<name>`, created by the lane CLI; a `lanes/` directory holds those
started before Ace used it. SQLite may have
committed data in `channel.sqlite-wal`, so copying only a live `channel.sqlite` is not a backup.
The socket, worker PID, and logs are process state, not durable channel content.

## Back up a local channel

Run `bun ace backup <channel> <new-directory>` from the checkout, or `ace backup` from an installed
CLI. The destination's parent must exist; the destination itself must be new. Backups include
archived channels and work without starting dormant workers or loading provider credentials.

The command uses SQLite's [VACUUM INTO](https://www.sqlite.org/lang_vacuum.html#vacuum_with_an_into_clause)
to capture a consistent snapshot, including committed WAL entries, while a worker continues
running. It opens the source read-only, checks the output's integrity, and writes:

- `channel.json`: the channel's identity, owner, project, optional initial model, and when its
  transcript last grew.
- `channel.sqlite`: all pi state at the snapshot point, if the channel has been opened before.
- `backup.json`: format version, source paths, creation time, and SHA-256 checksums. This file is
  written last to mark a complete backup. Failed backups remove only their newly created output.

The directory and files are private to the current OS user. Store backups with the same care as
the original chats and tool output. Hosted channels need backups from their hosting service;
their local catalog entry is insufficient.

Project files, lane worktrees (including uncommitted and untracked changes), repository Git data,
opened-project preferences, and Keychain items need their own backups. A channel snapshot keeps
the original working-directory paths; it is not a way to move lanes to another machine.

## Recover on the same machine

1. Keep the backup untouched and verify its files against the SHA-256 values in `backup.json`.
2. Stop Ace Helper in Settings and stop any command-line host for this profile. Ensure the
   affected worker has exited. Quitting only the desktop window leaves the helper running.
3. Preserve the current channel directory and its lane worktrees before changing anything. Keep
   the repositories and lanes at the paths recorded by the channel.
4. In the original channel directory, move the current `channel.json`, `channel.sqlite`, and any
   `channel.sqlite-wal` or `channel.sqlite-shm` aside together. Copy the backup's catalog record
   and database into their place. A never-opened channel backup has no database. Do not restore
   sockets or worker PID files, or leave old SQLite sidecars next to the restored database.
5. Start the helper again and open the channel. An unfinished run in the snapshot can resume;
   pi reports interrupted tools that cannot safely be rerun. Do not run a second copy of the same
   snapshot against the same lane paths.

Automated restore and moving backups across machines are not implemented.

## Upgrade contract

Keep existing channel IDs, entry kinds, document kinds, and path meanings stable. A format change
must include a versioned migration and a check using a copy of an existing channel. Preserve the
source backup until the new version has reopened its chats and resumed real model work.

pi-durable applies its SQLite schema migrations transactionally and refuses databases from a
newer schema. Ace must use those migrations rather than rewrite pi tables or replace a database.
For Ace-owned catalog or preference format changes, migrate old records explicitly before using
the new form. An unreadable or newer store must produce an actionable error, never an empty
replacement channel. Release validation must exercise existing data as well as fresh installs.

Catalog records and hosted-channel configurations use version 2. Readers migrate unversioned
(version 0) and version 1 records in memory, preserving their model, name, and all other fields.
The original name becomes an immutable lane branch prefix, and legacy names remain deliberate
names that agents preserve. Records are written as version 2 on the next save; unknown versions
are refused.

The channel's current name and rolling summary live in pi's version 1 `ace.metadata` session
document. Its first open seeds the name from the catalog without changing existing entries or
chats. Catalog names, summaries, and revision numbers are rebuildable listing projections; local
workers refresh them from committed metadata, and hosted channels send them to their workspace
on changes and reconnection. Renaming never moves an existing lane or changes its branch prefix.

Lanes live in pi's version 2 `ace.lanes` session document: each lane's chat, worktree path, and
base. A base is a full ref name, such as `refs/remotes/origin/main`, `refs/heads/release`, or
`refs/tags/v1`, or a commit when the requested base was an expression or a detached HEAD. A new
lane's starting base is also lane's own `lane.<branch>.base` Git setting, which `lane push` uses;
a later base change moves only the Diff. pi
migrates version 1 documents on read, keeping every lane's chat and path; the version 2 form is
written on the next lane change. Version 1 lanes have no base, so their Diff compares against the
locally known `origin/HEAD`, or the project's HEAD in a repository without origin, until a lane
switch names a base.

Channel access settings live in pi's version 2 `ace.settings` session document. `shared` controls
new collaborator agent invocations; `desktop` independently gates native desktop tools for every
chat and participant in the channel. New channels store the document at creation with `shared:
false`; an existing channel's missing document still means both are enabled. pi migrates
version 1 documents on read, preserving `shared` (including `false`) and adding `desktop: true`
for compatibility. The version 2 form is written on the next settings change. Neither migration
nor changing a setting rewrites chats, entries, or name/summary revisions; these gates are not a
shell security sandbox.

The October 3, 2026 credential-deferral check opened a backed-up version 0 channel with no keys:
its pi entries and selected model were unchanged. Fresh channels accepted human messages before
provider setup and retained their history through a worker restart. Adding a real Anthropic key
enabled the same worker to answer using the earlier human messages; removing it blocked only agent
invocation. The local Workers runtime also accepted new model-free hosted configurations and legacy
configurations with their original model.

The October 4, 2026 metadata check reopened isolated version 0 and version 1 copies of an existing
channel backup. All original pi entries remained byte-for-byte equivalent, both copies continued
with a real model, and renamed channels and rolling summaries survived worker restarts. The source
backup's checksums remained unchanged. Fresh-channel checks also confirmed that renaming leaves
existing lane branches intact and new lanes use the original branch prefix.

The October 6, 2026 lanes check opened an isolated copy of an archived Canary channel backup with
version 1 `ace.lanes` data. All three chats and their lanes resolved, and every original pi entry
stayed byte-for-byte equivalent. A lane switch stored version 2 without a base, and after a worker
restart the channel continued with a real model. The source backup's checksums remained unchanged.

The October 6, 2026 desktop-gate check reopened two isolated backups: an archived Canary channel
without settings, and a real-model channel whose version 1 sharing setting was turned off using
the old worker. They reopened with desktop tools enabled and their sharing choices preserved.
Changing desktop access persisted version 2 and survived a worker restart. Real Anthropic runs
confirmed desktop refusals in the owner's chat, a subagent, and an active collaborator run in a
second chat; re-enabling allowed a real native application inventory while sharing remained off.
All 175 original entries across both backups stayed byte-for-byte equivalent, both databases
passed integrity checks, and the source backup checksums stayed unchanged.

The October 14, 2026 unshared-default check created two channels with the previous build in an
isolated `ACE_HOME`: one never changed (no stored settings) and one turned unshared. With the new
build they reopened shared and unshared respectively, and the unshared channel's documents and
revisions matched its backup. Turning desktop tools off on the channel without stored settings
kept it shared across a worker restart. A new channel stored `shared: false` at creation, refused a
teammate's agent invocation, and kept the setting across a restart.
