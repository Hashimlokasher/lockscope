# LockScope — a Web Locks inspector for Chrome DevTools

**Status:** implemented through v0.6.0 · 2026-10-23
**Folder:** `lockscope/`
**Target:** Chrome 120+ (developed against Chrome 155), Manifest V3

---

## 1. One-liner

A zero-required-permission Chrome DevTools extension that shows every Web Lock
(`navigator.locks`) held and requested by the inspected origin — across tabs —
with holders, waiters, wait times, and a live timeline.

Today the only way to see this is to type `await navigator.locks.query()` in the
console, which gives you a point-in-time array and nothing else.

---

## 2. Why this is worth building

Web Locks is the standard browser primitive for cross-tab mutual exclusion:
upload queues, CRDT/editor sync, cache rebuilds, "only one tab may do X".
When it goes wrong, it looks like a frozen feature, not an error — a lock is
never released, or two tabs wait on each other.

The platform gives developers almost no observability:

- `navigator.locks.query()` is a snapshot, with no timestamps and no events.
- DevTools has no first-class Web Locks view (checked on Chrome 155).
- Console output disappears as soon as you navigate or close DevTools.
- `clientId` is opaque, so "which tab is holding this?" is guesswork.
- Cross-tab contention is invisible from a single tab unless you query manually.

LockScope turns that into a live, cross-tab view without requiring any permission
for the core panel. That constraint is what makes the project interesting: a
DevTools extension can evaluate code in the inspected page through
`chrome.devtools.inspectedWindow.eval`, and Web Locks state is origin-wide, so one
query sees every same-origin tab.

---

## 3. Concept options considered

| Concept | What it would be | Why not (for v1) |
| --- | --- | --- |
| **A. LockScope inspector** *(chosen)* | DevTools panel: live held/pending locks, wait times, timeline, cross-tab holders | — |
| B. Cross-origin lock broker | Extension service worker acts as a global mutex for pages on different sites, bridged by content scripts | Every page must opt in to a custom API; MV3 service-worker lifecycle; broad host permissions; large security surface. Web Locks already solves the same-origin case. |
| C. Background lock sentinel | Always-on monitor that badges long waits and notifies on stalls | Needs content scripts on all pages, broad host permissions, constant polling, and a privacy story. Could ship later as a mode of A. |
| D. Teaching/demo extension | Interactive playground for `request`/`query`/`steal` | Useful, but a demo page in this repo already covers it; weak standalone product. |

The inspector wins because it is narrow, useful on day one, and demonstrable in
five minutes with two tabs. Options B and C are recorded here so the decision is
explicit rather than accidental.

---

## 4. Product

### 4.1 Users and jobs

- **Multi-tab app developer** — "which tab is holding `upload-queue`, and why is
  this tab stuck?"
- **QA / race repro** — "show me the last 60 seconds of lock contention while I
  click through this flow."
- **Performance engineer** — "is lock wait time contributing to this
  interaction's latency?"
- **Learner** — "what actually happens with shared vs exclusive and `steal`?"

### 4.2 MVP features

| ID | Feature | Detail | Done when |
| --- | --- | --- | --- |
| F1 | Live lock view | Contention lanes grouped by lock name; mode, short `clientId`, holder/waiter counts | Updates within 1 s of a change, no console errors |
| F2 | This-tab marker | The inspected tab's own `clientId` is detected and labelled "this tab" | Correct when a second tab holds the same lock |
| F3 | Contention lanes | Per lock name: holders on top, FIFO waiters below with queue position | Two-tab demo renders one holder + one waiter |
| F4 | Wait-time tracking | `pending` duration measured from first observation, shown as `≥ 1.4 s` | Increases smoothly while a waiter is queued |
| F5 | Timeline | Last 60 s, one lane per lock name, hold bars and ghost wait bars; hover details; 15/60/300 s zoom | Hover shows name/mode/clientId/start/duration |
| F6 | Pause, clear, filter, rate | Freeze sampling, reset history, substring filter on name, mode filter, sample interval 100/250/500/1000/2000 ms | Pause stops polling; resume does not fabricate wait times |
| F7 | Raw snapshot | Copy the current `query()` result as JSON | Valid JSON on clipboard |
| F8 | Page states | Unsupported page (`chrome://`, Web Store, `view-source:`), navigation reset, page with no locks | Friendly empty/error states, no error spam |
| F9 | Theme + a11y | Follow DevTools light/dark; keyboard-reachable rows; text labels alongside color | Usable with keyboard only |

