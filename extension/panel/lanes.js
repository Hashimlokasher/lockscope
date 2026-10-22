import { formatDuration, modeLabel, shortId } from "./format.js";

/**
 * Renders contention lanes, durations, stats, and empty states.
 */
export function createLaneView({
  lanesEl,
  emptyEl,
  emptyTitle,
  emptyCopy,
  emptySnippet,
  statsEl,
  getTabMap,
  getFilter,
  getModeFilter,
}) {
  let signature = "";

  function render(data, snapshot, hasHistory) {
    const filtered = filterLanes(data.lanes);
    const totalAll = data.totals.held + data.totals.pending;
    const totalShown = filtered.reduce(
      (sum, lane) => sum + lane.heldCount + lane.pendingCount,
      0,
    );
    const shown = summarize(filtered);

    updateStats(data, totalAll, totalShown, shown);

    if (totalAll === 0) {
      showEmpty("origin", hasHistory);
      return;
    }

    if (totalShown === 0) {
      showEmpty("filter", hasHistory);
      return;
    }

    emptyEl.hidden = true;
    lanesEl.hidden = false;

    const tabMap = getTabMap();
    const next = structureSignature(filtered, snapshot.selfClientId, tabMap);
    if (next !== signature) {
      signature = next;
      rebuild(filtered, snapshot.selfClientId, tabMap);
    } else {
      updateDurations(filtered);
    }
  }

  function reset() {
    signature = "";
  }

  function filterLanes(lanes) {
    const query = getFilter().toLowerCase();
    const mode = getModeFilter();
    const out = [];

    for (const lane of lanes) {
      if (query && !lane.name.toLowerCase().includes(query)) continue;

      const held = mode === "all" ? lane.held : lane.held.filter((row) => row.mode === mode);
      const pending =
        mode === "all" ? lane.pending : lane.pending.filter((row) => row.mode === mode);

      if (!held.length && !pending.length) continue;

      out.push({
        ...lane,
        held,
        pending,
        heldCount: held.length,
        pendingCount: pending.length,
        entries: held.length + pending.length,
        oldestWaitMs: pending.reduce((max, row) => Math.max(max, row.waitMs), 0),
      });
    }

    return out;
  }

  function structureSignature(lanes, selfClientId, tabMap) {
    return JSON.stringify([
      selfClientId || "",
      getFilter(),
      getModeFilter(),
      lanes.map((lane) => [
        lane.name,
        lane.held.map((row) => row.key),
        lane.pending.map((row) => `${row.key}:${row.queue}`),
      ]),
      [...tabMap]
        .map(([clientId, tab]) => `${clientId}:${tab.tabId}:${tab.title}`)
        .sort(),
    ]);
  }

  function rebuild(lanes, selfClientId, tabMap) {
    const fragment = document.createDocumentFragment();

    for (const lane of lanes) {
      const section = document.createElement("section");
      section.className = "lane";
      section.setAttribute("aria-label", lane.name);

      const head = document.createElement("div");
      head.className = "lane-head";

      const name = document.createElement("h2");
      name.className = "lane-name";
      name.textContent = lane.name;
      name.title = lane.name;

      const counts = document.createElement("span");
      counts.className = "lane-counts";
      counts.textContent = `${lane.heldCount} held · ${lane.pendingCount} waiting`;

      const oldest = document.createElement("span");
      oldest.className = "lane-oldest";
      oldest.dataset.oldestFor = lane.name;
      oldest.textContent =
        lane.oldestWaitMs >= 100 ? `oldest ≥ ${formatDuration(lane.oldestWaitMs)}` : "";

      head.append(name, counts, oldest);

      const rows = document.createElement("div");
      rows.className = "lane-rows";
      for (const row of lane.held) rows.append(buildRow(row, selfClientId, tabMap));
      for (const row of lane.pending) rows.append(buildRow(row, selfClientId, tabMap));

      section.append(head, rows);
      fragment.append(section);
    }

    lanesEl.replaceChildren(fragment);
  }

  function buildRow(entry, selfClientId, tabMap) {
    const row = document.createElement("div");
    row.className = "lock-row";
    row.tabIndex = 0;
    row.dataset.key = entry.key;

    const chip = document.createElement("span");
    chip.className = `chip ${entry.state === "held" ? "chip-held" : "chip-waiting"}`;
    if (entry.state === "held") {
      chip.textContent = "Held";
      chip.title = "Held";
    } else {
      chip.textContent = `#${entry.queue}`;
      chip.title = `Waiting · queue position ${entry.queue}`;
    }

    const client = document.createElement("span");
    client.className = "client";
    const code = document.createElement("code");
    code.textContent = shortId(entry.clientId);
    code.title = entry.clientId;
    client.append(code);

    if (selfClientId && entry.clientId === selfClientId) {
      const badge = document.createElement("span");
      badge.className = "self";
      badge.textContent = "this tab";
      client.append(badge);
    }

    const tab = tabMap.get(entry.clientId);
    let tabLabel = null;
    if (tab) {
      tabLabel = document.createElement("span");
      tabLabel.className = "tab-label";
      tabLabel.textContent = tab.title || `tab ${tab.tabId}`;
      tabLabel.title = `Tab ${tab.tabId}: ${tab.title}\n${tab.url}`;
    }

    const mode = document.createElement("span");
    mode.className = "mode";
    mode.textContent = entry.mode;
    mode.title = modeLabel(entry.mode);

    const duration = document.createElement("span");
    duration.className = `duration${entry.state === "pending" ? " duration-waiting" : ""}`;
    duration.dataset.durationKey = entry.key;
    duration.textContent = durationText(entry);

    row.append(chip, client);
    if (tabLabel) row.append(tabLabel);
    row.append(mode, duration);
    row.setAttribute("aria-label", rowAriaLabel(entry));

    return row;
  }

  function updateDurations(lanes) {
    const byKey = new Map();
    const oldestByLane = new Map();

    for (const lane of lanes) {
      oldestByLane.set(lane.name, lane.oldestWaitMs);
      for (const row of lane.held) byKey.set(row.key, row);
      for (const row of lane.pending) byKey.set(row.key, row);
    }

    for (const node of lanesEl.querySelectorAll("[data-duration-key]")) {
      const row = byKey.get(node.dataset.durationKey);
      if (!row) continue;
      node.textContent = durationText(row);
      node.classList.toggle("duration-waiting", row.state === "pending");
    }

    for (const node of lanesEl.querySelectorAll("[data-oldest-for]")) {
      const waitMs = oldestByLane.get(node.dataset.oldestFor) ?? 0;
      node.textContent = waitMs >= 100 ? `oldest ≥ ${formatDuration(waitMs)}` : "";
    }

    for (const node of lanesEl.querySelectorAll(".lock-row")) {
      const row = byKey.get(node.dataset.key);
      if (row) node.setAttribute("aria-label", rowAriaLabel(row));
    }
  }

  function durationText(entry) {
    return entry.state === "pending"
      ? `≥ ${formatDuration(entry.waitMs)}`
      : formatDuration(entry.durationMs);
  }

  function rowAriaLabel(entry) {
    return `${entry.name}, ${
      entry.state === "held" ? "held" : `waiting in position ${entry.queue}`
    }, ${modeLabel(entry.mode)}, client ${shortId(entry.clientId)}, ${durationText(entry)}`;
  }

  function summarize(lanes) {
    let pending = 0;
    let held = 0;
    let oldestWaitMs = 0;
    let maxHeldMs = 0;

    for (const lane of lanes) {
      pending += lane.pendingCount;
      held += lane.heldCount;
      oldestWaitMs = Math.max(oldestWaitMs, lane.oldestWaitMs);
      for (const row of lane.held) maxHeldMs = Math.max(maxHeldMs, row.durationMs);
    }

    return { pending, held, oldestWaitMs, maxHeldMs };
  }

  function updateStats(data, totalAll, totalShown, shown) {
    const filtered = totalShown !== totalAll;
    const pending = filtered ? shown.pending : data.totals.pending;
    const held = filtered ? shown.held : data.totals.held;
    const oldestWaitMs = filtered ? shown.oldestWaitMs : data.stats.oldestWaitMs;
    const maxHeldMs = filtered ? shown.maxHeldMs : data.stats.maxHeldMs;
    const parts = [];

    if (pending > 0) {
      parts.push(
        oldestWaitMs >= 100
          ? `oldest wait ≥ ${formatDuration(oldestWaitMs)}`
          : "waiters queued",
      );
    } else if (held > 0) {
      parts.push(`longest hold ${formatDuration(maxHeldMs)}`);
    } else {
      parts.push(totalAll ? "no matching locks" : "no locks");
    }

    if (filtered) parts.push(`${totalShown} shown`);
    if (data.stats.samples > 0) parts.push(`${data.stats.samples} samples`);

    statsEl.textContent = parts.join(" · ");
    statsEl.title = `Observed for ${formatDuration(data.stats.uptimeMs)} · ${
      data.stats.samples
    } samples · ${data.stats.history} completed intervals`;
  }

  function showEmpty(kind, hasHistory) {
    lanesEl.hidden = true;
    lanesEl.replaceChildren();
    signature = "";
    emptyEl.hidden = false;

    if (kind === "filter") {
      emptyTitle.textContent = "No matching locks";
      emptyCopy.textContent = "No lock name or mode matches the current filter.";
      emptySnippet.hidden = true;
    } else if (hasHistory) {
      emptyTitle.textContent = "No locks right now";
      emptyCopy.textContent = "Recent lock activity is shown on the timeline below.";
      emptySnippet.hidden = true;
    } else {
      emptyTitle.textContent = "No locks in this origin";
      emptyCopy.textContent = "Hold one from the page or run this in the console:";
      emptySnippet.hidden = false;
    }
  }

  return { render, reset };
}
