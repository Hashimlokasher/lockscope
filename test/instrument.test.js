import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const TOKEN = "testtoken";
const source = fs
  .readFileSync(new URL("../extension/instrument.js", import.meta.url), "utf8")
  .replaceAll("__LOCKSCOPE_INSTRUMENT_TOKEN__", TOKEN);

function harness() {
  let clock = 1000;
  class FakeLockManager {
    constructor() {
      this.mode = "exclusive";
      this.busy = false;
    }

    request(name, options, callback) {
      let opts = options;
      let cb = callback;
      if (typeof options === "function") {
        cb = options;
        opts = {};
      }
      if (typeof cb !== "function") throw new TypeError("callback required");
      if (opts.ifAvailable && this.busy) return Promise.resolve();
      return Promise.resolve().then(() =>
        cb({ name, mode: opts.mode || "exclusive" }),
      );
    }
  }

  const original = FakeLockManager.prototype.request;
  const context = {
    LockManager: FakeLockManager,
    performance: {
      timeOrigin: 1000,
      now: () => {
        clock += 5;
        return clock;
      },
    },
    Error,
    Promise,
    console,
    setInterval: () => 1,
    clearInterval: () => {},
  };

  vm.createContext(context);
  context.window = context;
  const result = vm.runInContext(source, context);
  const api = context[`__lockscope_instrument_${TOKEN}`];

  return { api, result, LockManager: FakeLockManager, original, context };
}

test("instrumentation records app requests and ignores LockScope probes", async () => {
  const { api, result, LockManager } = harness();
  assert.equal(result.installed, true);

  const manager = new LockManager();
  await manager.request("app-lock", async () => {});
  await Promise.resolve();
  await Promise.resolve();

  const snapshot = api.snapshot();
  assert.equal(snapshot.installed, true);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].name, "app-lock");
  assert.equal(snapshot.records[0].outcome, "released");
  assert.ok(snapshot.records[0].acquiredAt >= snapshot.records[0].requestedAt);

  await manager.request("__lockscope_internal_probe_test", async () => {});
  await Promise.resolve();
  assert.equal(api.snapshot().records.length, 1);
});

test("an ifAvailable request that is skipped is recorded without an acquire", async () => {
  const { api, LockManager } = harness();
  const manager = new LockManager();
  manager.busy = true;

  await manager.request("busy-lock", { ifAvailable: true }, async () => {});
  await Promise.resolve();
  await Promise.resolve();

  const record = api.snapshot().records[0];
  assert.equal(record.name, "busy-lock");
  assert.equal(record.outcome, "skipped");
  assert.equal(record.acquiredAt, null);
});

test("re-injecting after uninstall re-installs the patch", async () => {
  const { api, LockManager, context } = harness();
  assert.equal(api.uninstall(), true);

  const second = vm.runInContext(source, context);
  assert.equal(second.installed, true);

  const manager = new LockManager();
  await manager.request("after-reinstall", async () => {});
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(api.snapshot().records[0].name, "after-reinstall");
});

test("uninstall restores the original request method", () => {
  const { api, LockManager, original } = harness();
  assert.notEqual(LockManager.prototype.request, original);
  assert.equal(api.uninstall(), true);
  assert.equal(LockManager.prototype.request, original);
});
