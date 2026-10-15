# Desktop updates

Ace ships one application bundle containing the UI, Ace Helper, and the channel worker runtime.
[Sparkle 2](https://sparkle-project.org/documentation/) verifies and replaces that whole bundle.
Its installers are temporary processes; Ace Helper remains the persistent background service.
The current release target is Apple silicon on macOS 15 or later.

## Experience

Ace checks automatically every six hours while open and shows an update notification. Settings →
Updates and Ace → Check for Updates share version, progress, and error reporting. Users can turn
automatic checks off. **Install and Restart** is an explicit action.

Automatic downloads and installation on ordinary quit are disabled. Quitting normally leaves
Ace Helper running. After choosing to install, this machine's channels and workspace tools pause
while the update downloads and installs. Unfinished local channel work resumes automatically after
restart. Terminal shells close and do not resume. Hosted channels stay reachable, but their
workspace disconnects during the update.

Updates require a running, enabled Ace Helper. Command-line hosts and helpers disabled in macOS
are left alone. Development builds have no feed. The first Sparkle-enabled build requires a manual
installation; previous builds do not understand this feed. Stop Ace Helper before manually
replacing an existing installation, then reopen Ace. Builds predating resume receipts need their
channels reopened once to resume any unfinished runs.

## Handoff and recovery

The desktop's authenticated native bridge owns the updater. Two owner-only loopback requests
coordinate the host:

1. `update-prepare` blocks new work, drains admitted requests, closes workspace tools, and suspends
   local workers. It acknowledges only after their identified processes exit. Stale PID files are
   never used to choose a process to signal.
2. `update-cancel` resumes workers and workspace links if the update ends before the helper exits.

Before stopping workers, the host atomically writes their IDs to `$ACE_HOME/resume.json`. On
startup it wakes those workers and removes successfully resumed IDs. Failed starts remain in the
receipt and are logged. Ordinary helper restarts use the same mechanism. There is no second store
for tasks or messages: all resumable work remains in pi-durable, and shutdown never writes abort
marks.

The desktop writes `$ACE_HOME/desktop-update.json` before preparing the host. It unregisters Ace
Helper and waits for its process to exit before allowing Sparkle to start a download or installer.
This prevents an old helper from spawning workers from a replaced bundle. The relaunched app
restores the helper and removes the desktop receipt after recovery.

Failures and download cancellation resume the helper while Ace is open. If the desktop is forcibly
terminated or power is lost, opening Ace recovers the receipt. A recovery error remains visible
with a **Resume Ace Helper** action. Keeping workers running during a download is deferred until
there is an equally safe installer handoff; a slow download currently means a longer pause.

Projects, databases, preferences, logs, and Keychain credentials are outside the app bundle.
Installed apps need neither `.env` nor a checkout. Stable and canary have separate identifiers,
helper registrations, ports, data directories, preferences, and Keychain services.
Stable and development builds use the original green Ace icon; canary uses the same artwork in
yellow. Both icon sets include all macOS sizes and are compiled into the signed application bundle.

## Build and verification

Electrobun 1.18.1's updater deletes the current app before moving its replacement, does not
authenticate its metadata or archive, and has no helper handoff. Ace instead extracts the actual
application from Electrobun's build archive; its self-extracting wrapper and `Updater.applyUpdate()`
are unused.

The Sparkle SDK and Electrobun CLI downloads are pinned by version and SHA-256. Native desktop
inspection comes from [desktop-tools](https://github.com/githubnext/desktop-tools), pinned to one
commit in the root `desktop` catalog. Its build tool resolves Peekaboo 4.8.0 and its dependencies
from the package's `Package.resolved`, applies its pinned patch stack, and builds with Swift 6.2 or
newer in `apps/desktop/native/.build/desktop-tools`; CI selects Xcode 26.2. Ace builds only its
project picker, `libAceProject.dylib`, from `apps/desktop/native/project.swift`. Update the native
code in that repository, then move the catalog pin.

The bundle contains `libDesktopTools.dylib`, `ace-desktop-client` (the package's
`desktop-tools-client`), and `libAceProject.dylib`, with needed Swift runtime libraries discovered
from their compiled dependencies. It does not ship Peekaboo's standalone app
or CLI. Sparkle's license and the native dependencies' licenses and notices are included in
Resources. The build also writes `notices.html` there, covering every npm package the web, desktop,
and helper bundles contain (from their module graphs), Bun, Electrobun's native tools, and those
native notices; licenses with no package file are vendored in `apps/desktop/licenses`. About Ace
links to it through `Credits.html`, opening the installed bundle's copy. Code is signed inside out,
including the Swift runtimes, Ace Helper, and Sparkle's nested installers. The desktop client uses the app's actual bundle identifier followed by `.desktop-client`;
the embedded bridge accepts only a client with that identifier and the app's Apple Team ID. Paths
containing spaces are passed as individual command arguments.

A release requires Developer ID signing, hardened runtime, notarization, and stapled tickets for
both the app and disk image. The image contains the app and an Applications shortcut. Sparkle
signs its archive and feed with Ed25519; the app embeds only the public key and enables
`SURequireSignedFeed` and `SUVerifyUpdateBeforeExtraction`. Feed URLs must use HTTPS.
Sparkle's 20-day feed-signing recovery window remains enabled for lost-key recovery; archive
verification and Apple signatures still apply during that recovery path.

Sparkle orders updates by `CFBundleVersion` and does not offer ordinary downgrades, so bundle
versions must only increase within a channel. Revert a bad release by shipping a fixed build under
a higher version. The initial pipeline uses complete disk images; delta generation is deferred.

| Channel | `CFBundleVersion` (feed, tag, archive) | `CFBundleShortVersionString` (shown) |
| ------- | -------------------------------------- | ------------------------------------ |
| stable  | `0.0.46`                               | `0.0.46`                             |
| canary  | `0.0.46.<build>`                       | `0.0.46+<sha7>`                      |

Increment `apps/desktop/package.json` for each stable release. Canary appends `ACE_BUILD_NUMBER`,
which the workflow sets to its run number, so canary can ship another build without a package
bump. A fourth numeric part orders after the three-part canaries through 0.0.46, and a package bump
orders after every build of the previous version. The commit SHA appears only in the shown version,
About Ace, and Settings → Updates, because commits do not order. Renaming or recreating the
workflow restarts its run numbers, so bump the package version alongside that change.

## Hosting and publishing

The source repository is public. Each published desktop version has a GitHub release at its exact source revision,
tagged `desktop-v<version>` or `desktop-canary-v<version>.<build>`, with the signed DMG attached.
Canary releases are named `Ace Canary <version>+<sha7> (<version>.<build>)`. Canary
releases are published prereleases, not drafts or GitHub's latest stable release. Stable releases
are full releases marked as GitHub's latest. Each release body lists the pull requests merged since
the channel's previous published version, generated by GitHub. Build-only runs create workflow artifacts but no
GitHub release.

Both channels read the single version in `apps/desktop/package.json`; tags, archives, feeds, and
bundle identifiers are per channel, so canary and stable can ship the same version from one commit.
Stable keeps plain `x.y.z` and builds only commits on `main`: the `desktop-stable` environment
admits only runs dispatched from `main`, and the workflow's first step refuses a `revision` that
`main` does not contain.
Stable `Ace.app` shares the CLI's data directory, Keychain service, and port 4140, so a stable Ace
Helper conflicts with `bun ace serve` on the same machine. Canary data does not carry over to stable.

Signed release artifacts also go to a public Cloudflare R2 bucket over HTTPS for Sparkle updates.
The app contains no GitHub or Cloudflare credential. Publishing uses R2's bucket-scoped S3
credentials through Bun; it does not need an account-wide Cloudflare API token. GitHub publishing
uses the GitHub CLI with repository contents-write permission; CI supplies its workflow token only
to the publishing step.

Releases currently publish under the bucket's `/ace` prefix through its R2 public development URL.
Move to a custom download domain before wider distribution: Cloudflare's
[public development URL](https://developers.cloudflare.com/r2/buckets/public-buckets/#public-development-url)
is rate-limited and intended for development traffic.

```text
stable/macos-arm64/appcast.xml
stable/macos-arm64/ace-0.0.3-macos-arm64.dmg
canary/macos-arm64/appcast.xml
canary/macos-arm64/ace-canary-0.0.46.<build>-macos-arm64.dmg
```

Images have immutable URLs and one-year cache headers. Retain old images for clients that already
selected them. Feeds contain the latest release and use `Cache-Control: no-store`; configure the
domain's cache rules to respect that header.

The publisher verifies an existing feed's signature and refuses a bundle version regression, using
Sparkle's numeric order, or changed bytes at an existing archive URL. It uploads and downloads the archive to verify its public bytes,
then creates the GitHub release as a draft, uploads and checks the DMG's GitHub-reported SHA-256,
and publishes the release before uploading and reading back the feed. The feed is the final commit
point: a newly offered update already has its GitHub release and attachment. Channel releases are
serialized by the workflow.

Retries reuse the channel/version release and matching asset without replacing bytes. A conflicting
source tag, DMG, or incomplete upload fails rather than clobbering a release. If publishing stops
after GitHub succeeds, the GitHub release remains available; rerun `bun desktop publish` with the
same prepared artifacts to finish the feed. Do not rebuild that version: signing changes the bytes.
To backfill only GitHub from a verified existing CI artifact directory, without changing the feed,
run `bun apps/desktop/scripts/github-release.ts <artifact-directory>`.

## Building from Ace

An agent in an Ace channel can use its shell tool to run `bun desktop ci canary` from its lane.
The machine needs Bun, Git, and an authenticated GitHub CLI (`gh auth login`) with permission to
run this repository's workflows. Commit and push the lane first. The command refuses uncommitted
changes or a remote branch that differs from the lane, and pins the build to that exact commit.
Apple, Sparkle, and R2 credentials stay in the GitHub release environment.

The command returns immediately with the workflow URL and run ID. Use `bun desktop ci status
<run-id>` to follow progress, then `bun desktop ci download <run-id>` to retrieve the successful
build. Downloads go under `apps/desktop/artifacts/ci/<run-id>/`; the command checks the DMG's
SHA-256 against its release manifest and reports the source revision.

The release step's log marks each phase (build, signing, notarization, stapling, DMG, appcast)
with a timestamped `==>` line and records each notarization submission ID as soon as its upload
finishes. Apple keeps processing a submission after the 20-minute wait times out; the failure
then prints the `notarytool info` and `notarytool log` commands for checking it with the release
credentials. `bun desktop ci status` shows only step names until the job finishes, because
`gh run view --log` returns logs only for completed runs.

Use `stable` instead of `canary` for the main app; it dispatches on `main` and builds the current
commit, which `main` must contain. Building does not publish; add `--publish`
explicitly to build and publish a release. Manual builds may run at any time. A channel can use
[native desktop inspection](desktop-tools.md) to examine the installed app on its execution host.

Native desktop inspection in development requires an Apple Development signing identity selected
with `ace.codesignIdentity` or `ACE_CODESIGN_IDENTITY` (see [UI testing](desktop.md#ui-testing)). Development builds refuse missing or ad-hoc signing, and use one fixed
app identity across checkouts so permissions survive rebuilds. Release builds use the Developer ID identity below.

Use source dev builds alongside installed Canary. The optional installed development helper mode
must not coexist with source dev copies (see [installed Ace-dev](desktop.md#installed-ace-dev)).
Keep the same signing identity for installed development builds.
Changing from Apple Development to Developer ID, or to an ad-hoc signature, can invalidate
Ace Helper's macOS launch constraint even when the Team ID stays the same.

## Credentials and first release

Release credentials are kept in the team's password manager, outside the repository. Both GitHub
environments, `desktop-canary` and `desktop-stable`, are configured from them. They share one
Developer ID identity and notarization key, and a dedicated Ace Sparkle key. Rebuilding either
environment needs the following values:

| Kind     | Name                       | Value                                                        |
| -------- | -------------------------- | ------------------------------------------------------------ |
| Variable | `ACE_CODESIGN_IDENTITY`    | Developer ID Application name or SHA-1                       |
| Secret   | `ACE_CERTIFICATE_P12`      | Base64 P12 export containing the certificate and private key |
| Secret   | `ACE_CERTIFICATE_PASSWORD` | P12 password                                                 |
| Secret   | `ACE_NOTARY_PRIVATE_KEY`   | App Store Connect API `.p8` contents                         |
| Variable | `ACE_NOTARY_KEY_ID`        | API key ID                                                   |
| Variable | `ACE_NOTARY_ISSUER`        | API issuer UUID                                              |
| Secret   | `ACE_SPARKLE_PRIVATE_KEY`  | Exported Sparkle Ed25519 seed, base64                        |
| Variable | `ACE_UPDATE_PUBLIC_KEY`    | Matching Sparkle public key                                  |
| Variable | `ACE_UPDATE_URL`           | Public HTTPS base URL, without a channel suffix              |
| Variable | `ACE_UPDATE_BUCKET`        | R2 bucket name                                               |
| Variable | `CLOUDFLARE_ACCOUNT_ID`    | Account containing the bucket                                |
| Secret   | `R2_ACCESS_KEY_ID`         | R2 S3 access key scoped to the download bucket               |
| Secret   | `R2_SECRET_ACCESS_KEY`     | Matching R2 S3 secret key                                    |

Use the backed-up signing keys for subsequent releases. Never commit exports. Follow Sparkle's
[key rotation guidance](https://sparkle-project.org/documentation/#rotating-signing-keys): change
the Apple identity or Ed25519 key in one release, never both together. Signed disk images provide
a key recovery route when archive validation is required before extraction.

Manually run **Desktop release** on the intended commit (stable: from `main`, on a commit `main`
contains). It defaults to
canary and publishing off, so the notarized artifact is reviewable before the first public release.
With publishing enabled, it uploads and verifies the release. There is no recurring schedule.
CI uses a temporary signing keychain and removes credentials even when the build fails.

For a local release with the certificate installed, export the corresponding variables and set
`ACE_NOTARY_KEY` to the `.p8` file path. A local canary also needs `ACE_BUILD_NUMBER` above the
published canary's build number:

```sh
bun desktop release canary
bun desktop publish
```

`release` builds and verifies without publishing. `publish` uploads the prepared artifact to R2,
publishes its GitHub release, and updates the feed. Local publishing also requires `gh auth login`
with repository contents-write permission.

## Validation

The October 2, 2026 local check used a separate app identifier, helper, and data directory. Native
Sparkle upgrades from 0.0.3 to 0.0.4 (ZIP) and 0.0.4 to 0.0.5 (signed DMG with hardened runtime)
replaced the app, re-registered Ace Helper, and resumed interrupted real Anthropic runs without
opening their channels. Old workers exited, channel data remained, and recovery receipts cleared.

Corrupted feeds and archives were rejected. Download cancellation restored hosting. A canceled
preparation could not stop workers after a delayed request drained, and preparation waited for a
real terminal shell to exit. Canary packaging and workflow syntax checks passed, as did repository
type, formatting, and lint checks. A real host accepted update coordination over authenticated
loopback and rejected both operations from tailnet peers and the owner's tailnet browser.

The first Developer ID canary, 0.0.3, passed Apple's notarization for both the app and disk image;
both tickets were stapled and verified. The app extracted from the image passed Gatekeeper as
`Notarized Developer ID`. Real R2 uploads, public downloads, cache headers, and cleanup passed.
Both GitHub release environments contain the verified configuration.

An Ace channel completed the first signed CI build on October 3, 2026:
[canary 0.0.4, run 37088236918](https://github.com/githubnext/ace/actions/runs/37088236918).
Its agent invoked `bun desktop ci canary`, checked status, and downloaded the artifact through
`bun desktop ci download`. The workflow built, signed, notarized, and verified the release;
the download matched the requested source commit and DMG checksum. Publishing was off.

The next [CI build, canary 0.0.5](https://github.com/githubnext/ace/actions/runs/37088762958),
includes the yellow icon and chat usage display. Its agent downloaded and verified the artifact;
both the app and disk image passed local Gatekeeper and stapled-ticket checks. It replaced 0.0.3
at `/Applications/Ace Canary.app` after stopping Ace Helper. The new helper started from that
bundle, the existing project list survived, and the installed icon matched the yellow source.

Native checks covered Ace Helper registration, opening a folder with Cmd+O before provider setup,
the project dashboard, and Updates settings showing 0.0.5. Opening the folder created no channel.
The feed was not yet published at that stage, so update checks reported a feed retrieval error.
Verify a published notarized upgrade on another Mac before wider distribution.

[Canary 0.0.6](https://github.com/githubnext/ace/actions/runs/37135810035), from `76435b8`, defers
provider setup until agent invocation and includes the context-usage ring. An Ace channel dispatched
and downloaded the signed CI build. Both the app and DMG passed local Gatekeeper and stapled-ticket
checks before replacing 0.0.5 in `/Applications`.

The packaged helper and workers created a channel and accepted human messages with zero available
providers; rejected agent requests added no input or run. They also reopened a backed-up legacy
channel without changing its history or model. The installed app preserved all 55 backed-up entries
in its existing channel, created a new channel in Chat mode, and sent a human message with no model
selected or agent tokens used. The temporary channel was archived with its history retained.
Settings showed 0.0.6 and the existing provider keys; the authenticated helper used protocol 5 and
ran from the installed bundle. Source UI checks also retained a failed dashboard agent draft through
reload and successfully retried it after adding a real key, without recreating the channel or worker.

[Canary 0.0.7](https://github.com/githubnext/ace/actions/runs/37203388007) published the first
signed feed and public DMG. The installed 0.0.6 app found the update through Check for Updates.
Packaged helper checks must also start with launchd's system-only PATH: Bun 1.4's default
`Bun.which` lookup retains that startup PATH after the helper imports the login shell environment.
Pass the imported PATH explicitly when resolving developer tools. The 0.0.7 helper reproduced the
false missing-GitHub-CLI error; a compiled helper with the fix read real issues and PRs using the
same restricted startup environment and existing GitHub login.

[Canary 0.0.8](https://github.com/githubnext/ace/actions/runs/37204148484), from `607d91e`,
published the helper tool lookup fix. [Canary 0.0.9](https://github.com/githubnext/ace/actions/runs/37238501439),
from `5b7e614`, adds persistent GitHub page caching and the shared project sidebar.

The 0.0.9 checks, release dispatch, and artifact download ran through an Ace terminal. CI passed
type, formatting, and lint checks; signed and notarized the app and DMG; and verified the public
archive before publishing the signed feed. The download matched the requested source revision
and SHA-256, and the DMG passed local Gatekeeper and stapled-ticket checks as
`Notarized Developer ID`. The public feed serves 0.0.9 with `Cache-Control: no-store`.
