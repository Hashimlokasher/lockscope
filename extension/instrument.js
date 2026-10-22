/**
 * LockScope — opt-in instrumentation.
 *
 * Patches LockManager.prototype.request in the inspected page's MAIN world to
 * record exact request/acquire/release times and await-site stacks. The patch is
 * reversible and only installed after the user clicks "Instrument".
 */
(() => {
  "use strict";

  const TOKEN = "__LOCKSCOPE_INSTRUMENT_TOKEN__";
  const KEY = `__lockscope_instrument_${TOKEN}`;
  const MAX_RECORDS = 300;
  const MAX_STACK_LINES = 9;
  const HEARTBEAT_TIMEOUT = 120_000;
  const HEARTBEAT_CHECK = 10_000;

  if (window[KEY] && window[KEY].version === 1) {
    // Re-enable after an uninstall without requiring a page reload.
    return { ok: true, reused: true, installed: window[KEY].install() };
  }

  const records = [];
  let nextId = 1;
  let installed = false;
  let original = null;
  let wrapped = null;
  let lastSeen = Date.now();
  let watchdog = null;

  function epoch() {
    return performance.timeOrigin + performance.now();
  }

  function recordStack() {
    const raw = new Error().stack || "";
    return raw
      .split("\n")
      .slice(1)
      .slice(2)
      .filter((line) => !line.includes("__lockscope") && !line.includes("instrument.js"))
      .slice(0, MAX_STACK_LINES)
      .join("\n");
  }

  function push(record) {
    records.push(record);
    if (records.length > MAX_RECORDS) {
      records.splice(0, records.length - MAX_RECORDS);
    }
  }

  function optionsOf(options) {
    const value = options && typeof options === "object" ? options : {};
    return {
      mode: value.mode === "shared" ? "shared" : "exclusive",
      ifAvailable: Boolean(value.ifAvailable),
      steal: Boolean(value.steal),
      signal: Boolean(value.signal),
    };
  }

  function install() {
    if (installed) {
      lastSeen = Date.now();
      startWatchdog();
      return true;
    }

    const proto = globalThis.LockManager && globalThis.LockManager.prototype;
    if (!proto || typeof proto.request !== "function") return false;

    original = proto.request;
    wrapped = function request(name, options, callback) {
      let opts = options;
      let cb = callback;

      if (typeof options === "function") {
        cb = options;
        opts = {};
      }
      if (typeof cb !== "function") {
        return original.apply(this, arguments);
      }

      // LockScope's own probe locks (page agent and tab labels) are internal.
      if (String(name).startsWith("__lockscope_internal_")) {
        return original.apply(this, arguments);
      }

      const meta = optionsOf(opts);
      const record = {
        id: nextId,
        name: String(name),
        mode: meta.mode,
        ifAvailable: meta.ifAvailable,
        steal: meta.steal,
        signal: meta.signal,
        requestedAt: epoch(),
        acquiredAt: null,
        releasedAt: null,
        outcome: "queued",
        stack: recordStack(),
      };
      nextId += 1;
      push(record);

      const wrappedCallback = function onLock(lock) {
        record.acquiredAt = epoch();
        record.outcome = "held";

        let result;
        try {
          result = cb.call(this, lock);
        } catch (error) {
          record.releasedAt = epoch();
          record.outcome = "threw";
          throw error;
        }

        Promise.resolve(result).then(
          () => {
            if (record.outcome !== "preempted") {
              record.releasedAt = epoch();
              record.outcome = "released";
            }
          },
          () => {
            if (record.outcome !== "preempted") {
              record.releasedAt = epoch();
              record.outcome = "rejected";
            }
          },
        );

        return result;
      };

      let promise;
      try {
        promise = original.call(this, name, opts, wrappedCallback);
      } catch (error) {
        record.releasedAt = epoch();
        record.outcome = "request-failed";
        throw error;
      }

      Promise.resolve(promise).then(
        () => {
          if (record.acquiredAt === null) {
            record.releasedAt = record.releasedAt || epoch();
            record.outcome = meta.ifAvailable ? "skipped" : "resolved";
          }
        },
        () => {
          if (record.acquiredAt === null) {
            record.releasedAt = epoch();
            record.outcome = "aborted";
          } else if (record.releasedAt === null) {
            // Most commonly a `steal: true` request preempting this holder.
            record.releasedAt = epoch();
            record.outcome = "preempted";
          }
        },
      );

      return promise;
    };

    proto.request = wrapped;
    installed = true;
    lastSeen = Date.now();
    startWatchdog();
    return true;
  }

  function startWatchdog() {
    if (watchdog || typeof setInterval !== "function") return;
    watchdog = setInterval(() => {
      if (Date.now() - lastSeen > HEARTBEAT_TIMEOUT) {
        uninstall();
      }
    }, HEARTBEAT_CHECK);
  }

  function uninstall() {
    const proto = globalThis.LockManager && globalThis.LockManager.prototype;
    if (proto && installed && proto.request === wrapped) {
      proto.request = original;
    }
    installed = false;

    if (watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }
    return true;
  }

  function snapshot() {
    lastSeen = Date.now();
    return {
      version: 1,
      installed,
      records: records.map((record) => ({ ...record })),
    };
  }

  function touch() {
    lastSeen = Date.now();
    return true;
  }

  function clear() {
    records.length = 0;
    return true;
  }

  window[KEY] = { version: 1, install, uninstall, snapshot, clear, touch };
  install();

  return { ok: true, reused: false, installed };
})()
