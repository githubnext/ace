# Terms

These definitions are binding for code, docs, issues, and conversation. When someone uses a term
differently, correct the usage or change this file first.

## Places

**Team**:
The people and machines on one tailnet. The tailnet is the sole authority for team membership
and collaboration access. Ace has no separate accounts, invitations, or team access controls.
_Avoid_: org, workspace

**Host**:
One machine running Ace's host process. It owns and runs its channels.
_Avoid_: server, node, VM

**Hosted channel**:
A channel that lives in a cell deployed by the team instead of on a host. Its tools run on its
workspace. Hosted describes where the channel runs; Ace does not operate a hosting service.

**Workspace**:
The host that runs a hosted channel's tools, from lanes on its own disk. It connects out to the
channel. Not a project or a checkout.

**Project**:
A named set of one or more repositories or local folders that a team works on. Many hosts can
hold checkouts of the same project. Today a project is a single repository or folder; channels
start in it once it is a Git repository with a commit.
_Avoid_: repo (when you mean the project), workspace

**Directory**:
The team's shared cell listing its projects, hosts, and where each channel lives. It holds no
channel content.
_Avoid_: relay, hub

**Lobby**:
A project's shared cell for presence, notifications, and channel lifecycle. A lobby is not a
channel.
_Avoid_: lobby channel, lobby session

**Cell**:
A named Durable Object (isolated code with private SQLite) run by Cloudflare or celld. Cells hold
shared objects such as the directory and lobbies, and hosted channels.

## Channels

**Channel**:
The durable unit shown in the sidebar, backed by one pi Session and containing one or more chats.
A local channel runs as one worker process on its host; a hosted channel runs in a team-deployed
cell. The UI calls it a channel.
_Avoid_: session, room, thread

**Chat**:
One conversation inside a channel, with its own transcript. Most channels have one chat. A chat
can be the child of another chat in the same channel; killing a parent kills its children.
_Avoid_: session, thread, conversation (except for pi's conversation record)

**Tab**:
A view inside a channel: Chat, Diff, or Terminal. A new tab starts blank until one is chosen. A
Chat tab shows one chat; other tabs are views, not durable units. File
([#22](https://github.com/githubnext/ace/issues/22)) and Browser Preview
([#16](https://github.com/githubnext/ace/issues/16)) tabs are planned.

**Lane**:
An isolated Git worktree for one unit of work, such as "implement auth". A chat may start or
switch to another lane for a new piece of work, and another chat may continue an existing lane.
At most one chat writes to a lane at a time. Lanes are the lane CLI's lanes: `lane new` creates
them and `lane push` lands them.
_Avoid_: task (pi's term for a durable state machine), workspace, branch (a lane has one)

**Participant**:
A human or an agent in a channel.

**Message**:
What participants see in a chat. Messages are stored as pi entries.

**Entry**:
pi's immutable transcript record. Use it only when discussing storage or model context.

## Agents

**Agent**:
A model-driven participant in a chat: a model, instructions, and tools, run by a harness.
_Avoid_: bot, Codex/Ace (as a generic name)

**Model**:
A specific provider model, such as `claude-opus-5-5` or `gpt-6-astra`. A chat may use a different
model for each run.
_Avoid_: agent, provider

**Harness**:
The code that runs an agent's loop. The native harness is pi-durable; Claude Code and Codex are
external harnesses.
_Avoid_: runtime, provider

**Turn**:
One model response and the tool calls it makes.

**Run**:
Everything from one input to its final answer: one or more turns. "Use Opus for this message"
selects the model for a run.
_Avoid_: turn (when you mean a run)

**Subagent**:
An agent working in a child chat of the same channel. Agents in different channels coordinate
only by messaging each other, never by owning each other's work.
_Avoid_: child channel, delegation

## States and actions

**Stop**:
Abort the current run. The chat stays usable.

**Kill**:
Stop all work in a chat or channel now, including child chats and processes. Nothing is
deleted.

**Archive**:
Put a channel away. An archived channel keeps its history and can be resumed.

**Delete**:
Remove a channel permanently.

**Dormant**:
A channel whose worker is not running while its host is reachable. Opening it wakes it.
_Avoid_: idle, asleep, offline

**Offline**:
A host, and therefore its channels, that cannot be reached.