Stretch for the same milestone if cheap: a "stalled wait" amber hint for a
pending lock older than 5 s whose holder set has not changed. Copy must say
"possibly stalled", never "deadlock detected" — `query()` has no wait-for edges.

### 4.3 Non-goals (v1)

- Not a lock library, polyfill, or enforcement layer. It observes; it does not
  make an app correct.
- No network requests, telemetry, analytics, or remote config.
- No persistence of lock names or history across DevTools sessions.
- Tab attribution is opt-in and scoped to the inspected origin; it is never part
  of the zero-permission default (see M5).
- No Firefox/Edge-specific packaging (the API shape is close, but out of scope).
- No monkey-patching of `navigator.locks` in v1 (see M6).

### 4.4 UX

```
┌ LockScope  http://localhost:8080/   3 held · 2 waiting ─────────────────┐
│ [Pause] [Clear]   sample 500 ms ▾   filter [____________]  mode [all ▾] │
├────────────────────────────────────────┬────────────────────────────────┤
│ LOCKS                                  │ TIMELINE — last 60 s           │
│                                        │                                │
│ resource-a                 1H · 2W     │ resource-a  ▓▓▓▓▓▓░░░▓▓▓▓▓▓   │
│   ● 5337F898  this tab     held 12.4 s │ resource-b       ░░░▓▓▓▓▓▓    │
│   ○ 40D974F3  waiting      ≥ 1.4 s     │ upload-queue ▓▓▓▓▓▓▓▓▓▓▓▓    │
│   ○ 8A12C0DE  waiting      ≥ 0.2 s     │                                │
│                                        │  now ────────────────────►     │
│ resource-b                2H shared    │                                │
│   ● 5337F898  this tab                 │                                │
│   ● 40D974F3                           │                                │
├────────────────────────────────────────┴────────────────────────────────┤
│ DETAIL  resource-a · exclusive                                          │
│ holder 5337F898…  since 12.4 s     raw { "name": "resource-a", ... }    │
│                                                    [Copy JSON]          │
└──────────────────────────────────────────────────────────────────────────┘
```

States:

- **Live** — normal.
- **Empty** — "No locks in this origin. Hold one from the demo page." with a
  one-line `navigator.locks.request(...)` snippet.
- **Unsupported** — "LockScope can't inspect this page (`chrome://` pages and the
  Web Store block extension evaluation)."
- **Paused** — banner with the frozen-at time; resume restarts wait clocks at
  the resume point rather than pretending the gap was observed.
- **Error** — one-line error plus "Retry"; no repeated exceptions.

---

## 5. Technical design

### 5.1 Architecture

Everything runs locally. There is no background service worker, no content
script, and no second transport in the MVP.

```
┌──────────────────── DevTools window ────────────────────┐
│  devtools.html / devtools.js                            │
│      └─ chrome.devtools.panels.create(...)              │
│                                                         │
│  panel/panel.html + panel.js                            │
│      └─ table UI · diff model · eval poll loop          │
└──────────────────────────┬──────────────────────────────┘
                           │ chrome.devtools.inspectedWindow.eval
                           ▼
┌──────────────── inspected page, main world ─────────────┐
│ window.__lockscope_<token>                              │
│   start(ms) · stop() · snapshot() · selfClientId()      │
│   setInterval → navigator.locks.query() → plain object  │
└─────────────────────────────────────────────────────────┘
```

Why polling lives in the panel:

1. A panel is a page loaded inside the DevTools window, the scope Chrome
   documents for `chrome.devtools.*`. Verified end-to-end in Chrome for Testing
   156; see `docs/verification.md`.
2. `chrome.runtime.connect` targets the extension's service worker; with no
   background context there is no receiver. Avoiding ports avoids a needless
   background worker.
