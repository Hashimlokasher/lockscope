# Verification notes

**Date:** 2026-10-23
**Environment:** Chrome 155.0.8059.85 and Chrome for Testing 156.0.8078.47
(headless), macOS, test page on `http://127.0.0.1:8931` (localhost is a secure
context).

These notes record what was checked during development, milestone by milestone.

## Verified

1. **Cross-tab visibility.** Tab A held an exclusive lock; tab B queued the same
   name. A `query()` from tab A returned A's lock in `held` and B's request in
   `pending`, with different `clientId`s. Shared locks from both tabs coexisted,
   and releasing A woke B. This is the assumption the whole panel depends on.
2. **`selfClientId` matches page locks.** The agent was injected through
   `Runtime.evaluate` (main world), the page acquired `mine`, and the agent's
   probe-reported `clientId` matched the page's holder. The "this tab" badge can
   therefore be trusted for main-world locks.
3. **Isolated worlds share the lock manager but not the client id.** A CDP
   isolated world saw and held locks visible from the main world, but reported a
   different `clientId`. This is a proxy for content scripts; it is why the agent
   must be injected into the MAIN world and why a future tab probe cannot rely on
   content-script locks.
4. **Page agent behavior.** The real `page-agent.js` was injected into a live
   page and returned snapshots containing locks held by two tabs, with internal
   `__lockscope_internal_*` entries filtered out. Re-injection returned
   `{ok: true, reused: true}`.
5. **M1 panel rendering.** `panel.html` was loaded over HTTP with a stubbed
   `chrome.devtools.inspectedWindow.eval` and snapshots. The table rendered 3
   held + 2 waiting, the self badge appeared once, pause/resume and the empty,
   fatal, retry, and "locks unavailable" states behaved correctly, and there were
   no console errors or horizontal overflow.

## Verified in the real extension

Chrome for Testing **156.0.8078.47** loaded `extension/` unpacked with
`--load-extension`. The registered panel iframe was inspected through CDP:

- The panel has a working `chrome.devtools.inspectedWindow.eval` (not just the
  API object) and `tabId`.
- End-to-end: clicking **Queue 3** on the inspected demo tab produced
  `1 held · 2 waiting` in the panel, with three `this tab` badges (all requests
  came from that page context). **Release all** returned it to the empty state.
- Pause/resume and the 100 ms interval both worked; the footnote updated.
- Navigating the inspected tab to `?nav=1` reset the view, changed the URL, and
  the panel resumed polling and accepted a new queue.
- Navigating to `chrome://settings/` produced the fatal state after three
  failures with the friendly privileged-page message (backed by the real
  `E_FAILED / Permission denied` details). Navigating back recovered without a
  reload.
- No page or panel exceptions were observed.

Headless DevTools does not render the panel tab strip, so the test pulled the
already-registered panel iframe into the DevTools DOM via its internal `UI.panels`
object. The iframe, APIs, polling, and DOM were real; only the final "click the
tab" step is unexercised.

## M2 verification

- `model.js` has unit tests for hold/wait intervals, pending → held transitions,
  shared holders, duplicate identities, vanished entries, pause gaps, clear,
  reset, and lane grouping. `node --test` passes.
- Real extension: a second tab held `resource-a`; three writers queued from the
  inspected tab. The panel showed one holder, `#1`–`#3` positions, `≥ 1.6 s`
  waits, and the `this tab` badge on the three waiters.
- Name and mode filters produced the expected subset and the "No matching locks"
  state; clear reset durations to zero; pause froze the timer and resume excluded
  the gap.
- The current screenshot (`store/screenshot-1.png`) includes the same lane model plus the timeline.
- Headless panels report `document.visibilityState = "hidden"`, so the test used
  pause/resume to force polling for the capture. The visibility handler is
  intentional: hidden panels stop polling and resume without counting the gap.

## M3 verification

- Stubbed panel: canvas rendered five intervals to non-transparent, saturated
  pixels; hover hit-testing produced the tooltip (`editor-doc`, `shared · held
  2.0 s`, client, started ago); 15 s/5 m zoom and the filtered no-match state
  behaved; no console errors.
- Real extension: one holder plus three waiters produced `4 intervals` on the
  timeline, stacked into one lane, with the held bar and three dashed waiting
  bars. Canvas pixel sampling confirmed the bars were painted.
- The headless panel reports `document.visibilityState = "hidden"`, where
  `requestAnimationFrame` is paused. The renderer now draws synchronously in that
  case; otherwise it coalesces draws through rAF.
- 420 px layout: no horizontal overflow, timeline 160 px tall, legend/count hidden.

## M4 verification

All ten demo scenarios were driven through CDP against the real extension:

- **Abort queued**: holder plus one pending entry; the pending entry vanished on
  `abort()` and the holder remained.
- **Abort after grant**: `abort()` after grant left `abort-granted` held.
- **`ifAvailable`**: no pending entry; the log reported skipped/settled.
- **`steal`**: the stealer took `steal-demo`; the original request logged
  preemption.
