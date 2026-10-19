# Hosted compute pilot

This is the experiment in [#216](https://github.com/githubnext/ace/issues/216): a hosted channel
keeps its pi Session in a Durable Object while a team-deployed Cloudflare Container runs its
workspace. The container holds a Git clone, lanes, and the tools that work on them. The team
deploys both in its own account; Ace operates no hosting service.

The pilot reuses [hosted channels](../channel/src/object.ts) and the existing
[workspace protocol](../../packages/channel/src/workspace.ts). It adds a compute controller,
a Linux runner, and explicit filesystem checkpoints. Read the
[architecture](../../docs/architecture.md#hosted-channels) and [terms](../../docs/terms.md)
before extending those boundaries.

## Deploy

Use a Cloudflare account with Containers access, a running Docker engine, and an authenticated
Wrangler CLI. The [configuration](wrangler.jsonc) deploys the `ace-compute-pilot` Worker, one
`HostedChannel` Durable Object class, and one `Compute` class with a container binding. Each
workspace is one container. There is **no enforced deployment-wide instance cap**:
Wrangler rejects `max_instances` with the `durable_object` scheduling policy used here.

From the repository root:

```sh
bun install
cd services/compute
bunx wrangler login
bun run deploy
bunx wrangler secret put ACE_SECRET
bunx wrangler secret put TAILNET
bunx wrangler secret put OPENAI_API_KEY
bunx wrangler secret put GITHUB_TOKEN
```

Each `secret put` reads its value from stdin; enter it at the prompt or pipe it from your secret
manager. No secret value belongs in a command argument or repository file. Use the provider's
usual key name, such as `ANTHROPIC_API_KEY` instead of `OPENAI_API_KEY`, for the model you intend
to run. `GITHUB_TOKEN` is optional for a public clone, and required when that repository needs
authentication or the agent will push. Give it access to the repository being used.

`bun run deploy` bundles [runner.ts](runner.ts), builds the [Docker image](Dockerfile), and
deploys the Worker. The image supplies Bun, Git, curl, lane, tar, and gzip. Add any further
project toolchain to that image. Model requests use Worker secrets; provider keys are not sent
to the container.

## Public API

All routes require `Authorization: Bearer` with HMAC-SHA256 of the deployment's `ACE_SECRET` over
its `TAILNET`, the MagicDNS suffix of the one tailnet it serves (`@ace/directory/credential`). Use the HTTPS
Worker URL returned by deployment. Choose a **fresh channel ID** matching `[a-z0-9-]{1,64}`;
this pilot does not move an existing channel or import its workspace.

The controller serializes operations for each ID. Every POST has a JSON body, including `{}`
when it takes no arguments. Errors return JSON with an `error` field, generally with HTTP 409;
authentication failure is HTTP 401.

| Method | Route                        | Body and result                                                                                                                                                                                                                                                                                                      |
| ------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/workspaces/:id/init`       | `repository` is a GitHub HTTPS clone URL without credentials. `owner` is the channel's Ace user; `author` contains Git `name` and `email`. Optional `size` defaults to `standard-1`; optional `model` is the channel's `{ provider, modelId }`. Creates settings and a fresh hosted channel; does not start compute. |
| POST   | `/workspaces/:id/import`     | Takes `init`'s fields plus a moved channel's `snapshot`, the absolute `project` path its records name, and `lanes` (`path`, `branch`, optional lane `base`) to check out from pushed branches. Imports the channel inactive for the host to activate; retrying is allowed until the first start.                     |
| POST   | `/workspaces/:id/start`      | `{}` or `{ "size": "standard-2" }`. Starts the container, restores the latest checkpoint when present, configures the runner, and makes the channel available.                                                                                                                                                       |
| GET    | `/workspaces/:id/status`     | Returns container state, settings, checkpoint manifest, frozen state, and runner status. `/workspaces/:id` is equivalent.                                                                                                                                                                                            |
| POST   | `/workspaces/:id/exec`       | `{ "command": "git status --short", "cwd": "." }`. Requires an idle channel, freezes admission, runs the administrative command, then reconnects and thaws. `cwd` defaults to `/workspace/project`; relative paths resolve beneath it. Returns `exitCode`, `output`, and `truncated`.                                |
| POST   | `/workspaces/:id/checkpoint` | `{}`. Requires an idle channel, freezes admission, disconnects and drains its workspace, saves a checkpoint, then reconnects and thaws the channel.                                                                                                                                                                  |
| POST   | `/workspaces/:id/resize`     | `{ "size": "standard-2" }`. Checkpoints, destroys the container, starts the selected size, restores the files, then reconnects and thaws.                                                                                                                                                                            |
| POST   | `/workspaces/:id/stop`       | `{}`. Checkpoints and destroys the container, then thaws the channel so chat remains accessible.                                                                                                                                                                                                                     |
| POST   | `/workspaces/:id/resume`     | `{}`. Reconnects and thaws a frozen pilot whose startup completed. If startup is incomplete, retry `start` instead.                                                                                                                                                                                                  |
| DELETE | `/workspaces/:id`            | Destroys the container without a checkpoint, deletes the hosted channel and its pi state, then the stored settings and checkpoint. Returns `{ "deleted": true }`, including when nothing remains to delete.                                                                                                          |

An initialization body has this shape:

```json
{
	"repository": "https://github.com/OWNER/REPOSITORY.git",
	"owner": "person@github",
	"author": { "name": "Git author", "email": "person@example.com" },
	"name": "brisk-harbor",
	"size": "standard-1"
}
```

`owner` is the Ace user who owns the channel, as their host names them; `author` is the Git
identity for commits in the container. Optional `name` and `prefix` default to the ID, and
`named` says the name was chosen deliberately. A `start` that fails can be repeated.

**Each cloud channel is its own container.** The desktop app's Run in cloud creates one workspace
per channel, and nothing limits how many a team starts.

The accepted sizes are `standard-1`, `standard-2`, `standard-3`, and `standard-4`. Resizing is
a **restart with filesystem restoration**, so it requires an idle channel and stops processes.

The controller uses Cloudflare's [native container API](https://developers.cloudflare.com/containers/api/durable-object-container/).
Consult the current [instance limits](https://developers.cloudflare.com/containers/platform/limits/)
when choosing an allocation.

After `start`, wait for `runner.connected` in status before invoking the agent. The normal
channel WebSocket remains at `/channels/:id`, using the same bearer authentication and
[typed channel protocol](../../packages/channel/src/protocol.ts): use `watch` for events,
`ask` with the owner's author identity to invoke, and `wait` for the admitted submission.
The controller's `exec` route is for administration; it does not create a model run or a
channel transcript entry. Freezing prevents channel tools from changing files concurrently
with that administrative command; a busy channel refuses the operation. Its command timeout
is 240 seconds, and it returns the last 65,536 characters of combined output with a truncation
flag.

If startup or restoration fails, the controller preserves the saved checkpoint, destroys the
incomplete replacement container, and leaves the channel frozen. It refuses `exec`,
`checkpoint`, `stop`, and `resize` until startup completes; retry `start` to recover. Use
`resume` only when startup completed, compute is still running, and the channel remains
frozen; it re-establishes the freeze before reconnecting and thawing. For stopped compute,
use `start` to restore it. `exec`, `checkpoint`, `stop`, `resize`, and `resume` refuse while
compute is stopped.

## Checkpoints and lifecycle

[checkpoint.ts](checkpoint.ts) archives the entire `/workspace` as a gzip-compressed tar,
including the main clone's `.git`, lane worktrees, branches, indexes, and tracked, untracked,
and ignored files. Directories named `node_modules` are excluded; other files are preserved.
Restore uses the same absolute paths because Git worktree metadata refers to them, and refuses
to overwrite a nonempty `/workspace`. Reinstall dependencies after restoration.

The compressed archive is limited to **16 MiB**. The `Compute` Durable Object stores it in
**64 KiB KV chunks**, with a version-1 manifest containing a generation ID, chunk count,
byte count, SHA-256 digest, and timestamp. A transaction replaces the previous generation;
only the latest checkpoint is retained. Restoration verifies the digest before extraction.
This is a filesystem checkpoint, not another store for messages, runs, or chats: pi remains
their only durable store in the channel's separate Durable Object.

Checkpointing requires the channel to be idle. The runner disconnects its workspace and drains
tool calls, then [checks Linux processes](quiescence.ts) against its startup baseline. A
remaining process causes refusal with its PID; the check does not kill it. **Stop development
servers and other background processes before checkpoint, resize, or stop.** Daemon processes
are not restored. A refused checkpoint preserves the live filesystem and attempts to reconnect
the workspace; inspect status and use `resume` if it remains frozen.

The controller sets a **six-hour container inactivity timeout**. It does not checkpoint when
that timeout fires, and there is no automatic checkpoint or wake policy. **Call `stop` before
finishing the pilot and verify `running: false`.** A crash or timeout can lose work since the
last checkpoint. `start` restores the last saved checkpoint; if an earlier successful start
has no checkpoint, it refuses to silently replace the lost workspace with a fresh clone.

## Boundaries and limitations

- The app's Run in cloud calls `init` and `start`; a cloud channel's menu offers Stop compute
  and Start compute, and deleting the channel calls `DELETE`. Other lifecycle operations are
  manual HTTP calls. There is no agent tool for starting or resizing this compute yet.
- The runner serves files and shell commands. Native desktop tools, browser tools, and image
  inspection are omitted. The existing hosted-channel restrictions, including cross-channel
  messaging, still apply.
- The container's port 8080 is an internal controller endpoint. Its setup, execution, and raw
  checkpoint/restore routes have no independent authentication and must not be exposed publicly.
- The team service secret remains in runner memory. Git authentication uses a repository-scoped
  helper and a mode-0600 token file under `/run`, outside `/workspace`; setup recreates it after
  restore. Shell environments and Git configuration contain the helper path, not the token.
  Processes share the same trusted OS user, so this is not a credential security boundary against
  the agent's shell. Response redaction only reduces accidental disclosure.
- Checkpoints are not secret scanning. Any secret deliberately or accidentally written into a
  tracked, untracked, or ignored project file is included, apart from excluded dependencies.
  Provision credentials outside `/workspace` and do not put authenticated URLs in Git config.
- The image, archive limit, and manual recovery are proof-of-concept choices. Keeping the
  number of running containers in check is an operator responsibility.
  Production scheduling, unattended recovery, backup retention, and multi-workspace ownership
  remain separate work. The next steps are [filesystem durability](https://github.com/githubnext/ace/issues/413)
  and [agent-visible sizing and resize requests](https://github.com/githubnext/ace/issues/414),
  tracked under [#216](https://github.com/githubnext/ace/issues/216).

## Evidence

On 2026-10-15, the isolated Cloudflare deployment ran a full clone of `githubnext/ace` in a
`standard-1` container. A real Claude Sonnet 4.6 run used `lane`, `read`, `write`, and `bash`,
then pushed `compute-20261015/cloud-proof` at
[a5b04b5fe36156bf8116ef538d84d0626e75650f](https://github.com/githubnext/ace/commit/a5b04b5fe36156bf8116ef538d84d0626e75650f).
The remote branch ref was verified. The runtime reported Linux x86_64, kernel
`6.18.54-cloudflare-microvm-2026.9.16`, Bun 1.4.0, and lane 0.1.0.

The live lifecycle checks recorded these wall-clock times. Each is **one sample** from a
small file-editing task, not a full Ace build, a performance benchmark, or a latency guarantee.

| Operation                                                            | API time | Workspace connection                       |
| -------------------------------------------------------------------- | -------- | ------------------------------------------ |
| Initial `standard-1` start, including Git clone                      | 8.030 s  | Connected before the model run             |
| Checkpoint                                                           | 1.570 s  | Reconnection not separately timed          |
| Resize `standard-1` → `standard-2`, including checkpoint and restore | 3.694 s  | Connected about 1 s after the API returned |
| Stop, including checkpoint                                           | 1.188 s  | Container stopped for this lifecycle step  |
| Start from the saved checkpoint                                      | 1.909 s  | Connected about 1 s after the API returned |

The initial checkpoint was 11,881,708 bytes in 182 KV chunks. A deterministic fingerprint of
Git status, cached and working-tree diffs, the index hash, file SHA-256 hashes, and worktree
metadata matched exactly before resizing, after resizing, and after the stop/start cycle.
The fixture included staged and unstaged changes to the same file, an untracked text file,
and an untracked binary file in the lane.

A second real Sonnet 4.6 run continued the same pi conversation and lane after restoration,
using tools to verify the commit, diffs, and file hashes. A request to resize to `standard-3`
while that run was active returned HTTP 409 because the channel was busy; the run completed.
The channel usage report estimated US$0.3071 for the two runs; this is an estimate rather
than a provider invoice.

The live process check refused checkpointing with HTTP 409 while a detached `sleep` remained.
The previous checkpoint generation was unchanged, the container stayed running, and the
channel was thawed. After the known process was stopped, the final checkpoint and stop
succeeded. Repeated stop and execution requests returned HTTP 409 without refreezing the
stopped channel; an unauthenticated status request returned HTTP 401.

The experiment ended with `running: false` and `frozen: false`, and a final checkpoint of
11,881,603 bytes in 182 chunks. Channel information remained readable with the same chat,
working directory, and lane. The deployment's `GITHUB_TOKEN` Worker secret was then deleted.

The resized runtime reported `/proc/meminfo` `MemTotal` increasing from 4,401,424 to
6,498,576 kB, and `df -h /` showed root filesystem capacity increasing from 7.5G to 12G.
`nproc` reported 1 at both sizes; CPU quota was not measured, so this does not establish
a CPU allocation or throughput change.

Local Linux Docker checks passed for a real public HTTPS clone, lane CLI worktree creation,
staged and untracked edits, bounded command output, checkpoint refusal before disconnection,
and checkpoint restoration into a fresh container. Routine environment and Git configuration
output saved into the project contained no raw or encoded Git token; the credential helper
worked, and its token file was absent after restoration without credentials.

The checkpoint checks also compared complete file manifests, permissions, symlinks, Git refs,
indexes, and worktree metadata, including ignored files and nested dependency exclusions.
The process check refused a checkpoint while a detached writer remained, and passed after
that writer's process group was stopped.
Runner TypeScript and lint checks passed. These local checks complement the live results above.

Implementation used Codex because Ace cannot yet run that harness
([#9](https://github.com/githubnext/ace/issues/9)). The final runner integration checks ran through
an Ace terminal. An earlier check used the external terminal while the installed host was
unavailable; the isolated source host was used once available.
