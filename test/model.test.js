import assert from "node:assert/strict";
import test from "node:test";

import { createModel } from "../extension/panel/model.js";

const held = (name, clientId = "c1", mode = "exclusive") => ({ name, mode, clientId });
const pending = (name, clientId = "c1", mode = "exclusive") => ({ name, mode, clientId });
const snap = (t, heldLocks = [], pendingLocks = []) => ({ t, held: heldLocks, pending: pendingLocks });

test("tracks a held lock and its observed duration", () => {
  const model = createModel();

  model.apply(snap(1000, [held("resource-a")]), 1000);
  let view = model.view(1000);
  assert.equal(view.totals.held, 1);
  assert.equal(view.totals.pending, 0);
  assert.equal(view.lanes[0].name, "resource-a");
  assert.equal(view.lanes[0].held[0].durationMs, 0);

  model.apply(snap(2000, [held("resource-a")]), 2000);
  view = model.view(2000);
  assert.equal(view.lanes[0].held[0].durationMs, 1000);
  assert.equal(view.stats.samples, 2);
});

test("a pending request keeps queue position and wait grows", () => {
  const model = createModel();

  model.apply(snap(1000, [], [pending("resource-a"), pending("resource-a", "c2")]), 1000);
  let view = model.view(1500);
  assert.equal(view.totals.pending, 2);
  assert.deepEqual(view.lanes[0].pending.map((row) => row.queue), [1, 2]);

  view = model.view(2500);
  assert.equal(view.lanes[0].pending[0].waitMs, 1500);
  assert.equal(view.stats.currentLongestWaitMs, 1500);
  assert.equal(view.stats.oldestWaitMs, 1500);
});

test("pending → held records the wait and starts a fresh hold timer", () => {
  const model = createModel();

  model.apply(snap(1000, [], [pending("resource-a")]), 1000);
  model.apply(snap(2000, [held("resource-a")], []), 2000);

  const view = model.view(2600);
  assert.equal(view.totals.pending, 0);
  assert.equal(view.totals.held, 1);
  assert.equal(view.lanes[0].held[0].durationMs, 600);
  assert.equal(view.stats.longestWaitMs, 1000);
  assert.equal(view.stats.history, 1);
});

test("a vanished waiter is recorded at the last observation", () => {
  const model = createModel();

  model.apply(snap(1000, [], [pending("resource-a")]), 1000);
  model.apply(snap(1500, [], []), 1500);

  const view = model.view(3000);
  assert.equal(view.totals.pending, 0);
  assert.equal(view.lanes.length, 0);
  assert.equal(view.stats.longestWaitMs, 500);
  assert.equal(view.stats.history, 1);
});

test("shared holders coexist and a vanished holder records its duration", () => {
  const model = createModel();

  model.apply(snap(1000, [held("resource-b", "c1", "shared"), held("resource-b", "c2", "shared")]), 1000);
  let view = model.view(3000);
  assert.equal(view.lanes[0].heldCount, 2);
  assert.equal(view.lanes[0].pendingCount, 0);
  assert.equal(view.stats.maxHeldMs, 2000);

  model.apply(snap(3000, [held("resource-b", "c1", "shared")]), 3000);
  view = model.view(3000);
  assert.equal(view.lanes[0].heldCount, 1);
  assert.equal(view.stats.history, 1);
});

test("duplicate identities are tracked separately", () => {
  const model = createModel();

  model.apply(snap(1000, [], [pending("resource-a", "c1"), pending("resource-a", "c1")]), 1000);
  let view = model.view(1000);
  assert.equal(view.lanes[0].pendingCount, 2);
  assert.notEqual(view.lanes[0].pending[0].key, view.lanes[0].pending[1].key);

  model.apply(
    snap(2000, [held("resource-a", "c1")], [pending("resource-a", "c1")]),
    2000,
  );
  view = model.view(2000);
  assert.equal(view.lanes[0].heldCount, 1);
  assert.equal(view.lanes[0].pendingCount, 1);
  assert.equal(view.stats.longestWaitMs, 1000);
});

test("pause freezes time and resume excludes the gap", () => {
  const model = createModel();

  model.apply(snap(1000, [held("resource-a")]), 1000);
  model.pause(2000);
  assert.equal(model.view(10_000).lanes[0].held[0].durationMs, 1000);

  model.resume(10_000);
  model.apply(snap(11_000, [held("resource-a")]), 11_000);
  assert.equal(model.view(11_000).lanes[0].held[0].durationMs, 2000);
});

test("clear restarts current clocks and drops history", () => {
  const model = createModel();

  model.apply(snap(1000, [held("resource-a")]), 1000);
  model.apply(snap(3000, [held("resource-a")]), 3000);
  model.clear(5000);

  const view = model.view(5000);
  assert.equal(view.lanes[0].held[0].durationMs, 0);
  assert.equal(view.stats.samples, 0);
  assert.equal(view.stats.longestWaitMs, 0);
  assert.equal(view.stats.history, 0);
});

test("reset drops lanes and stats", () => {
  const model = createModel();

  model.apply(snap(1000, [held("resource-a")], [pending("resource-b")]), 1000);
  model.reset();

  const view = model.view(5000);
  assert.equal(view.totals.locks, 0);
  assert.equal(view.lanes.length, 0);
  assert.equal(view.stats.samples, 0);
});

test("groups multiple lock names into lanes", () => {
  const model = createModel();

  model.apply(
    snap(1000, [held("a")], [pending("b", "c2"), pending("a", "c3")]),
    1000,
  );

  const view = model.view(2000);
  assert.deepEqual(view.lanes.map((lane) => lane.name), ["a", "b"]);
  assert.equal(view.lanes[0].heldCount, 1);
  assert.equal(view.lanes[0].pendingCount, 1);
  assert.equal(view.lanes[1].pendingCount, 1);
  assert.equal(view.totals.locks, 2);
});
