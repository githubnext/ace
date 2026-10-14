# Browser tools

Ace's pi harness can list, navigate, and inspect web pages in a dedicated development browser on
the machine running the channel's tools. It talks to Chrome or Chromium directly over the Chrome
DevTools Protocol on loopback. The model receives bounded text and a screenshot. The same result
appears in the chat's expandable tool output, including after reopening the channel.

This is the first part of [#50](https://github.com/githubnext/ace/issues/50). There is no DOM
input, element references, console or network inspection, file upload, viewport or mobile
emulation, browser launch or quit, iframe content, or Browser Preview tab yet.

## The dedicated browser

Ace never attaches to personal browsers or other debugging sessions. It uses only the browser
running with the profile at `$ACE_HOME/browser`, which is `~/.local/state/ace/browser` for a default
host. Each Ace data directory (stable, Canary, development) has its own. Start it yourself, or ask
the agent to start it from its shell. On macOS:

```sh
open -na "Google Chrome" --args --user-data-dir="$HOME/.local/state/ace/browser" \
  --remote-debugging-port=0 --no-first-run --no-default-browser-check
```

On Linux, run `chromium` (or `google-chrome`) with the same arguments. Chrome, Chromium, and
Chrome for Testing all work.

Chrome refuses remote debugging for its default profile, and port 0 lets Chrome choose a free
loopback port. Chrome writes that port and its browser endpoint path to `DevToolsActivePort` in
the profile. Ace reads that file on every call, so nothing else is configured. When the browser is
not running, the tools refuse with the profile path and this command.

Pages loaded in the dedicated profile keep their cookies and storage there, and downloads go to the
profile's download directory, which is the user's Downloads folder unless changed in that browser.

## Identity

`browser_tabs` returns the browser identity and an exact target for each tab:
`{ "browser": "<id>", "target_id": "<id>" }`. The browser ID comes from Chrome's endpoint path and
changes whenever the browser restarts. The target ID is Chrome's own tab identifier. Prerendered
pages are not tabs.

Every call reconnects and checks the target. A target from a replaced browser, or a tab that has
closed, is refused before anything is sent. The tools never choose a tab by URL, title, or
position, so tabs with the same title and URL stay distinct.

## Inspection

`browser_inspect` attaches to the tab without activating it, scrolling, or changing its viewport,
and returns:

- The main document's accessibility tree, from `Accessibility.getFullAXTree`. Iframe documents are
  not included. Ignored nodes, inline text boxes, and unnamed generic containers are folded into
  their parents. Names, values, and URLs are clipped to 400 bytes; the tree to 32 KB of UTF-8.
  The result reports how many nodes were shown.
- By default, a JPEG of the visible viewport at device resolution, without resizing, at most
  4096 pixels per side and 900 KB. Ace lowers the JPEG quality before giving up on a large image.
  Viewport metrics (scroll position, size, browser zoom) are reported in CSS pixels.
- The main document's frame and loader IDs before inspection, and whether they changed by the end.
  When the document changed, or could not be checked again, the tree and screenshot may describe
  different documents.

A failed or timed-out screenshot, or a tree too large to read, does not discard the other evidence.
Background tabs may not produce screenshot frames. Chrome messages over 16 MB fail only their own
command. Each call has a 30-second deadline, and the whole result stays under 2 MB so it fits a
hosted channel's storage row.

## Navigation

`browser_navigate` sends one `Page.navigate` for an absolute `http` or `https` URL. Like desktop
actions, it is unsafe to replay and runs sequentially. Pi records the call as `unknown` before
dispatch.

- `refused`: nothing was sent. The URL was invalid, the browser was not running or was replaced,
  the tab was gone, the workspace was offline, or the run was stopped first.
- `completed`: Chrome answered. The status is `started` (a new document with its loader ID),
  `same_document` (a fragment change; Chrome omits the loader ID), `download` (the tab's document
  was not replaced), or `failed` with Chrome's error text. None of these mean the page finished
  loading. Inspect it afterwards.
- `unknown`: dispatch may have happened. Pi or the workspace link can lose track of the call
  before or after it reaches Chrome (a stop, the deadline, a lost browser or workspace connection,
  a protocol error, or a worker crash after pi recorded the call). The navigation may not have
  happened, may have happened, or may still happen. Inspect before navigating again.

A worker that restarts mid-navigation reports the call as interrupted and does not repeat it.

## Local and hosted channels

A local channel uses its host's browser. A hosted channel sends browser calls to its workspace,
the host that serves its tools, never to the viewer's machine. When the workspace is offline,
inspection fails and navigation is refused. A navigation in flight when the workspace disconnects
is `unknown`. The collaborator-agent switch applies to browser tools with the rest of the agent's
tools.