3. The panel's lifetime is the view's lifetime: closing the panel tears down the
   loop instead of leaving an orphan broker polling in a hidden page.

The panel does the eval calls, the snapshot diff model, and the rendering. The
`devtools.js` page is intentionally trivial.

### 5.2 Target components and files

```
lockscope/
├── README.md
├── LICENSE
├── CHANGELOG.md
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── SECURITY.md
├── package.json                # test / demo / zip scripts only, no build
├── .editorconfig
├── .gitattributes
├── .gitignore
├── .nvmrc
├── .github/                    # CI, issue forms, PR template
├── extension/
│   ├── manifest.json
│   ├── devtools.html           # bootstrap page
│   ├── devtools.js             # panel registration only
│   ├── page-agent.js           # injected into the inspected page (main world)
│   ├── instrument.js           # opt-in LockManager.request patch (M6)
│   ├── panel/
│   │   ├── panel.html
│   │   ├── panel.css
│   │   ├── panel.js            # lane UI, eval loop, state
│   │   ├── model.js            # snapshots → intervals/lanes/stats (M2)
│   │   ├── timeline.js         # canvas renderer + hit testing (M3)
│   │   └── format.js           # durations, short ids, names
│   └── icons/                  # 16/32/48/128 png
├── demo/
│   ├── index.html
│   ├── demo.css
│   ├── demo.js                 # scenarios listed in §6
│   └── worker.js               # dedicated worker holding a lock
├── test/
│   ├── format.test.js          # formatting helpers
│   ├── instrument.test.js      # instrumentation wrapper
│   ├── model.test.js           # snapshot model
│   └── timeline.test.js        # timeline intervals
├── scripts/
│   └── package.mjs             # zip for the Chrome Web Store
├── site/                       # public landing + privacy policy (Pages)
├── store/
│   ├── listing.md
│   ├── privacy-policy.md
│   ├── screenshot-1.png
│   └── screenshot-2.png
└── docs/
    ├── plan.md                 # this document
    ├── verification.md
    └── manual-tests.md
```

No bundler, no TypeScript, no dependencies for the extension. Plain ES modules
load directly from `chrome-extension://`, so "load unpacked" is the whole build.
`model.js` is dependency-free so Node can test it. If the project outgrows this,
add Vite later; do not add it up front.

### 5.3 Manifest and permissions

```json
{
  "manifest_version": 3,
  "name": "LockScope — Web Locks Inspector",
  "version": "0.6.0",
  "description": "Live view of navigator.locks across tabs: holders, waiters, contention, timeline.",
  "devtools_page": "devtools.html",
  "optional_permissions": ["scripting"],
  "optional_host_permissions": ["http://*/*", "https://*/*"],
  "icons": { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" }
}
```

No `permissions`, no `host_permissions`, no background worker, no content
scripts. `inspectedWindow.eval` needs no permission, so the install prompt
should carry no "read and change all your data" warning. This is a deliberate
product feature; confirm the exact install string during M0.

M5 (tab attribution) adds `scripting` and host access as **optional** permissions,
requested for the inspected origin only after the user clicks **Tab labels**.
Nothing is granted at install; the default build still has zero required
permissions.

### 5.4 Snapshot protocol

Page agent, injected as an IIFE and cached per navigation:

