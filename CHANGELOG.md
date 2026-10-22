# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-10-23

### Added

- Opt-in instrumentation that patches `LockManager.request` for exact
  request/acquire/release times and await-site stacks.
- **Exact** dock tab with record status, flags, live timings, stacks, and clear.
- Chrome Web Store packaging: `npm run package`, listing copy, privacy policy,
  and two 1280×800 screenshots.
- CI workflow, contributing guide, code of conduct, security policy, and this
  changelog.
- Public landing/privacy site with a GitHub Pages deployment workflow.

### Changed

- README, docs, and project layout aligned with a standard GitHub repository.
- Split the 1,400-line `panel.js` into focused modules: `lanes.js`, `tabs.js`,
  `instrumentation.js`, and `exact.js`.
- Packaging validation now requires every panel module.
- Optional tab labels no longer request the `tabs` permission; host access is
  enough to read matching tab URLs and titles.

### Fixed

- Instrumentation can be toggled off and back on without reloading the page.
- LockScope's internal probe locks no longer appear as instrumented records.
- The tab-labels button is disabled while the panel is in a fatal state.
- Instrumentation unit tests now cover skipping internal requests,
  `ifAvailable`, re-installation, and uninstall.
- Instrumentation now auto-uninstalls after two minutes without a panel
  heartbeat, and marks preempted holders explicitly.
- Internal lock names use a narrower `__lockscope_internal_*` prefix so ordinary
  app locks named `__lockscope_*` remain visible.
- Preempted holders are reported as `Preempted` in the Exact view.

### Security

- Optional tab labels remain scoped to the inspected origin and are requested
  only from a user gesture.
- Instrumentation is reversible, off by default, and limited to the inspected
  page's main world.

## [0.5.0] - 2026-10-23

### Added

- Optional per-origin tab labels using `scripting` and host permissions.
- MAIN-world probe mapping from `clientId` to tab title.

## [0.4.0] - 2026-10-23

### Added

- Ten-scenario demo: abort-before/after-grant, `ifAvailable`, `steal`,
  worker-held lock, and a two-tab `BroadcastChannel` deadlock.
- Manual test sheet.

## [0.3.0] - 2026-10-23

### Added

- Canvas timeline with 15 s / 60 s / 5 m windows, stacked held/waiting bars, and
  hover details.
- Timeline interval model and tests.

## [0.2.0] - 2026-10-23

### Added

- Snapshot diff model with pending → held transitions, queue positions,
  lower-bound durations, pause-gap exclusion, clear, and stats.
- Contention lanes and name/mode filters.

## [0.1.0] - 2026-10-23

### Added

- Initial Manifest V3 DevTools panel with a live held/pending table.
- MAIN-world page agent, cross-tab sampling, `this tab` badge, pause, and theme
  support.
- Demo page and zero-permission manifest.
