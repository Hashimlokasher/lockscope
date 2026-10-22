# Contributing

Thanks for taking a look at LockScope. This is a small, dependency-free extension;
the best contributions are focused bug fixes, test coverage, and demo scenarios.

## Development setup

Requirements:

- Chrome 120 or newer;
- Node.js 20 or newer;
- Python 3 for the demo server;
- `zip` for packaging.

There is no build step and no `npm install` required.

```bash
npm test
npm run check
npm run demo
```

Load `extension/` via `chrome://extensions` → **Load unpacked**, open
`http://localhost:8080/`, and select the **LockScope** panel in DevTools.

## Code layout

- `extension/panel/model.js` — pure snapshot → lanes/intervals model. Keep it
  dependency-free and testable; add tests with behavior changes.
- `extension/panel/timeline.js` — canvas renderer; no continuous animation.
- `extension/panel/panel.js` — DevTools integration and DOM; no framework.
- `extension/page-agent.js` — sampling agent injected into the page.
- `extension/instrument.js` — opt-in, reversible `LockManager.request` patch.
- `demo/` — scenarios and a worker; useful as a manual test harness.

## Guidelines

- Plain ES modules, no runtime dependencies, no bundler.
- Use `textContent` for page-controlled strings; never inject lock names/titles
  as HTML.
- Keep the base extension at **zero required permissions**. New permissions must
  be optional and justified.
- Duration labels are lower bounds unless they come from instrumentation.
- Keep public behavior covered by a unit test or a step in
  `docs/manual-tests.md`.
- Do not commit `dist/` or generated zips.

## Pull requests

1. Fork and create a topic branch.
2. Make the change and add/update tests.
3. Run `npm test && npm run check`.
4. If UI behavior changed, add a screenshot to the PR description.
5. Open the PR using the template and describe the manual verification.

## Releases

1. Update the version in `extension/manifest.json`, `package.json`, and
   `docs/plan.md`.
2. Add a `CHANGELOG.md` entry.
3. Run `npm run package` and load the unzipped artifact once.
4. Attach `dist/lockscope-<version>.zip` to the release.
5. Update the Chrome Web Store listing when applicable.