```js
(() => {
  const TOKEN = "__LOCKSCOPE_TOKEN__";
  const KEY = `__lockscope_${TOKEN}`;
  if (window[KEY]?.version === 1) return { ok: true, reused: true };

  const PROBE = `__lockscope_internal_probe_${TOKEN}`;
  const PREFIX = "__lockscope_internal_";
  let selfClientId = null;
  let last = { t: 0, url: location.href, held: [], pending: [], selfClientId: null };
  let timer = null, inFlight = false, lastRead = Date.now();

  async function probeSelf() {
    try {
      await navigator.locks.request(PROBE, { ifAvailable: true }, async (lock) => {
        if (!lock) return;
        const q = await navigator.locks.query();
        selfClientId = q.held.find(l => l.name === PROBE)?.clientId ?? null;
      });
    } catch (_) { /* page may be shutting down */ }
  }

  async function refresh() {
    if (inFlight) return;
    inFlight = true;
    try {
      const q = await navigator.locks.query();
      last = {
        t: Date.now(),
        url: location.href,
        selfClientId,
        held: q.held.filter(l => !l.name.startsWith(PREFIX)),
        pending: q.pending.filter(l => !l.name.startsWith(PREFIX)),
      };
    } catch (e) {
      last = { ...last, t: Date.now(), error: String(e) };
    } finally {
      inFlight = false;
    }
  }

  function start(ms) {
    stop();
    const every = Math.max(100, Math.min(2000, ms || 500));
    timer = setInterval(() => {
      if (Date.now() - lastRead > 30_000) { stop(); return; } // watchdog
      refresh();
    }, every);
    refresh();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  window[KEY] = {
    version: 1,
    start, stop,
    snapshot() { lastRead = Date.now(); if (!timer) start(500); return last; },
    selfClientId: () => selfClientId,
  };

  probeSelf();
  start(500);
  return { ok: true, token: TOKEN, url: location.href };
})()
```

Panel side (shape, not final):

```js
// The callback overload still exists alongside the Chrome 151+ promise form,
// so using it keeps Chrome 120+ working with one code path.
function evalInPage(expression) {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(expression, (result, exceptionInfo) => {
      if (!exceptionInfo) return resolve(result);
      const error = new Error(exceptionInfo.value || exceptionInfo.description || exceptionInfo.code);
      error.code = exceptionInfo.code;
      reject(error);
    });
  });
}

async function tick() {
  if (!running || inFlight) return;
  inFlight = true;
  try {
    let snapshot = await evalInPage(
      `window.__lockscope_${token} ? window.__lockscope_${token}.snapshot() : null`,
    );
    if (!isSnapshot(snapshot)) {
      await evalInPage(agentSource.replaceAll("__LOCKSCOPE_TOKEN__", token));
      await evalInPage(`window.__lockscope_${token}.start(${intervalMs})`);
      snapshot = await evalInPage(`window.__lockscope_${token}.snapshot()`);
    }
    if (!isSnapshot(snapshot)) throw new Error("page agent did not return a snapshot");
    render(snapshot);
  } catch (error) {
    // Three consecutive failures -> fatal state with Retry.
  } finally {
    inFlight = false;
  }
}
```

Key decisions in the protocol:

- **Synchronous `snapshot()` returning a plain object.** The agent samples on a
  timer, so the panel always reads a recent value. This avoids depending on
  whether `inspectedWindow.eval` awaits page promises in a given Chrome version.
  The callback overload survives the Chrome 151 promise migration.
- **The panel owns the loop.** Closing the panel destroys the timer with the
  iframe; there is no broker with a different lifetime.
- **The agent is idempotent.** Re-injecting returns the existing instance.
- **The agent self-samples.** Default 500 ms; the panel can drop to 100 ms while
  investigating. Sampling stops on pause and after 30 s with no reads.
- **Namespaced internals.** `__lockscope_internal_*` locks are filtered out
  of the UI and use a random per-session token to avoid collisions.

Panel ↔ agent surface:

| Call | Purpose |
| --- | --- |
| `snapshot()` | return the cached state; also resets the agent's idle watchdog |
| `start(ms)` | set the sampling interval (100–2000 ms) |
| `stop()` | stop sampling on pause or panel teardown |
| `selfClientId()` | probe result, used for the "this tab" badge |

### 5.5 Diff model (panel-side, pure)

Input: a stream of snapshots. Output: lanes, intervals, stats.

Identity: `clientId + "|" + mode + "|" + name`, plus an occurrence index per
group so duplicate shared requests from one client do not collapse.

Rules:

1. For every entry present in a snapshot and absent from the previous one, open
   an interval at `snapshot.t` (mark `startExact: false` — it started somewhere
   in the previous sample window).
2. For entries that disappear, close at `snapshot.t` (`endExact: false`).
3. Track `pending → held` transitions by identity; close the wait interval and
   open a hold interval at the transition time. Wait time is
   `transition.t - firstSeen.t`, a lower bound.
4. Keep `firstSeen` when an entry stays pending across samples; that is what
   makes "≥ 1.4 s" grow.
