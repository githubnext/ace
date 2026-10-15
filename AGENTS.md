# Working on Ace

Ace is a collaborative coding environment whose channels run on the team's own machines. Read
[architecture](docs/architecture.md) before changing a system boundary.

[docs/terms.md](docs/terms.md) defines Ace's vocabulary. Use those meanings, and correct anyone
(including the user) who uses a term differently. Change the terms file first when a meaning has
to change.

## Ownership

- `packages/channel` is the channel. It must stay runtime-neutral: no `node:*`, `bun:*`, or Workers
  imports. Storage, models, execution environments, and cross-channel delivery are injected.
- `apps/host` owns everything machine-specific: the CLI, channel workers, the catalog on disk, and
  local transport.
- Client protocol types live in `@ace/channel/protocol`. Clients import them; don't copy them.
- Durable channel state belongs to pi-durable. Don't add a second store for messages, runs, or
  chats.
- Existing channels are permanent data. Stored format changes need versioned migrations and a
  check against a backup of an existing channel; never reset a store to make an upgrade work.
  See [channel data](docs/data.md) for storage locations, backups, and recovery.

## Coding

- Read applicable [.claude/rules](.claude/rules/). They apply even when an agent does not
  auto-load Claude rule files.
- Write efficient code with clear ownership. Avoid speculative guards, fallback paths,
  abstractions, and dependencies.
- Don't write tests or examples unless asked. Every test must justify a shipped behavior or a
  failure it catches.
- Smoke-test with real runtimes, models, and provider credentials. No mocks.
- Prefer short names and lowercase kebab-case filenames, except tool-required names.
- Use tabs, double quotes, and strict TypeScript.
- Use `workspace:*` for internal dependencies and root catalogs for shared versions.
- Comments record reasons and constraints, never narration.
- Preserve Ace's project-first desktop flow and shared UI components. Opening a folder with
  Cmd+O adds a project; creating a channel inside that project is a separate action.

## Tracking and PRs

- [GitHub issues](https://github.com/githubnext/ace/issues) are the only tracker. Link and update
  relevant issues with the work. Group related work in meta issues with sub-issues ordered by
  priority.
- [Dogfooding](https://github.com/githubnext/ace/issues/5) means everyone who works on Ace does
  all Ace development in Ace. If Ace ships a surface (channels, diffs, terminals), use Ace's.
- File bugs and missing capabilities observed while dogfooding, or update the matching issue,
  and link them from the [dogfooding meta issue](https://github.com/githubnext/ace/issues/5).
- Open focused pull requests for changes. Keep independent work in separate PRs.
- Do each unit of work in its own lane, and open its PR as described in [Lanes](#lanes).
- PR bodies follow [the template](.github/pull_request_template.md), including when created with
  `gh pr create --body`. Always fill in **Built in Ace**: if anything outside Ace was used, name it,
  say what it was used for and why Ace couldn't do it, and link an existing or new issue for the gap.

## Lanes

Lanes are [lane CLI](https://lane.lukeed.com/usage/) worktrees, and lane also keeps this
repository's context memory in `.lane/` (see Context memory below).

- Ace ships lane and puts it first on its agents' PATH. Outside Ace, and for source runs of
  `bun ace`, install it with `curl -fsSL https://lane.lukeed.com | sh`. Run `lane install hooks`
  once per clone.
- In an Ace channel, start lanes with the channel's lane tool. It runs `lane new <channel>/<name>`
  from origin's fetched default branch, so the lane is at `.lane/trees/<channel>/<name>` with
  ignored files such as `node_modules` cloned by reference. Elsewhere, run `lane new <name>`, never
  a bare `git worktree add`.
- To open a PR: commit, run `lane check` and resolve every note it lists, `git fetch origin`, then
  `lane push` and `gh pr create`. `lane push` rebases onto the lane's base, promotes pending notes
  and `Why:` trailers, and commits `.lane/`; a plain `git push` leaves them behind. A lane from a
  bare `lane new` has local `main` as its base, so pass `--base origin/main` there.
- Merge without `--delete-branch`, which would try to delete the branch the lane has checked out.
  `lane prune` then removes a lane once its remote branch is gone or local `main` contains its work,
  even after a squash merge. It skips lanes with uncommitted changes, pending notes, or later
  commits. Deleting a channel leaves its lanes for `lane prune` or `lane rm`.

## Commands

```sh
bun install
lane install hooks  # once per clone; captures `Why: <path>[#<anchor>] | <text>` commit trailers as notes
bun ace --help   # CLI
bun ace tabs --json  # discover open windows and tabs before targeting a tab rename
bun ace backup <channel> <new-directory>  # local or hosted channel data; `ace restore` adds it as a new channel
bun types        # type checks
bun run ci       # dprint + oxlint
bun run fix      # apply formatting and lint fixes
bun desktop ci canary  # signed desktop build from a clean, pushed lane
```

An Ace channel can build releases with its shell tool; see [desktop updates](docs/updates.md)
for status, downloads, and explicit publishing. Signing credentials stay in GitHub.

## Commits

Use `type(target): verb-led description` with `chore`, `fix`, `feat`, or `break`. The target is
the folder name (`channel`, `host`); omit it for repository-wide changes. Never commit secrets or
credentials.

When a change rests on a constraint later edits must keep, add a trailer such as
`Why: packages/channel/src/lanes.ts#function lanes | <what must stay true>`. Name what must stay true, not
what changed; `lane anchors <path>` lists valid anchors.

<!-- lane:protocol -->

## Context memory

- Before editing a file, read `.lane/memory/<path>/` if it exists, or run `lane why <path>`.
- Record non-obvious findings with `lane note add <path> -a <anchor> "..."`.
- Do not edit `.lane/` by hand; landing manages it.
- Land with `lane merge`, or `lane push` where trunk is protected, then `lane prune` once it merges.
- Detailed workflow lives in `.agents/skills/lane/SKILL.md`; run `lane install skill` if it is absent.

<!-- /lane:protocol -->
