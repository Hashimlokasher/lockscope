# LockScope privacy policy

**Effective date:** 2026-10-23

LockScope is a Chrome DevTools extension for inspecting the Web Locks API. It is
designed to run entirely on your machine.

## What LockScope processes

While the panel is open, LockScope reads the Web Locks state of the page you are
inspecting:

- lock names, modes, and `clientId` values;
- lock timing derived from repeated `navigator.locks.query()` samples;
- if you enable tab labels, the titles and URLs of same-origin tabs;
- if you enable instrumentation, exact request/acquire/release timestamps and
  JavaScript stack traces from the inspected page.

## Where it goes

Nowhere. This data is held in memory for the DevTools session. LockScope has no
network code, no analytics, no telemetry, no accounts, and does not write lock
names, client IDs, tab titles, or stacks to disk.

## Permissions

The extension requires no permissions at install. Two features are opt-in:

- **Tab labels** ask for `scripting` and the inspected origin's host permission
  when you click the button. You can revoke them at any time in
  `chrome://extensions`.
- **Instrumentation** does not use a Chrome permission; it patches
  `LockManager.request` in the inspected page's main world. Toggle it off or
  navigate to remove the patch.

## Page modification

Instrumentation is the only feature that changes the inspected page. It wraps a
standard Web API to observe timing and stores records in a page global. It is
off by default and reversible.

## Third parties

LockScope does not share data with third parties and does not use remote code.

## Contact

For privacy questions, use the developer contact shown on the Chrome Web Store
listing.

## Changes

If this policy changes, the effective date will be updated. Material changes will
be noted in the project changelog.

---

This text is intended to be hosted at a public URL and linked from the Chrome Web
Store listing.