5. On `navigated` or a token change, close all open intervals and reset.
6. On pause/resume, close open intervals at the pause timestamp and mark the gap;
   do not count the gap as wait or hold time.
7. Cap history at ~5,000 intervals or 10 minutes, whichever comes first.

Output shape:

```js
{
  now: 1760000000000,
  paused: false,
  lanes: [
    {
      name: "resource-a",
      held: [{ key, mode, clientId, durationMs, ... }],
      pending: [{ key, mode, clientId, waitMs, queue, ... }],
      heldCount, pendingCount, oldestWaitMs, entries
    }
  ],
  totals: { held: 3, pending: 2, locks: 2 },
  stats: {
    samples, startedAt, uptimeMs,
    currentLongestWaitMs, longestWaitMs, maxHeldMs,
    oldestWaitMs, history
  }
}
```

Unit tests drive this module with hand-written snapshot sequences; no browser or
Chrome needed.

### 5.6 Timeline

- Canvas, DPR-scaled, one horizontal lane per lock name, sorted by first
  appearance (stable).
- X axis: trailing window (15 s / 60 s / 300 s), "now" at the right edge.
- Held interval: solid bar in the client's hash color.
- Pending interval: 1 px outline / diagonal hatch, so mode is not color-only.
- Hover or keyboard focus: tooltip with name, mode, short clientId, start offset,
  duration, "observed" badge when the edge is approximate.
- Redraw on snapshot, resize, hover, and theme change only — no continuous rAF.
- Cap rendered lanes at 40; beyond that, show "40 of N lanes — filter to narrow".

