/**
 * Snapshot → contention model for LockScope.
 *
 * Web Locks has no events and no timestamps: every duration here is derived by
 * comparing successive `navigator.locks.query()` snapshots. All times are
 * therefore lower bounds, and short-lived locks can be missed entirely.
 *
 * The model is pure and dependency-free so Node can test it without a browser.
 */

const MAX_HISTORY = 5000;

/**
 * @typedef {{name: string, mode: string, clientId: string}} LockInfo
 * @typedef {{t?: number, held?: LockInfo[], pending?: LockInfo[]}} Snapshot
 * @typedef {'held' | 'pending'} LockState
 */

export function createModel() {
  /** @type {Map<string, any>} */
  let active = new Map();
  /** @type {any[]} */
  let history = [];
  let seq = 0;
  let lastNow = 0;
  let pausedAt = 0;
  let paused = false;
  let samples = 0;
  let startedAt = 0;
  let longestWaitMs = 0;
  let maxHeldMs = 0;

  /**
   * @param {Snapshot | null | undefined} snapshot
   * @param {number} [now]
   */
  function apply(snapshot, now = snapshot?.t ?? Date.now()) {
    if (!snapshot || paused) return;

    const held = Array.isArray(snapshot.held) ? snapshot.held : [];
    const pending = Array.isArray(snapshot.pending) ? snapshot.pending : [];
    const at = Math.max(Number(now) || Date.now(), lastNow);

    lastNow = at;
    if (!startedAt) startedAt = at;
    samples += 1;

    for (const entry of active.values()) {
      entry._seen = false;
      entry._matched = false;
    }

    const heldByBase = indexByBase(active.values(), "held");
    const pendingByBase = indexByBase(active.values(), "pending");

    for (const raw of held) {
      const base = baseKey(raw);
      let entry = take(heldByBase, base);

      if (!entry) {
        const waiting = take(pendingByBase, base);
        if (waiting) {
          recordWait(waiting, at);
          active.delete(waiting.key);
          waiting.state = "held";
          waiting.since = at;
          waiting._seen = true;
          waiting._matched = true;
          active.set(waiting.key, waiting);
          entry = waiting;
        } else {
          entry = create(raw, "held", at);
        }
      }

      update(entry, raw);
      entry._seen = true;
      entry._matched = true;
    }

    for (let index = 0; index < pending.length; index += 1) {
      const raw = pending[index];
      const base = baseKey(raw);
      let entry = take(pendingByBase, base);

      if (!entry) entry = create(raw, "pending", at);

      update(entry, raw);
      entry.order = index;
      entry._seen = true;
      entry._matched = true;
    }

    for (const [key, entry] of [...active]) {
      if (!entry._seen) {
        close(entry, at);
        active.delete(key);
      } else {
        entry._matched = false;
      }
    }
  }

  /**
   * Freeze elapsed time at `now`. The panel stops polling while paused.
   * @param {number} [now]
   */
  function pause(now = Date.now()) {
    if (paused) return;
    pausedAt = Math.max(Number(now) || Date.now(), lastNow);
    paused = true;
  }

  /**
   * Resume without counting the paused gap: every open interval is shifted
   * forward by the gap, so time spent paused is neither hold nor wait time.
   * @param {number} [now]
   */
  function resume(now = Date.now()) {
    if (!paused) return;

    const at = Math.max(Number(now) || Date.now(), pausedAt);
    const gap = at - pausedAt;

    for (const entry of active.values()) {
      entry.since += gap;
      entry.waitSince += gap;
    }

    paused = false;
    pausedAt = 0;
    lastNow = at;
  }

  /**
   * Keep the current entries but restart their clocks and drop history/stats.
   * @param {number} [now]
   */
  function clear(now = Date.now()) {
    const at = Math.max(Number(now) || Date.now(), lastNow, pausedAt);

    history = [];
    samples = 0;
    startedAt = at;
    lastNow = at;
    longestWaitMs = 0;
    maxHeldMs = 0;
    if (paused) pausedAt = at;

    for (const entry of active.values()) {
      entry.since = at;
      entry.waitSince = at;
      entry.waitMs = 0;
    }
  }

  /** Drop everything, e.g. after navigation. */
  function reset() {
    active = new Map();
    history = [];
    seq = 0;
    lastNow = 0;
    pausedAt = 0;
    paused = false;
    samples = 0;
    startedAt = 0;
    longestWaitMs = 0;
    maxHeldMs = 0;
  }

  /**
   * @param {number} [now]
   */
  function view(now = Date.now()) {
    const at = paused ? pausedAt : Math.max(lastNow, Number(now) || Date.now());
    /** @type {Map<string, {name: string, held: any[], pending: any[]}>} */
    const lanes = new Map();

    let currentLongestWaitMs = 0;
    let currentMaxHeldMs = 0;
    let heldCount = 0;
    let pendingCount = 0;

    for (const entry of active.values()) {
      const durationMs = Math.max(0, at - entry.since);
      const waitMs = Math.max(0, at - entry.waitSince);
      const row = {
        key: entry.key,
        name: entry.name,
        mode: entry.mode,
        clientId: entry.clientId,
        state: entry.state,
        durationMs,
        waitMs,
      };

      let lane = lanes.get(entry.name);
      if (!lane) {
        lane = { name: entry.name, held: [], pending: [] };
        lanes.set(entry.name, lane);
      }

      if (entry.state === "held") {
        lane.held.push(row);
        heldCount += 1;
        currentMaxHeldMs = Math.max(currentMaxHeldMs, durationMs);
      } else {
        lane.pending.push({ ...row, order: entry.order });
        pendingCount += 1;
        currentLongestWaitMs = Math.max(currentLongestWaitMs, waitMs);
      }
    }

    const laneList = [...lanes.values()].sort((a, b) => a.name.localeCompare(b.name));
    let oldestWaitMs = 0;

    for (const lane of laneList) {
      lane.held.sort((a, b) => b.durationMs - a.durationMs || a.key.localeCompare(b.key));
      lane.pending.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));

      lane.pending = lane.pending.map((row, index) => {
        const { order, ...rest } = row;
        return { ...rest, queue: index + 1 };
      });

      lane.heldCount = lane.held.length;
      lane.pendingCount = lane.pending.length;
      lane.oldestWaitMs = lane.pending.reduce(
        (max, row) => Math.max(max, row.waitMs),
        0,
      );
      lane.entries = lane.heldCount + lane.pendingCount;
      oldestWaitMs = Math.max(oldestWaitMs, lane.oldestWaitMs);
    }

    return {
      now: at,
      paused,
      lanes: laneList,
      totals: { held: heldCount, pending: pendingCount, locks: laneList.length },
      stats: {
        samples,
        startedAt,
        uptimeMs: startedAt ? Math.max(0, at - startedAt) : 0,
        currentLongestWaitMs,
        longestWaitMs: Math.max(longestWaitMs, currentLongestWaitMs),
        maxHeldMs: Math.max(maxHeldMs, currentMaxHeldMs),
        oldestWaitMs,
        history: history.length,
      },
    };
  }

  /**
   * Active and completed intervals for the timeline. `end: null` means still
   * open at the returned `now`.
   * @param {number} [now]
   */
  function intervals(now = Date.now()) {
    const at = paused ? pausedAt : Math.max(lastNow, Number(now) || Date.now());
    const out = [];

    for (const entry of active.values()) {
      const start = entry.state === "held" ? entry.since : entry.waitSince;
      out.push({
        key: entry.key,
        name: entry.name,
        mode: entry.mode,
        clientId: entry.clientId,
        state: entry.state,
        start,
        end: null,
        waitMs: entry.state === "pending" ? Math.max(0, at - start) : entry.waitMs || 0,
      });
    }

    for (const interval of history) {
      out.push({
        key: interval.key,
        name: interval.name,
        mode: interval.mode,
        clientId: interval.clientId,
        state: interval.state,
        start: interval.start,
        end: interval.end,
        waitMs: interval.waitMs || 0,
      });
    }

    return { now: at, paused, intervals: out };
  }

  function create(raw, state, at) {
    const base = baseKey(raw);
    seq += 1;
    const entry = {
      key: `k${seq}`,
      base,
      name: String(raw.name ?? ""),
      mode: String(raw.mode ?? ""),
      clientId: String(raw.clientId ?? ""),
      state,
      since: at,
      waitSince: at,
      waitMs: 0,
      order: 0,
      _seen: true,
      _matched: true,
    };
    active.set(entry.key, entry);
    return entry;
  }

  function update(entry, raw) {
    entry.name = String(raw.name ?? "");
    entry.mode = String(raw.mode ?? "");
    entry.clientId = String(raw.clientId ?? "");
  }

  function indexByBase(entries, state) {
    const map = new Map();
    for (const entry of entries) {
      if (entry.state !== state) continue;
      const list = map.get(entry.base);
      if (list) list.push(entry);
      else map.set(entry.base, [entry]);
    }

    if (state === "pending") {
      for (const list of map.values()) {
        list.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
      }
    }
    return map;
  }

  function take(map, base) {
    const list = map.get(base);
    if (!list) return null;
    for (const entry of list) {
      if (!entry._matched) {
        entry._matched = true;
        return entry;
      }
    }
    return null;
  }

  function recordWait(entry, at) {
    const waitMs = Math.max(0, at - entry.waitSince);
    entry.waitMs = waitMs;
    longestWaitMs = Math.max(longestWaitMs, waitMs);
    pushHistory({
      key: entry.key,
      name: entry.name,
      mode: entry.mode,
      clientId: entry.clientId,
      state: "pending",
      start: entry.waitSince,
      end: at,
      waitMs,
    });
  }

  function close(entry, at) {
    if (entry.state === "pending") {
      recordWait(entry, at);
      return;
    }

    const durationMs = Math.max(0, at - entry.since);
    maxHeldMs = Math.max(maxHeldMs, durationMs);
    pushHistory({
      key: entry.key,
      name: entry.name,
      mode: entry.mode,
      clientId: entry.clientId,
      state: "held",
      start: entry.since,
      end: at,
      waitMs: entry.waitMs || 0,
    });
  }

  function pushHistory(interval) {
    history.push(interval);
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }
  }

  return { apply, pause, resume, clear, reset, view, intervals };
}

/**
 * @param {LockInfo} raw
 */
function baseKey(raw) {
  return `${raw?.clientId ?? ""}\u0000${raw?.mode ?? ""}\u0000${raw?.name ?? ""}`;
}
