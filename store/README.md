# Store assets

- `listing.md` — copy for the Chrome Web Store form, including permission
  justifications and single-purpose text.
- `privacy-policy.md` — privacy policy; host it at a public URL before submitting.
- `screenshot-1.png` — 1280×800, lanes + timeline.
- `screenshot-2.png` — 1280×800, Exact instrumentation.

## Build the upload

```bash
npm run package
# -> dist/lockscope-<version>.zip
```

The archive contains only `extension/` contents (manifest, DevTools bootstrap,
page agent, instrumentation, panel, icons). Development assets, demo, tests, and
store files are excluded.

## Checklist

1. Bump `version` in `extension/manifest.json` and `package.json`, and update the
   status line in `docs/plan.md`.
2. Run `npm test` and `npm run check`.
3. Run `npm run package`, unzip to a clean folder, load it unpacked, and smoke
   test the panel.
4. Enable GitHub Pages (the `Deploy privacy site` workflow publishes `site/`),
   then use `https://<owner>.github.io/<repo>/privacy.html` in the listing.
   Replace the `<owner>/<repo>` placeholders in `store/listing.md`.
5. Upload `dist/lockscope-<version>.zip`.
6. Upload the two screenshots and `extension/icons/icon128.png`.
7. Paste the text from `listing.md`; declare no remote code and no data
   collection.
