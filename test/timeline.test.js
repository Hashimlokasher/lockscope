import assert from "node:assert/strict";
import test from "node:test";

import { createModel } from "../extension/panel/model.js";

const held = (name, clientId = "c1", mode = "exclusive") => ({ name, mode, clientId });
const pending = (name, clientId = "c1", mode = "exclusive") => ({ name, mode, clientId });
const snap = (t, heldLocks = [], pendingLocks = []) => ({ t, held: heldLocks, pending: pendingLocks });

test("timeline exposes active intervals with an open end", () => {
  const model = createModel();
  model.apply(snap(1000, [held("resource-a")], [pending("resource-b", "c2")]), 1000);

  const timeline = model.intervals(2500);
  assert.equal(timeline.now, 2500);
  assert.equal(timeline.intervals.length, 2);

  const a = timeline.intervals.find((row) => row.name === "resource-a");
  assert.equal(a.state, "held");
  assert.equal(a.start, 1000);
  assert.equal(a.end, null);

  const b = timeline.intervals.find((row) => row.name === "resource-b");
  assert.equal(b.state, "pending");
  assert.equal(b.waitMs, 1500);
});

test("timeline keeps closed intervals after a lock disappears", () => {
  const model = createModel();
  model.apply(snap(1000, [held("resource-a")]), 1000);
  model.apply(snap(3000, [], []), 3000);

  const timeline = model.intervals(4000);
  assert.equal(timeline.intervals.length, 1);
  const closed = timeline.intervals[0];
  assert.equal(closed.start, 1000);
  assert.equal(closed.end, 3000);
  assert.equal(closed.state, "held");
});

test("timeline splits a wait and a hold at the transition", () => {
  const model = createModel();
  model.apply(snap(1000, [], [pending("resource-a", "c1")]), 1000);
  model.apply(snap(1800, [held("resource-a", "c1")], []), 1800);

  const timeline = model.intervals(2000);
  const wait = timeline.intervals.find((row) => row.state === "pending");
  const hold = timeline.intervals.find((row) => row.state === "held");

  assert.equal(wait.start, 1000);
  assert.equal(wait.end, 1800);
  assert.equal(hold.start, 1800);
  assert.equal(hold.end, null);
});

test("timeline freezes at the pause time", () => {
  const model = createModel();
  model.apply(snap(1000, [held("resource-a")]), 1000);
  model.pause(2000);

  const timeline = model.intervals(10_000);
  assert.equal(timeline.now, 2000);
  assert.equal(timeline.paused, true);
  assert.equal(timeline.intervals[0].end, null);
});
