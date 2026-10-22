# LockScope manual test sheet

Run against a headed Chrome (stable or Chrome for Testing) with the extension
loaded unpacked. Use the demo page unless a step says otherwise.

## Setup

```bash
cd lockscope
python3 -m http.server 8080 --directory demo
```

1. `chrome://extensions` → Developer mode → **Load unpacked** → `extension/`.
2. Open `http://localhost:8080/`.
3. Open DevTools (⌥⌘I / F12) and select the **LockScope** panel.
4. Keep the demo page's **Activity** log visible; it narrates each step.

## Core

| # | Steps | Expected | Pass |
| --- | --- | --- | --- |
| 1 | Open the panel on a page with no locks | Empty state, no errors, timeline says no activity | ☐ |
| 2 | **Hold 8 s** | One `resource-a` lane, held row, duration grows; timeline shows a solid bar | ☐ |
| 3 | **Queue 3** | `1 held · 3 waiting`, waiters `#1`–`#3`, `≥` waits grow, all three marked `this tab` | ☐ |
| 4 | **Readers + writer** | Three shared `resource-b` holders, then one exclusive waiter; writer gets the lock after readers release | ☐ |
| 5 | **Open second tab** | Holder appears from the other tab; `this tab` is absent on that row | ☐ |
| 6 | Close the holder tab | Its bar/lane closes within ~1 s; the waiter becomes holder | ☐ |

## Edge cases

| # | Steps | Expected | Pass |
| --- | --- | --- | --- |
| 7 | **Abort queued** | Pending `abort-queued` appears, then disappears at ~1 s; holder remains until its timer ends | ☐ |
| 8 | **Abort granted** | `abort-granted` is acquired, `abort()` is called, and the row stays held until the 3 s timer ends | ☐ |
| 9 | **Try ifAvailable** | No pending entry is created; log says skipped/settled | ☐ |
| 10 | **Steal lock** | `steal-demo` changes hands; original log says preempted; stealer holds for ~3 s | ☐ |
| 11 | **Start worker** | `worker-lock` appears with a different `clientId`; **Release all** terminates the worker and clears it | ☐ |
| 12 | **Start deadlock** | Second tab opens; panel shows 2 held (`deadlock-a`, `deadlock-b`) and 2 waiting; timeline has four bars. **Release all** clears both tabs | ☐ |

## Controls and states

| # | Steps | Expected | Pass |
| --- | --- | --- | --- |
| 13 | Pause during a wait, wait 5 s, resume | Durations freeze while paused and do not jump by the paused gap | ☐ |
| 14 | **Clear** while locks are held | Durations restart at 0; lanes and locks stay | ☐ |
| 15 | Filter `deadlock`, then a non-matching name | Only matching lanes; empty state says "No matching locks"; timeline follows the filter | ☐ |
| 16 | Mode filter `shared` / `exclusive` | Only matching rows; queue positions stay global | ☐ |
| 17 | Timeline `15s` / `60s` / `5m`, then hover a bar | Axis rescales; tooltip shows name, mode, duration, client, start age | ☐ |
| 18 | Navigate the inspected tab twice, then to `chrome://settings/` | Navigation resets lanes/timeline; `chrome://` shows the fatal state and hides the timeline; back recovers | ☐ |
| 19 | Resize the panel to ~420 px | No horizontal overflow; mode text hides; timeline still usable | ☐ |
| 20 | Run **Queue 3** for 2 minutes | Timeline scrolls, history capped, memory stable, no dropped frames | ☐ |

## Optional tab labels

| # | Steps | Expected | Pass |
| --- | --- | --- | --- |
| 21 | Fresh install of the shipped `extension/` | No site-access or permission warning; panel works without granting anything | ☐ |
| 22 | Click **Tab labels** on `localhost` | Chrome asks for `scripting` + this origin only; after accepting, holders show tab titles; clicking again hides them | ☐ |
| 23 | With labels on, navigate to a different origin | Labels disable with a permission message; clicking again asks for the new origin | ☐ |
| 24 | After granting once, reopen DevTools | Labels stay off until clicked, but the grant is reused without a second prompt | ☐ |

## Instrumentation (Exact)

| # | Steps | Expected | Pass |
| --- | --- | --- | --- |
| 25 | Click **Instrument**; trigger **Queue 3** | Exact tab opens; three records with exact waits/holds; stacks point at the demo's `hold`/`queue` functions | ☐ |
| 26 | Expand a record | Stack is readable and excludes LockScope wrapper frames | ☐ |
| 27 | **Clear** in the Exact tab | Records clear; instrumentation stays installed and new requests appear | ☐ |
| 28 | Click **Instrument** again | Button off, panel returns to Timeline; in the page console `LockManager.prototype.request.toString()` includes `[native code]` | ☐ |
| 29 | Instrument, then navigate the tab | Exact records reset; instrumentation is re-applied automatically on the new page | ☐ |
| 30 | Instrument on `chrome://settings/` | Injection fails cleanly with an error message; no page crash | ☐ |

## Package

| # | Steps | Expected | Pass |
| --- | --- | --- | --- |
| 31 | `npm run package`, unzip to a clean folder, load unpacked | Extension enables with no manifest/runtime/install warnings; panel works from the unpacked zip | ☐ |

## Notes

- Headless CDP runs use a hidden panel; `requestAnimationFrame` is paused there,
  and the timeline draws synchronously. Manual headed runs should use normal rAF.
- Waits are lower bounds: `query()` has no timestamps, so `≥` is intentional.
- If a test leaves locks held, click **Release all** in every demo tab or close
  the tabs.