- **Worker**: `worker-lock` appeared with the worker's own `clientId`; release
  terminated the worker and the lock disappeared.
- **Deadlock**: two tabs produced 2 held (`deadlock-a`, `deadlock-b`) and 2
  pending requests, with four timeline intervals. **Release all** in the main tab
  broadcast over `BroadcastChannel`; both tabs cleared to zero locks.
- No page or panel exceptions.

The deadlock state is captured in `store/screenshot-1.png`. The scenario checklist is
`docs/manual-tests.md`.

## M5 verification

- The shipped manifest keeps `scripting` and HTTP(S) host access under
  `optional_permissions` / `optional_host_permissions`; nothing is granted at
  install.
- Headless Chrome cannot answer extension permission prompts, so mapping was
  verified with a temporary copy of `extension/` whose manifest made
  `scripting` + `http://127.0.0.1:8931/*` required (the shipped files were not
  changed). With two same-origin tabs titled "Main Demo" and "Other Tab", the
  panel labelled both holders and the labels disappeared when toggled off.
- `tabs` permission is not needed: the host permission exposes the matching
  tabs' `url` and `title`. The shipped optional request therefore asks only for
  `scripting` + the inspected origin.
- Probe design: a short-lived `__lockscope_internal_tab_*` lock is requested in the
  MAIN world via `scripting.executeScript`; reading `query()` inside its callback
  gives that tab's `clientId`, which is then mapped to the tab id/title. The probe
  is released immediately and its global marker is deleted.
- Still needs a headed run: the actual Chrome permission prompt and its accept/
  deny path (manual tests 22–24). The request is made directly from the button
  click, before any await, to preserve the user gesture.

## M6 verification

- `instrument.js` was injected into a live demo page via CDP. It patched
  `LockManager.prototype.request`; **Queue 3** produced three records: one held
  after 2 ms and two queued, then one `released` (hold ~1.2 s) and two `aborted`
  waits after release.
- The trimmed stack starts at the demo's `hold`/`queue` functions, not the wrapper.
- `uninstall()` restored the native method (`[native code]` in `toString()`).
- The panel's **Exact** view was exercised with a stubbed DevTools bridge: two
  records rendered with wait/hold, `ifAvailable`/`signal` flags, stack details, a
  working Clear, and a clean switch back to Timeline. No exceptions.
- Headless DevTools panel registration became flaky late in the session (even a
  minimal DevTools extension stopped mounting its panel iframe), so the final M6
  panel test used the browser-only panel harness; the instrumentation script
  itself ran against a real page. The headed manual checks are 25–30.

Trade-offs: instrumentation is main-world only, detectable by the page, and its
promise observers can affect unhandled-rejection reporting.

## Packaging verification

- `npm run package` produced `dist/lockscope-0.6.0.zip`: 15 files, ~36 KB, only
  `extension/` contents.
- Unzipped and loaded in Chrome for Testing 156: state `ENABLED`, version 0.6.0,
  no manifest errors, no runtime errors, no install warnings.
- Store screenshots are 1280×800; listing copy and privacy policy are under
  `store/`. The privacy policy still needs a public hosting URL for submission.
- Headed DevTools panel mounting remained flaky in headless CFT late in the
  session; the package-load check does not depend on it.

## Remaining checks

- **Install prompt string.** Expected to be warning-free with no host
  permissions; confirm on the `chrome://extensions` card.
- **Headed DevTools tab.** One manual click-through (Chrome stable or CFT) to
  confirm the docked panel tab layout and icon.
- **Branded Chrome CLI loading** is still blocked; use `chrome://extensions` for
  stable Chrome, or Chrome for Testing for automation.

## Decisions taken

- **Polling lives in the panel, not a `devtools_page` broker.** A broker needs a
  transport; `chrome.runtime.connect` is documented as talking to the extension's
  service worker, and this extension deliberately has none. The panel has direct
  DevTools API access, so it owns the timer, the token, and the eval calls.
- **Synchronous `snapshot()` over the eval boundary.** `inspectedWindow.eval`
  gained a promise form in Chrome 151 and dropped the old `awaitPromise` /
  `returnByValue` options. Returning a plain object avoids depending on either
  shape. The panel uses the callback overload, which remains supported and keeps
  Chrome 120+ on one code path.
- **Random token per DevTools session.** Prevents stale globals and internal lock
  names from colliding with page code.

## Reproduce

```bash
cd lockscope
python3 -m http.server 8931 --directory .      # demo + extension files
# open http://127.0.0.1:8931/demo/ and load extension/ unpacked
```

The agent-only test used CDP `Runtime.evaluate` with the contents of
`extension/page-agent.js`, replacing `__LOCKSCOPE_TOKEN__` with a test token.

## Known limitations (unchanged)

- Sampling misses locks that start and end between two samples.
- `query()` has no timestamps, so wait/hold durations are lower bounds.
- `clientId` is not a tab id; only the inspected tab can be labelled for free.
- Cross-origin iframes and some partitioned third-party contexts have a different
  lock manager and will not appear.
