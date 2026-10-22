# Security policy

## Supported versions

The latest release on the default branch is supported. At the time of writing
this is `0.6.x`.

## Reporting a vulnerability

Please use **Security → Report a vulnerability** in this repository to open a
private advisory. Do not open a public issue for a suspected vulnerability.

Include:

- the extension version and Chrome version;
- a minimal reproduction or affected page;
- whether optional tab labels or instrumentation were enabled;
- the impact you believe is possible.

## Scope

LockScope is a local developer tool, not a security boundary.

Relevant reports include:

- extension code making network requests or exfiltrating inspected data;
- optional permissions being requested without a user gesture or outside the
  inspected origin;
- instrumentation being enabled without explicit action or failing to restore
  `LockManager.request`;
- injection or script execution in the DevTools panel from page-controlled data.

The following are expected, documented behavior:

- the inspected page can detect the page agent, probe locks, or the
  instrumentation patch;
- instrumentation observes promise settlements and can affect unhandled-rejection
  reporting;
- lock names, client IDs, tab titles, and stacks are readable by anyone with
  access to the DevTools session.

## Disclosure

We aim to acknowledge reports within a few days. Please allow time for a fix and
release before public disclosure.
