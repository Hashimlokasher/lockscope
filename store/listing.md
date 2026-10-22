# Chrome Web Store listing

## Basics

- **Name:** LockScope — Web Locks Inspector
- **Short description (132 max):** Inspect navigator.locks across tabs — holders, waiters, queue positions, timeline, and opt-in exact timings.
- **Category:** Developer Tools
- **Language:** English
- **Homepage / support:** project repository URL (fill in before submitting)

## Detailed description

LockScope is a DevTools panel for the Web Locks API.

`navigator.locks.query()` gives you a point-in-time array with no timestamps and
no events. LockScope keeps a live view of every lock held or requested by the
inspected origin — including locks held by other tabs:

- Contention lanes by lock name, with holders and FIFO waiters (`#1`, `#2`, …).
- Observed hold and wait durations, labelled `≥` because they come from sampling.
- A 15 s / 60 s / 5 min canvas timeline with held and waiting bars and hover
  details.
- Filter by lock name or mode; clear history; pause without counting the pause gap.
- Optional **tab labels**: after a click and a per-origin permission grant, each
  holder is labelled with its tab title.
- Optional **instrumentation**: patches `LockManager.request` to record exact
  request/acquire/release times and await-site stacks in the Exact tab. Toggle it
  off to restore the native method.

The base extension requests **no permissions and no host access**. Tab labels are
the only feature that asks for anything: `scripting` plus the current origin, only
after you click the button.

Everything runs locally. There is no network code, no analytics, no account, and
no persistence of lock names or tab titles.

Use the bundled demo page to try queueing, shared readers, abort, `ifAvailable`,
`steal`, worker-held locks, and a two-tab deadlock.

## URLs to fill in

- Repository: `https://github.com/<owner>/lockscope`
- Privacy policy: `https://<owner>.github.io/lockscope/privacy.html` (after Pages deploy)
- Support: the repository Issues URL

## Permission justification

- **No required permissions.** The manifest declares only `devtools_page`.
- **`scripting` (optional):** used by the opt-in tab labels feature to inject a
  tiny probe that reads that tab's lock `clientId`. Requested only on the user's
  click, together with the inspected origin.
- **Host permission for the inspected origin (optional):** `optional_host_permissions`
  allows `http://*/*` and `https://*/*` so the panel can ask for exactly the
  origin shown in DevTools (for example `https://app.example.com/*`). It is never
  granted at install.

## Single purpose

Inspect and explain Web Locks (`navigator.locks`) state and timing for the page
open in DevTools.

## Data usage

No data is collected or transmitted. Lock names, client IDs, tab titles, and
instrumentation stacks are processed in memory for the DevTools session only.
See `privacy-policy.md`.

## Remote code

None. All scripts ship inside the extension; nothing is fetched or evaluated
from a remote server.

## Assets

- `screenshot-1.png` — 1280×800, contention lanes + timeline.
- `screenshot-2.png` — 1280×800, Exact instrumentation records.
- `../extension/icons/icon128.png` — store icon.

## Review notes

- The extension has no background service worker, content scripts, or required
  permissions.
- Instrumentation is opt-in, reversible, and limited to the inspected page's main
  world. It is disclosed in the UI and listing.
- Tab labels request optional permissions from a button click; denial leaves the
  rest of the panel working.
