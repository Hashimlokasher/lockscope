/**
 * LockScope — page agent.
 *
 * Injected into the inspected page's main world by the panel. It samples
 * navigator.locks.query() and exposes a synchronous snapshot so the panel never
 * has to await a page promise across the DevTools boundary.
 *
 * The global name is random per DevTools session; internal locks use the same
 * prefix and are filtered out before the panel sees them.
 */
(() => {
  "use strict";

  const TOKEN = "__LOCKSCOPE_TOKEN__";
  const KEY = `__lockscope_${TOKEN}`;
  const PREFIX = "__lockscope_internal_";
  const PROBE = `${PREFIX}probe_${TOKEN}`;
  const IDLE_STOP_MS = 30_000;

  if (window[KEY] && window[KEY].version === 1) {
    return { ok: true, reused: true, token: TOKEN };
  }

  let selfClientId = null;
  let timer = null;
  let lastInterval = 500;
  let inFlight = false;
  let lastRead = Date.now();
  let last = {
    t: Date.now(),
    url: location.href,
    held: [],
    pending: [],
    selfClientId: null,
    ok: true,
  };

  const isInternal = (lock) =>
    typeof lock?.name === "string" && lock.name.startsWith(PREFIX);

  async function probeSelf() {
    if (!navigator.locks) return;
    try {
      await navigator.locks.request(PROBE, { ifAvailable: true }, async (lock) => {
        if (!lock) return;
        const state = await navigator.locks.query();
        const me = state.held.find((entry) => entry.name === PROBE);
        if (me) {
          selfClientId = me.clientId;
          last = { ...last, selfClientId };
        }
      });
    } catch {
      // The document may be navigating away; the next sample will retry.
    }
  }

  async function refresh() {
    if (inFlight) return;

    if (!navigator.locks) {
      last = {
        ...last,
        t: Date.now(),
        url: location.href,
        selfClientId,
        ok: false,
        error:
          "navigator.locks is unavailable on this page. Web Locks requires a secure context (HTTPS or localhost).",
      };
      return;
    }

    inFlight = true;
    try {
      const state = await navigator.locks.query();
      last = {
        t: Date.now(),
        url: location.href,
        held: state.held.filter((lock) => !isInternal(lock)),
        pending: state.pending.filter((lock) => !isInternal(lock)),
        selfClientId,
        ok: true,
      };
    } catch (error) {
      last = {
        ...last,
        t: Date.now(),
        url: location.href,
        selfClientId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      inFlight = false;
    }
  }

  function stop() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    return true;
  }

  function start(ms) {
    stop();
    const every = Math.max(100, Math.min(2000, Number(ms) || 500));
    lastInterval = every;
    timer = setInterval(() => {
      if (Date.now() - lastRead > IDLE_STOP_MS) {
        stop();
        return;
      }
      void refresh();
    }, every);
    void refresh();
    return true;
  }

  window[KEY] = {
    version: 1,
    start,
    stop,
    snapshot() {
      lastRead = Date.now();
      if (timer === null) start(lastInterval);
      return last;
    },
    selfClientId() {
      return selfClientId;
    },
  };

  void probeSelf();
  start(500);

  return { ok: true, reused: false, token: TOKEN, url: location.href };
})()