Accessibility: the table is the primary accessible view; the canvas gets
`role="img"` and an `aria-label` summary ("3 held, 2 waiting, longest wait 1.4
seconds").

### 5.7 Lifecycle

- Panel opens → injects the agent (if absent), starts sampling, renders.
- Panel closes → the iframe and its timer are destroyed; the page agent's
  watchdog stops its own timer after 30 s without a `snapshot()` read. Pause
  sends an explicit `stop()`.
- Navigate → `chrome.devtools.network.onNavigated` resets the token and clears
  the table; the next tick injects into the new document. If that listener is
  unavailable, the missing global triggers the same re-injection path.
- DevTools reopened → new panel, new token; the old page timer is inert and the
  watchdog reaps it.
- Page frozen / BFCache → eval may throw; three consecutive failures show the
  fatal state with Retry instead of error spam.
- Panel hidden (another DevTools tab selected) → `visibilitychange` stops the
  timer; becoming visible restarts it without fabricating elapsed time.

### 5.8 Scope semantics (important, and easy to get wrong)

- Web Locks are scoped to an **origin**. Same-origin tabs, iframes, and workers
  share one lock manager. A query from the inspected top frame sees entries held
  by other tabs of that origin — verified locally, see §12.
- Cross-origin iframes are a different origin and will not appear. Third-party
  contexts may also be partitioned in Chrome; treat the panel as "this frame's
  origin/storage key", not "the whole browser".
- `clientId` identifies the requesting **environment**, not the tab. A lock
  requested from an isolated world is visible to the main world but carries a
  different `clientId` (verified with a CDP isolated world; confirm for real
  content scripts in M0), so any future tab probe must run in the MAIN world.
- `query()` returns `held` and `pending` only. There are no timestamps, no
  wait-for graph, and no change events. Every duration in the UI is derived from
  sampling and is therefore a lower bound; labels must say so.
- Locks are released when the callback's promise settles or the document is
  destroyed. `steal: true` preempts current holders; `signal` aborts a *pending*
  request (aborting after grant does not release it).

### 5.9 Security and privacy

- No network code at all; no `fetch`/XHR/WebSocket in the extension.
- Lock names, clientIds, tab titles, and instrumentation stacks stay in memory
  for the DevTools session. Nothing is written to storage.
- The injected agent is visible to the page (a namespaced global and a timer).
  Disclose that in the README. Use a random token and never expose page data
  outside the page/panel.
- `eval` here is the DevTools API, not `unsafe-eval`; the extension CSP stays
  default. No remote code.
- The page can tamper with the agent global. This is a debugging tool, not a
  security boundary; the panel should tolerate malformed snapshots (validate
  shape, drop bad entries) rather than throw.

### 5.10 Instrumentation (M6)

- Opt-in **Instrument** button. The panel injects `instrument.js` into the
  inspected page's MAIN world; it wraps `LockManager.prototype.request` and keeps
  the original for restoration.
- Each request records: name, mode, `ifAvailable`/`steal`/`signal` flags,
  requested/acquired/released epochs, outcome (queued, held, released, skipped,
  aborted, rejected, threw), and a trimmed await-site stack.
- `snapshot()` returns the bounded record list (300); the panel polls at most
  once per second and renders the latest 120 in the **Exact** dock tab. Records
  are cleared independently of the patch.
- Toggle off calls `uninstall()`, restoring the prototype only if our wrapper is
  still installed. Navigation drops the patch; the panel re-injects it if the
  toggle is still on.
- A page-side watchdog uninstalls after two minutes without a `touch()`/`snapshot()`
  heartbeat, so closing DevTools does not leave the patch behind indefinitely.
- Trade-offs: main-world only (workers are not instrumented), the patch is
  detectable, and observing promise settlements can affect unhandled-rejection
  reporting. It is never enabled by default.

### 5.11 Performance budgets

- `eval` round-trip: ≤ 2 ms median, ≤ 10 ms p95 on a normal page.
- Snapshot payload: ≤ 64 KB at 500 locks; truncate details beyond that and show
  "N locks hidden".
- Memory: ≤ 20 MB for a 10-minute session with 100 active locks.
- CPU: < 1% average while open, ~0 when paused.
- First paint after panel open: < 300 ms (empty table + skeleton, then data).

---

## 6. Demo harness

A static site in `demo/`, served over `http://localhost:8080` (localhost counts
as a secure context, which `navigator.locks` requires):

```bash
python3 -m http.server 8080 --directory demo
```

Scenarios, each a button with a short explanation and live status:

1. **Exclusive hold/release** — hold `resource-a` for 5 s.
2. **Queue** — start 3 writers; watch FIFO waiters.
3. **Shared readers + writer** — 3 shared holders, then an exclusive writer that
   waits for all readers.
4. **Abort while queued** — enqueue with an `AbortController`, abort at 1 s;
   pending disappears.
5. **Abort after grant** — abort at 3 s; show that the lock is still held.
6. **`ifAvailable`** — skip instead of queue; no pending entry appears.
7. **`steal`** — long holder plus a stealing request; the original holder's
   callback keeps running but its lock is gone and the stealer holds it (good
   teaching moment).
8. **Worker-held lock** — a dedicated worker holds a lock; it appears with the
   worker's own `clientId`.
9. **Cross-tab** — "Open second tab" runs the same page with `?role=2`; hold in
   one, queue in the other, watch both in one panel.
10. **Deadlock** — two tabs acquire `a` then `b` in opposite order with a small
    delay; the panel shows two holders and two waiters forever. This is the
    demo that sells the tool.

The demo page also exposes `window.demo` helpers so manual test steps are one
line in the console.

---

## 7. Milestones

| Milestone | Scope | Est. | Exit criteria |
| --- | --- | --- | --- |
| **M0 — Spike** | Verify `eval` on Chrome 155 (promise vs callback), panel API access, install prompt text, cross-tab visibility | 0.5 d | `docs/verification.md` records the answers; a panel prints a lock held by another tab |
| **M1 — Shell** | Manifest, devtools bootstrap, panel layout, agent injection, panel poll at 500 ms | 0.5 d | Live held/pending table; panel closes cleanly; no console errors |
| **M2 — Model + lanes** | `model.js`, intervals, wait times, lanes, self-tab marker, pause/clear/filter | 0.75 d | Two-tab demo shows holder + waiter + growing `≥` time; unit tests for transitions pass |
| **M3 — Timeline** | Canvas lanes, ghost waits, hover, zoom, theme, perf guards | 0.75 d | 60 s view smooth; 100-lock demo within budgets |
| **M4 — Demo + tests + docs** | All 10 scenarios, manual test sheet, README with screenshots | 0.75 d | Test matrix green; a new person can install and reproduce in 5 min |
| **M5 — Optional: tab attribution** | MAIN-world probe per same-origin tab; label holders with tab titles/ids | 1 d | "Tab: Editor — 2" shown; permissions scoped as narrowly as possible |
| **M6 — Optional: instrumentation** | Opt-in patch of `LockManager.prototype.request` for exact acquire/release + stack | 1 d | Exact timings and await-site stacks; toggle fully restores the original |

Core (M0–M4) is roughly **3–3.5 focused days**. M5 (tab labels) and M6
(instrumentation) are opt-in features, not part of the zero-permission default.

**Progress 2026-10-23:** M0–M6 are done. M1 was verified end-to-end (queue,
release, pause/resume, interval change, navigation, `chrome://` fatal/recovery).
M2 added `model.js` plus tests for transitions, duplicates, pause gaps, clear and
stats, then lanes with queue positions and `≥` durations. M3 added the canvas
timeline (15 s/60 s/5 m windows, stacked held/waiting bars, hover details) with a
hidden-iframe synchronous draw path. M4 completed the ten-scenario demo
(abort-before/after-grant, `ifAvailable`, `steal`, worker-held lock, two-tab
`BroadcastChannel` deadlock) and the manual test sheet. Real-extension verification
showed the deadlock as 2 held + 2 waiting with four timeline bars, and **Release
all** cleared both tabs. M5 added opt-in tab labels: `scripting` + the inspected
origin are requested only after a click, then MAIN-world probe locks map each
`clientId` to a tab title. M6 added opt-in instrumentation: the panel injects
`instrument.js`, which patches `LockManager.prototype.request` for exact
request/acquire/release times and await-site stacks, renders them in an **Exact**
dock tab, and restores the native method when toggled off. Packaging is ready:
`npm run package` produces `dist/lockscope-0.6.0.zip` (15 files), and `store/`
holds the listing, privacy policy, and two 1280×800 screenshots. The packaged zip
was loaded into Chrome for Testing 156 with no manifest, runtime, or install
warnings.

---

## 8. Test plan

### 8.1 Unit (`node --test`)

- Snapshot sequence pending → held → gone produces one wait + one hold interval.
- Shared locks: two holders same name, no wait.
- Duplicate identity (same client, same name, shared) does not collapse.
- Waiter that disappears without being granted closes cleanly.
- Pause/resume does not count the paused gap.
- Navigation resets open intervals.
- Out-of-order/duplicate snapshots are ignored by timestamp.
- Malformed snapshot entries are dropped without throwing.
- Stats: longest wait, max hold, counts.

### 8.2 Manual E2E

| # | Scenario | Expected |
| --- | --- | --- |
| T1 | Demo 1, one tab | 1 held, self-tab marker, hold timer grows |
| T2 | Demo 9, holder + waiter in two tabs | Panel in either tab shows both; waiter `≥` grows |
| T3 | Demo 3 | 3 shared holders; writer pending until all release |
| T4 | Demo 4 | Pending vanishes on abort |
| T5 | Demo 5 | Lock remains held after abort |
| T6 | Demo 7 | Holder loses the lock, stealer holds it |
| T7 | Close holder tab | Holder interval closes; waiter becomes holder |
| T8 | Navigate inspected page | Timeline clears; panel shows new URL; no stale entries |
| T9 | `chrome://settings` | Unsupported state, no repeated errors |
| T10 | Pause for 30 s, resume | No fabricated 30 s waits |
| T11 | 500 locks | UI responsive, payload within budget |
| T12 | Keyboard only | Filter, pause, row focus, tooltip all reachable |

Optional automation spike: Playwright with Chrome for Testing can load the
extension, but DevTools panels are awkward to drive. Do not put this on the
critical path; unit tests plus the manual sheet are enough for v1. If attempted,
assert `chrome.devtools` availability and panel target, not pixels.

---

## 9. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| `inspectedWindow.eval` API drift (promise form since Chrome 151) | Medium | Medium | M0 spike; callback overload + synchronous `snapshot()` avoid both failure modes |
| Sampling misses short-lived locks | High | Medium | State it in the UI/README; 100 ms sampling; M6 adds exact instrumentation |
| `clientId` cannot be mapped to a tab | Certain | Low/Medium | Short hash + this-tab marker; optional M5 MAIN-world probes map clientIds to tabs |
| Panel iframe lacks `chrome.devtools` APIs | Low | High | Verified in Chrome for Testing 156; fallback is a BroadcastChannel broker in `devtools.js` (no service worker needed) |
| Frame/partition scope confusion | Medium | Low | Show the inspected URL/origin; document iframe limits; test a partitioned iframe |
| Very large lock sets | Medium | Medium | Cap intervals, truncate payload, virtualize table, lane cap |
| Page tampering with the agent global | Low | Low | Random token, shape validation, never treat data as trusted |
| Install/review friction | Low | Medium | Zero required permissions, no network; optional features are scoped and explained |
| Browser version differences | Medium | Medium | Manifest pins Chrome 120+; test stable/beta for API and CSS drift |
| DevTools panel lifecycle leaks a timer | Medium | Low | Watchdog, `onDisconnect`, token invalidation |
| Instrumentation changes page behavior | Medium | Medium | Opt-in, reversible, main-world only, documented trade-offs |

---

## 10. Roadmap after v0.1

- **v0.2** — JSON export, shareable snapshot file.
- **v0.3** — instrumentation follow-ups: attribute exact records to lane rows,
  instrument dedicated workers, export a timing report.
- **v0.4** — guarded "steal lock" action for reproducing recovery paths, behind a
  typed confirmation and a clear warning.
- **v1.0** — submit the prepared Chrome Web Store listing; host the privacy
  policy URL; optional short demo GIF.
- **Later** — Edge package, Firefox port (`browser.devtools`), optional
  always-on sentinel mode (concept C) for long-running QA sessions.

---

## 11. Open decisions

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Working name `LockScope` | Use it; check CWS/name collision before listing |
| D2 | Permissions posture | Zero required; tab labels optional and per-origin (implemented) |
| D3 | Language/build | Plain ES modules, no bundler; JSDoc types; revisit only if it hurts |
| D4 | Distribution | Unpacked for dev; CWS after M4; private zip if internal only |
| D5 | Is page instrumentation acceptable later? | Yes, but opt-in, reversible, and default off |

---

## 12. Appendix — verified notes from this environment

Checked on 2026-10-23 with **Chrome 155.0.8059.85** (headless, macOS), page at
`http://127.0.0.1`:

1. **Cross-tab visibility is real.** Tab A held an exclusive lock; tab B queued
   the same name. A `query()` from tab A returned A's lock in `held` and B's
   request in `pending`, with distinct `clientId`s. Shared locks from both tabs
   coexisted; releasing A woke B. This is the core assumption of the product.
2. **Isolated worlds share the lock manager but not the client id.** A CDP
   isolated world could see and hold locks visible from the main world, but its
   `clientId` differed from the main world's. This is a proxy for a content
   script and implies any tab-probe must run in the MAIN world. Confirm with a
   real content script in M0.
3. **Unpacked extension loading via CLI did not work in this branded Chrome**
   (no content-script context appeared). Plan for manual `chrome://extensions →
   Load unpacked`, and use Chrome for Testing only if automation is needed.
4. **DevTools eval gained a promise form in Chrome 151**, and the old
   `awaitPromise`/`returnByValue` options are gone from the public typings. The
   callback overload still exists, which is why the design uses the callback
   form plus a synchronous `snapshot()` instead of returning a page promise.

References:

- MDN, [`LockManager.query()`](https://developer.mozilla.org/en-US/docs/Web/API/LockManager/query)
- MDN, [`LockManager.request()`](https://developer.mozilla.org/en-US/docs/Web/API/LockManager/request)
- Chrome for Developers, [`chrome.devtools.inspectedWindow`](https://developer.chrome.com/docs/extensions/reference/api/devtools/inspectedWindow)
- Chrome for Developers, [Extending DevTools](https://developer.chrome.com/docs/extensions/how-to/devtools/extend-devtools)
- W3C, [Web Locks API](https://w3c.github.io/web-locks/)
