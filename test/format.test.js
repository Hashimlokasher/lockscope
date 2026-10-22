import assert from "node:assert/strict";
import test from "node:test";

import {
  formatDuration,
  formatExact,
  formatInterval,
  formatUrl,
  modeLabel,
  originPattern,
  shortId,
} from "../extension/panel/format.js";

test("shortId truncates to eight characters by default", () => {
  assert.equal(shortId("0123456789abcdef"), "01234567");
  assert.equal(shortId("abc"), "abc");
  assert.equal(shortId(null), "");
  assert.equal(shortId(undefined), "");
});

test("shortId supports a custom length", () => {
  assert.equal(shortId("0123456789", 4), "0123");
});

test("modeLabel covers both lock modes and unknown values", () => {
  assert.equal(modeLabel("exclusive"), "Exclusive");
  assert.equal(modeLabel("shared"), "Shared");
  assert.equal(modeLabel("weird"), "weird");
  assert.equal(modeLabel(undefined), "—");
});

test("formatInterval switches to seconds at 1000 ms", () => {
  assert.equal(formatInterval(500), "500 ms");
  assert.equal(formatInterval(100), "100 ms");
  assert.equal(formatInterval(1000), "1 s");
  assert.equal(formatInterval(1500), "1.5 s");
});

test("formatDuration keeps short values readable", () => {
  assert.equal(formatDuration(0), "0.0 s");
  assert.equal(formatDuration(420), "0.4 s");
  assert.equal(formatDuration(1400), "1.4 s");
  assert.equal(formatDuration(12_400), "12 s");
  assert.equal(formatDuration(64_000), "1m 04s");
  assert.equal(formatDuration(undefined), "0.0 s");
});

test("formatExact keeps sub-second precision", () => {
  assert.equal(formatExact(0), "0 ms");
  assert.equal(formatExact(12.4), "12 ms");
  assert.equal(formatExact(999), "999 ms");
  assert.equal(formatExact(1234), "1.23 s");
  assert.equal(formatExact(12_400), "12 s");
});

test("originPattern produces a scoped optional-host pattern", () => {
  assert.equal(originPattern("https://example.com/a/b"), "https://example.com/*");
  assert.equal(originPattern("http://localhost:8080/demo/"), "http://localhost:8080/*");
  assert.equal(originPattern("chrome://settings/"), null);
  assert.equal(originPattern("not a url"), null);
  assert.equal(originPattern(undefined), null);
});

test("formatUrl keeps host and path but drops the scheme", () => {
  assert.equal(formatUrl("http://localhost:8080/demo/?tab=2#x"), "localhost:8080/demo/?tab=2#x");
  assert.equal(formatUrl("https://example.com/"), "example.com");
  assert.equal(formatUrl(""), "");
  assert.equal(formatUrl("not a url"), "not a url");
  assert.equal(formatUrl("chrome://settings/"), "chrome://settings/");
});
