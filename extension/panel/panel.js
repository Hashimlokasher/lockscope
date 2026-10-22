import { createModel } from "./model.js";
import { createTimeline } from "./timeline.js";
import {
  formatDuration,
  formatExact,
  formatInterval,
  formatUrl,
  modeLabel,
  originPattern,
  shortId,
} from "./format.js";

const DEFAULT_INTERVAL_MS = 500;
const MIN_INTERVAL_MS = 100;
const MAX_INTERVAL_MS = 2000;
const MAX_CONSECUTIVE_FAILURES = 3;
const UNAVAILABLE_MESSAGE =
  "navigator.locks is unavailable on this page. Web Locks requires a secure context (HTTPS or localhost).";

const els = {
  heldCount: document.getElementById("heldCount"),
  pendingCount: document.getElementById("pendingCount"),
  pause: document.getElementById("pause"),
  tabLabels: document.getElementById("tabLabels"),
  instrument: document.getElementById("instrument"),
  interval: document.getElementById("interval"),
  url: document.getElementById("url"),
  status: document.getElementById("status"),
  statusText: document.getElementById("statusText"),
  banner: document.getElementById("banner"),
  bannerText: document.getElementById("bannerText"),
  fatal: document.getElementById("fatal"),
  fatalMessage: document.getElementById("fatalMessage"),
  retry: document.getElementById("retry"),
  empty: document.getElementById("empty"),
  emptyTitle: document.getElementById("emptyTitle"),
  emptyCopy: document.getElementById("emptyCopy"),
  emptySnippet: document.getElementById("emptySnippet"),
  filter: document.getElementById("filter"),
  modeFilter: document.getElementById("modeFilter"),
  clear: document.getElementById("clear"),
  stats: document.getElementById("stats"),
  lanes: document.getElementById("lanes"),
  timeline: document.getElementById("timeline"),
  timelineCanvas: document.getElementById("timelineCanvas"),
  timelineTip: document.getElementById("timelineTip"),
  timelineCount: document.getElementById("timelineCount"),
  timelineLegend: document.getElementById("timelineLegend"),
  timelineZoom: document.getElementById("timelineZoom"),
  timelinePane: document.getElementById("timelinePane"),
  exactPane: document.getElementById("exactPane"),
  exactEmpty: document.getElementById("exactEmpty"),
  exactList: document.getElementById("exactList"),
  exactCount: document.getElementById("exactCount"),
  exactClear: document.getElementById("exactClear"),
  dockTimeline: document.getElementById("dockTimeline"),
  dockExact: document.getElementById("dockExact"),
  footnote: document.getElementById("footnote"),
};

const view = {
  token: makeToken(),
  intervalMs: DEFAULT_INTERVAL_MS,
  running: false,
  paused: false,
  hiddenPaused: false,
  fatal: false,
  failures: 0,
  timer: null,
  inFlight: false,
  snapshot: null,
  agentSourcePromise: null,
  model: createModel(),
  timeline: null,
  windowMs: 60_000,
  filter: "",
  modeFilter: "all",
  structureSignature: "",
  labelsEnabled: false,
  tabMap: new Map(),
  tabRefreshInFlight: false,
  tabRefreshQueued: false,
  tabRefreshScheduled: false,
  tabListenersRegistered: false,
  tabPermissionPending: false,
  instrumentOn: false,
  instrumentPending: false,
  instrumentToken: makeToken(),
  instrumentData: null,
  instrumentSignature: "",
  instrumentPolledAt: 0,
  instrumentHeartbeat: null,
  instrumentSourcePromise: null,
  dock: "timeline",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

init();

function init() {
  applyTheme();
  view.timeline = createTimeline(els.timelineCanvas, els.timelineTip);
  wireEvents();
  updateFootnote();

  try {
    chrome.devtools?.panels?.onThemeChanged?.addListener?.(applyTheme);
  } catch {
    // Older Chrome: no theme event, the initial read is enough.
  }

  if (!hasDevToolsApi()) {
    setStatus("error");
    showFatal(
      "Open LockScope from the DevTools window. This page only works as a " +
        "DevTools panel, where chrome.devtools.inspectedWindow is available.",
    );
    els.retry.hidden = true;
    els.tabLabels.disabled = true;
    els.instrument.disabled = true;
    return;
  }

  try {
    chrome.devtools.network.onNavigated.addListener(handleNavigated);
  } catch {
    // The network module is not critical; polling still notices URL changes.
  }

  registerTabListeners();

  void start();
}

function hasDevToolsApi() {
  return typeof globalThis.chrome?.devtools?.inspectedWindow?.eval === "function";
}

async function start() {
  view.running = true;
  view.paused = false;
  view.fatal = false;
  els.pause.disabled = false;
  updatePauseButton();
  setStatus("connecting");
  restartTimer();
  await tick();
}

function restartTimer() {
  clearTimer();
  if (!view.running) return;
  view.timer = setInterval(() => void tick(), view.intervalMs);
}

function clearTimer() {
  if (view.timer !== null) {
    clearInterval(view.timer);
    view.timer = null;
  }
}

async function tick() {
  if (!view.running || view.inFlight) return;
  view.inFlight = true;

  const requestToken = view.token;

  try {
    let snapshot = await evalInPage(snapshotExpression(requestToken));

    if (!isSnapshot(snapshot)) {
      await injectAgent(requestToken);
      await callAgent(`start(${view.intervalMs})`, requestToken);
      snapshot = await evalInPage(snapshotExpression(requestToken));
    }

    if (!isSnapshot(snapshot)) {
      throw new Error("The injected page agent did not return a snapshot.");
    }

    // A navigation or pause may have happened while the eval was in flight.
    if (!view.running || requestToken !== view.token) return;

    view.failures = 0;
    view.snapshot = snapshot;
    view.model.apply(snapshot, Date.now());
    setStatus("live");
    hideBanner();
    render();

    if (view.instrumentOn && Date.now() - view.instrumentPolledAt >= 1000) {
      await refreshInstrumentation().catch(() => {});
    }
  } catch (error) {
    // Ignore failures caused by a pause or a navigation that happened mid-eval.
    if (!view.running || requestToken !== view.token) return;
    handleTickError(error);
  } finally {
    view.inFlight = false;
  }
}

function handleTickError(error) {
  view.failures += 1;

  if (view.failures >= MAX_CONSECUTIVE_FAILURES) {
    setStatus("error");
    showFatal(describeError(error));
    return;
  }

  setStatus("error");
  showBanner(`Sampling failed: ${errorText(error)}`, true);
}

function pause() {
  if (view.fatal) {
    retry();
    return;
  }

  view.running = false;
  view.paused = true;
  clearTimer();
  view.model.pause(Date.now());
  updatePauseButton();
  setStatus("paused");
  void callAgent("stop()");
  render();
}

async function resume() {
  view.failures = 0;
  hideBanner();
  view.model.resume(Date.now());
  await callAgent(`start(${view.intervalMs})`);
  await start();
}

function retry() {
  view.fatal = false;
  view.failures = 0;
  hideFatal();
  hideBanner();
  void resume();
  if (view.labelsEnabled) setTimeout(scheduleTabRefresh, 900);
}

function clearHistory() {
  view.model.clear(Date.now());
  view.structureSignature = "";
  render();
}

function handleNavigated(url) {
  view.token = makeToken();
  view.snapshot = null;
  view.model.reset();
  view.structureSignature = "";
  view.tabMap.clear();
  view.instrumentData = null;
  view.instrumentSignature = "";
  stopInstrumentHeartbeat();
  view.failures = 0;
  view.fatal = false;

  hideFatal();
  hideBanner();
  els.lanes.replaceChildren();
  els.lanes.hidden = true;
  els.empty.hidden = true;
  els.timeline.hidden = false;
  els.timelineCount.textContent = "";
  view.timeline.setData({ intervals: [], now: Date.now(), windowMs: view.windowMs });
  els.heldCount.textContent = "0";
  els.pendingCount.textContent = "0";
  els.stats.textContent = "";
  setUrl(url);
  setStatus(view.paused ? "paused" : "connecting");

  if (!view.paused) {
    view.running = true;
    restartTimer();
    void tick();
  }

  if (view.labelsEnabled) setTimeout(scheduleTabRefresh, 800);
  if (view.instrumentOn) setTimeout(() => void reinstallInstrumentation(), 900);
  renderExact();
}

function render() {
  const snapshot = view.snapshot;
  if (!snapshot) return;

  const data = view.model.view(Date.now());
  const filtered = filterLanes(data.lanes);
  const totalAll = data.totals.held + data.totals.pending;
  const totalShown = filtered.reduce(
    (sum, lane) => sum + lane.heldCount + lane.pendingCount,
    0,
  );
  const shown = summarize(filtered);

  els.heldCount.textContent = String(data.totals.held);
  els.pendingCount.textContent = String(data.totals.pending);
  setUrl(snapshot.url);
  updateStats(data, totalAll, totalShown, shown);
  const recent = updateTimeline(data);

  if (snapshot.ok === false) {
    showBanner(snapshot.error || UNAVAILABLE_MESSAGE, true);
  }

  if (totalAll === 0) {
    showEmpty("origin", recent.length > 0);
    return;
  }

  if (totalShown === 0) {
    showEmpty("filter", recent.length > 0);
    return;
  }

  els.empty.hidden = true;
  els.lanes.hidden = false;

  const signature = structureSignature(filtered, snapshot.selfClientId);
  if (signature !== view.structureSignature) {
    view.structureSignature = signature;
    rebuildLanes(filtered, snapshot.selfClientId);
  } else {
    updateDurations(filtered);
  }
}

function updateTimeline(data) {
  const timeline = view.model.intervals(data.now);
  const windowStart = timeline.now - view.windowMs;
  const intervals = timeline.intervals
    .filter((interval) => {
      if (view.filter && !interval.name.toLowerCase().includes(view.filter.toLowerCase())) {
        return false;
      }
      if (view.modeFilter !== "all" && interval.mode !== view.modeFilter) return false;
      return (interval.end ?? timeline.now) >= windowStart && interval.start <= timeline.now;
    });

  view.timeline.setData({
    intervals,
    now: timeline.now,
    paused: timeline.paused,
    windowMs: view.windowMs,
    filtered: view.filter !== "" || view.modeFilter !== "all",
  });

  els.timelineCount.textContent = intervals.length
    ? `${intervals.length} interval${intervals.length === 1 ? "" : "s"}`
    : "";

  return intervals;
}

function filterLanes(lanes) {
  const query = view.filter.toLowerCase();
  const mode = view.modeFilter;
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

function structureSignature(lanes, selfClientId) {
  return JSON.stringify([
    selfClientId || "",
    view.filter,
    view.modeFilter,
    lanes.map((lane) => [
      lane.name,
      lane.held.map((row) => row.key),
      lane.pending.map((row) => `${row.key}:${row.queue}`),
    ]),
    [...view.tabMap]
      .map(([clientId, tab]) => `${clientId}:${tab.tabId}:${tab.title}`)
      .sort(),
  ]);
}

function rebuildLanes(lanes, selfClientId) {
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
    for (const row of lane.held) rows.append(buildRow(row, selfClientId));
    for (const row of lane.pending) rows.append(buildRow(row, selfClientId));

    section.append(head, rows);
    fragment.append(section);
  }

  els.lanes.replaceChildren(fragment);
}

function buildRow(entry, selfClientId) {
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

  const tab = view.tabMap.get(entry.clientId);
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

  for (const node of els.lanes.querySelectorAll("[data-duration-key]")) {
    const row = byKey.get(node.dataset.durationKey);
    if (!row) continue;
    node.textContent = durationText(row);
    node.classList.toggle("duration-waiting", row.state === "pending");
  }

  for (const node of els.lanes.querySelectorAll(".lock-row")) {
    const row = byKey.get(node.dataset.key);
    if (row) node.setAttribute("aria-label", rowAriaLabel(row));
  }

  for (const node of els.lanes.querySelectorAll("[data-oldest-for]")) {
    const waitMs = oldestByLane.get(node.dataset.oldestFor) ?? 0;
    node.textContent = waitMs >= 100 ? `oldest ≥ ${formatDuration(waitMs)}` : "";
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
      oldestWaitMs >= 100 ? `oldest wait ≥ ${formatDuration(oldestWaitMs)}` : "waiters queued",
    );
  } else if (held > 0) {
    parts.push(`longest hold ${formatDuration(maxHeldMs)}`);
  } else {
    parts.push(totalAll ? "no matching locks" : "no locks");
  }

  if (filtered) parts.push(`${totalShown} shown`);
  if (data.stats.samples > 0) parts.push(`${data.stats.samples} samples`);

  els.stats.textContent = parts.join(" · ");
  els.stats.title = `Observed for ${formatDuration(data.stats.uptimeMs)} · ${
    data.stats.samples
  } samples · ${data.stats.history} completed intervals`;
}

function showEmpty(kind, hasHistory = false) {
  els.lanes.hidden = true;
  els.lanes.replaceChildren();
  view.structureSignature = "";
  els.empty.hidden = false;

  if (kind === "filter") {
    els.emptyTitle.textContent = "No matching locks";
    els.emptyCopy.textContent = "No lock name or mode matches the current filter.";
    els.emptySnippet.hidden = true;
  } else if (hasHistory) {
    els.emptyTitle.textContent = "No locks right now";
    els.emptyCopy.textContent = "Recent lock activity is shown on the timeline below.";
    els.emptySnippet.hidden = true;
  } else {
    els.emptyTitle.textContent = "No locks in this origin";
    els.emptyCopy.textContent = "Hold one from the page or run this in the console:";
    els.emptySnippet.hidden = false;
  }
}

function updatePauseButton() {
  els.pause.textContent = view.paused ? "Resume" : "Pause";
  els.pause.setAttribute("aria-pressed", String(view.paused));
}

function updateFootnote() {
  els.footnote.textContent = `Sampled every ${formatInterval(view.intervalMs)} · navigator.locks.query()`;
}

function setStatus(kind) {
  els.status.dataset.state = kind;
  els.statusText.textContent = kind;
}

function setUrl(url) {
  els.url.textContent = url ? formatUrl(url) : "—";
  els.url.title = url || "";
}

function showBanner(message, isError = false) {
  els.banner.hidden = false;
  els.banner.classList.toggle("banner--error", isError);
  els.bannerText.textContent = message;
}

function hideBanner() {
  els.banner.hidden = true;
  els.bannerText.textContent = "";
}

function showFatal(message) {
  view.fatal = true;
  view.running = false;
  view.paused = false;
  view.snapshot = null;
  clearTimer();
  view.model.reset();
  view.structureSignature = "";
  view.tabMap.clear();
  view.tabPermissionPending = false;
  view.instrumentOn = false;
  view.instrumentPending = false;
  view.instrumentData = null;
  view.instrumentSignature = "";
  stopInstrumentHeartbeat();
  updateInstrumentButton();
  updateTabLabelsButton();
  setDock("timeline");

  els.fatal.hidden = false;
  els.fatalMessage.textContent = message;
  els.empty.hidden = true;
  els.lanes.hidden = true;
  els.lanes.replaceChildren();
  els.timeline.hidden = true;
  els.timelineCount.textContent = "";
  view.timeline.setData({ intervals: [], now: Date.now(), windowMs: view.windowMs });
  els.heldCount.textContent = "0";
  els.pendingCount.textContent = "0";
  els.stats.textContent = "";
  hideBanner();
  els.pause.disabled = true;
  updatePauseButton();
}

function hideFatal() {
  els.fatal.hidden = true;
  els.fatalMessage.textContent = "";
  els.retry.hidden = false;
  els.pause.disabled = false;
  els.timeline.hidden = false;
  updateInstrumentButton();
  updateTabLabelsButton();
}

function describeError(error) {
  const message = errorText(error);
  const privileged =
    /chrome:\/\/|chrome-extension:\/\/|webstore|not allowed|access to|cannot access|access is denied|denied|E_PROTOCOLERROR|E_NOTFOUND/i.test(
      message,
    );

  if (privileged) {
    return (
      "Chrome blocks extension code on browser-internal pages (chrome://), the " +
      "Chrome Web Store, and some other privileged pages. Open DevTools on a " +
      `normal http(s) page and press Retry.\n\n${message}`
    );
  }
  return message;
}

function wireEvents() {
  els.pause.addEventListener("click", () => {
    if (view.fatal) retry();
    else if (view.paused) void resume();
    else pause();
  });

  els.retry.addEventListener("click", retry);
  els.clear.addEventListener("click", clearHistory);
  els.tabLabels.addEventListener("click", () => void toggleTabLabels());
  els.instrument.addEventListener("click", () => void toggleInstrument());
  els.dockTimeline.addEventListener("click", () => setDock("timeline"));
  els.dockExact.addEventListener("click", () => setDock("exact"));
  els.exactClear.addEventListener("click", () => void clearInstrumentation());

  els.interval.addEventListener("change", () => {
    view.intervalMs = clampInterval(els.interval.value);
    els.interval.value = String(view.intervalMs);
    updateFootnote();

    if (view.running) {
      restartTimer();
      void callAgent(`start(${view.intervalMs})`);
      void tick();
    } else if (!view.paused) {
      void callAgent(`start(${view.intervalMs})`);
    }
  });

  els.filter.addEventListener("input", () => {
    view.filter = els.filter.value.trim();
    render();
  });

  els.modeFilter.addEventListener("change", () => {
    view.modeFilter = els.modeFilter.value;
    render();
  });

  const zoomButtons = [...document.querySelectorAll(".zoom-btn")];
  for (const button of zoomButtons) {
    button.addEventListener("click", () => {
      view.windowMs = Number(button.dataset.window) || 60_000;
      view.timeline.setWindow(view.windowMs);
      for (const candidate of zoomButtons) {
        const active = candidate === button;
        candidate.classList.toggle("is-active", active);
        candidate.setAttribute("aria-pressed", String(active));
      }
      render();
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const tag = event.target?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

    if (event.key === "p" || event.key === "P") {
      event.preventDefault();
      if (view.fatal) retry();
      else if (view.paused) void resume();
      else pause();
    } else if (event.key === "/") {
      event.preventDefault();
      els.filter.focus();
    }
  });

  window.addEventListener("pagehide", () => {
    stopInstrumentHeartbeat();
    if (view.instrumentOn) void callInstrument("uninstall()");
  });

  els.filter.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      els.filter.value = "";
      view.filter = "";
      render();
      els.filter.blur();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!view.running) return;

    if (document.visibilityState === "hidden") {
      clearTimer();
      view.hiddenPaused = true;
      view.model.pause(Date.now());
      void callAgent("stop()");
    } else if (view.hiddenPaused) {
      view.hiddenPaused = false;
      view.model.resume(Date.now());
      void callAgent(`start(${view.intervalMs})`);
      restartTimer();
      void tick();
    }
  });
}

function applyTheme(themeName) {
  let name = typeof themeName === "string" ? themeName : "";
  if (!name) {
    try {
      name = chrome.devtools?.panels?.themeName || "";
    } catch {
      // Keep the light default.
    }
  }
  document.documentElement.dataset.theme = name === "dark" ? "dark" : "light";
  view.timeline?.redraw();
}

function updateInstrumentButton() {
  els.instrument.textContent = view.instrumentOn ? "Instrument on" : "Instrument";
  els.instrument.disabled = view.instrumentPending || view.fatal;
  els.instrument.setAttribute("aria-pressed", String(view.instrumentOn));
  els.instrument.classList.toggle("is-active", view.instrumentOn);
}

async function toggleInstrument() {
  if (view.instrumentOn) {
    await disableInstrumentation();
    return;
  }

  view.instrumentPending = true;
  updateInstrumentButton();

  try {
    await installInstrumentation({ switchDock: true });
  } catch (error) {
    showBanner(`Instrumentation failed: ${errorText(error)}`, true);
  } finally {
    view.instrumentPending = false;
    updateInstrumentButton();
  }
}

async function installInstrumentation({ switchDock = false } = {}) {
  const source = await getInstrumentSource();
  const expression = source.replaceAll("__LOCKSCOPE_INSTRUMENT_TOKEN__", view.instrumentToken);

  const result = await evalInPage(expression);
  if (!result || result.installed !== true) {
    throw new Error("LockManager.request could not be patched in this page.");
  }

  view.instrumentOn = true;
  updateInstrumentButton();
  startInstrumentHeartbeat();
  await refreshInstrumentation();

  if (switchDock) setDock("exact");
}

async function reinstallInstrumentation() {
  if (!view.instrumentOn) return;
  try {
    await installInstrumentation();
  } catch (error) {
    view.instrumentOn = false;
    updateInstrumentButton();
    showBanner(`Instrumentation was lost: ${errorText(error)}`, true);
  }
}

async function disableInstrumentation() {
  stopInstrumentHeartbeat();
  await callInstrument("uninstall()");
  await callInstrument("clear()");
  view.instrumentOn = false;
  view.instrumentData = null;
  view.instrumentSignature = "";
  updateInstrumentButton();
  updateTabLabelsButton();
  setDock("timeline");
  renderExact();
}

async function clearInstrumentation() {
  if (!view.instrumentOn) return;
  await callInstrument("clear()");
  view.instrumentData = { version: 1, installed: true, records: [] };
  view.instrumentSignature = "";
  renderExact();
}

function startInstrumentHeartbeat() {
  stopInstrumentHeartbeat();
  view.instrumentHeartbeat = setInterval(() => {
    if (!view.instrumentOn) return;
    void callInstrument("touch()");
  }, 10_000);
}

function stopInstrumentHeartbeat() {
  if (view.instrumentHeartbeat !== null) {
    clearInterval(view.instrumentHeartbeat);
    view.instrumentHeartbeat = null;
  }
}

function callInstrument(body) {
  return evalInPage(
    `window.__lockscope_instrument_${view.instrumentToken} ? window.__lockscope_instrument_${view.instrumentToken}.${body} : null`,
  ).catch(() => null);
}

async function refreshInstrumentation() {
  const data = await evalInPage(
    `window.__lockscope_instrument_${view.instrumentToken} ? window.__lockscope_instrument_${view.instrumentToken}.snapshot() : null`,
  );

  if (!data || data.version !== 1) return;

  if (!data.installed) {
    if (view.instrumentOn) {
      view.instrumentOn = false;
      stopInstrumentHeartbeat();
      updateInstrumentButton();
      showBanner("Instrumentation stopped because the page patch was removed.", true);
    }
    view.instrumentData = null;
    view.instrumentSignature = "";
    if (view.dock === "exact") renderExact();
    else updateExactCount();
    return;
  }

  view.instrumentPolledAt = Date.now();
  view.instrumentData = data;

  if (view.dock === "exact") renderExact();
  else updateExactCount();
}

function setDock(dock) {
  view.dock = dock;
  const exact = dock === "exact";

  els.timelinePane.hidden = exact;
  els.exactPane.hidden = !exact;
  els.dockTimeline.classList.toggle("is-active", !exact);
  els.dockExact.classList.toggle("is-active", exact);
  els.dockTimeline.setAttribute("aria-selected", String(!exact));
  els.dockExact.setAttribute("aria-selected", String(exact));

  els.timelineLegend.hidden = exact;
  els.timelineCount.hidden = exact;
  els.timelineZoom.hidden = exact;
  els.exactCount.hidden = !exact;
  els.exactClear.hidden = !exact;

  if (exact) renderExact();
  else view.timeline?.redraw();
}

function updateExactCount() {
  const count = view.instrumentData?.records?.length || 0;
  els.exactCount.textContent = count ? `${count} record${count === 1 ? "" : "s"}` : "";
  els.exactClear.disabled = !view.instrumentOn || count === 0;
}

function renderExact() {
  if (view.dock !== "exact") {
    updateExactCount();
    return;
  }

  const records = view.instrumentData?.records || [];
  updateExactCount();

  if (!view.instrumentOn) {
    els.exactEmpty.hidden = false;
    els.exactEmpty.textContent =
      "Instrumentation is off. Click Instrument to record exact request, acquire, and release times with the awaiting call stack.";
    els.exactList.replaceChildren();
    view.instrumentSignature = "";
    return;
  }

  if (!records.length) {
    els.exactEmpty.hidden = false;
    els.exactEmpty.textContent =
      "No instrumented requests yet. Trigger a lock request on the page.";
    els.exactList.replaceChildren();
    view.instrumentSignature = "";
    return;
  }

  els.exactEmpty.hidden = true;

  const shown = records.slice(-120).reverse();
  const signature = shown
    .map((record) => `${record.id}:${record.outcome}:${record.acquiredAt}:${record.releasedAt}`)
    .join("|");

  if (signature !== view.instrumentSignature) {
    view.instrumentSignature = signature;
    rebuildExactRows(shown);
  } else {
    updateExactTimings(shown);
  }
}

function rebuildExactRows(records) {
  const fragment = document.createDocumentFragment();

  for (const record of records) {
    const details = document.createElement("details");
    details.className = "exact-row";
    details.dataset.recordId = String(record.id);
    details.setAttribute("role", "listitem");

    const summary = document.createElement("summary");

    const name = document.createElement("span");
    name.className = "exact-name";
    name.textContent = record.name;
    name.title = record.name;

    const mode = document.createElement("span");
    mode.className = "exact-mode";
    mode.textContent = record.mode;

    const status = document.createElement("span");
    status.className = `exact-status ${exactStatusClass(record.outcome)}`;
    status.textContent = exactStatusLabel(record.outcome);

    const timing = document.createElement("span");
    timing.className = "exact-timing";
    timing.dataset.exactTiming = String(record.id);
    timing.textContent = exactTiming(record);

    const flags = document.createElement("span");
    flags.className = "exact-flags";
    if (record.steal) flags.append(flag("steal"));
    if (record.ifAvailable) flags.append(flag("ifAvailable"));
    if (record.signal) flags.append(flag("signal"));

    summary.append(name, mode, status);
    if (flags.childElementCount) summary.append(flags);
    summary.append(timing);

    const stack = document.createElement("pre");
    stack.className = "exact-stack";
    stack.textContent = record.stack || "No stack captured.";

    details.append(summary, stack);
    fragment.append(details);
  }

  els.exactList.replaceChildren(fragment);
}

function updateExactTimings(records) {
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const node of els.exactList.querySelectorAll("[data-exact-timing]")) {
    const record = byId.get(Number(node.dataset.exactTiming));
    if (record) node.textContent = exactTiming(record);
  }
}

function exactTiming(record) {
  const now = Date.now();
  const waitMs = record.acquiredAt
    ? record.acquiredAt - record.requestedAt
    : now - record.requestedAt;
  const holdMs = record.acquiredAt
    ? (record.releasedAt || now) - record.acquiredAt
    : 0;

  if (record.outcome === "queued") return `wait ${formatExact(waitMs)}`;
  if (record.outcome === "skipped") return "skipped";
  if (!record.acquiredAt) return `wait ${formatExact(waitMs)}`;

  return `wait ${formatExact(waitMs)} · hold ${formatExact(holdMs)}`;
}

function exactStatusLabel(outcome) {
  const labels = {
    queued: "Waiting",
    held: "Held",
    released: "Released",
    preempted: "Preempted",
    skipped: "Skipped",
    aborted: "Aborted",
    rejected: "Rejected",
    threw: "Threw",
    "request-failed": "Failed",
    resolved: "Resolved",
  };
  return labels[outcome] || outcome;
}

function exactStatusClass(outcome) {
  if (outcome === "queued") return "exact-status-queued";
  if (outcome === "held") return "exact-status-held";
  if (
    outcome === "aborted" ||
    outcome === "preempted" ||
    outcome === "rejected" ||
    outcome === "threw" ||
    outcome === "request-failed"
  ) {
    return "exact-status-bad";
  }
  return "exact-status-done";
}

function flag(text) {
  const node = document.createElement("span");
  node.className = "exact-flag";
  node.textContent = text;
  return node;
}

function getInstrumentSource() {
  if (!view.instrumentSourcePromise) {
    const url = chrome.runtime.getURL("instrument.js");
    view.instrumentSourcePromise = fetch(url, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`Unable to load instrument.js (${response.status})`);
        return response.text();
      })
      .catch((error) => {
        view.instrumentSourcePromise = null;
        throw error;
      });
  }
  return view.instrumentSourcePromise;
}

async function toggleTabLabels() {
  if (view.labelsEnabled) {
    view.labelsEnabled = false;
    view.tabMap.clear();
    updateTabLabelsButton();
    view.structureSignature = "";
    render();
    return;
  }

  if (!view.snapshot?.url) {
    showBanner("Still connecting to the inspected page. Try again in a moment.", true);
    return;
  }

  const pattern = originPattern(view.snapshot.url);
  if (!pattern) {
    showBanner("Tab labels need an http(s) inspected page.", true);
    return;
  }

  view.tabPermissionPending = true;
  updateTabLabelsButton();

  try {
    const granted = await chrome.permissions.request({
      permissions: ["scripting"],
      origins: [pattern],
    });
    if (!granted) {
      showBanner("Tab labels permission was denied for this origin.", true);
      return;
    }
  } catch (error) {
    showBanner(`Tab labels permission failed: ${errorText(error)}`, true);
    return;
  } finally {
    view.tabPermissionPending = false;
    updateTabLabelsButton();
  }

  view.labelsEnabled = true;
  updateTabLabelsButton();
  registerTabListeners();
  await refreshTabMap();
}

function registerTabListeners() {
  if (view.tabListenersRegistered) return;
  try {
    chrome.tabs.onCreated?.addListener(scheduleTabRefresh);
    chrome.tabs.onRemoved?.addListener(scheduleTabRefresh);
    chrome.tabs.onUpdated?.addListener((_tabId, changeInfo) => {
      if (changeInfo.status === "complete" || changeInfo.url || changeInfo.title) {
        scheduleTabRefresh();
      }
    });
    view.tabListenersRegistered = true;
  } catch {
    // The optional permission may not be granted yet; try again on enable.
  }
}

function updateTabLabelsButton() {
  els.tabLabels.textContent = view.tabPermissionPending
    ? "Tab labels…"
    : view.labelsEnabled
      ? "Tab labels on"
      : "Tab labels";
  els.tabLabels.disabled = view.tabPermissionPending || view.fatal;
  els.tabLabels.setAttribute("aria-pressed", String(view.labelsEnabled));
  els.tabLabels.classList.toggle("is-active", view.labelsEnabled);
}

function scheduleTabRefresh() {
  if (!view.labelsEnabled || view.tabRefreshScheduled) return;
  view.tabRefreshScheduled = true;
  setTimeout(() => {
    view.tabRefreshScheduled = false;
    void refreshTabMap();
  }, 400);
}

async function refreshTabMap() {
  if (!view.labelsEnabled) return;

  if (view.tabRefreshInFlight) {
    view.tabRefreshQueued = true;
    return;
  }

  view.tabRefreshInFlight = true;

  try {
    const url = view.snapshot?.url;
    if (!url) {
      setTimeout(scheduleTabRefresh, 800);
      return;
    }

    const pattern = originPattern(url);
    if (!pattern) {
      disableTabLabels("Tab labels need an http(s) inspected page.");
      return;
    }

    const granted = await chrome.permissions.contains({
      permissions: ["scripting"],
      origins: [pattern],
    });
    if (!granted) {
      disableTabLabels("Tab labels permission is missing for this origin. Enable it again.");
      return;
    }

    const origin = new URL(url).origin;
    const tabs = await chrome.tabs.query({});
    const sameOrigin = tabs.filter(
      (tab) => tab.id != null && tab.url && urlOrigin(tab.url) === origin,
    );

    const token = makeToken();
    const results = await Promise.all(
      sameOrigin.map(async (tab) => {
        const clientId = await probeTab(tab.id, `${token}_${tab.id}`);
        if (!clientId) return null;
        return [
          clientId,
          { tabId: tab.id, title: tab.title || tab.url, url: tab.url },
        ];
      }),
    );

    if (!view.labelsEnabled) return;
    view.tabMap = new Map(results.filter(Boolean));
    view.structureSignature = "";
    render();
  } catch (error) {
    showBanner(`Tab labels failed: ${errorText(error)}`, true);
  } finally {
    view.tabRefreshInFlight = false;
    if (view.tabRefreshQueued) {
      view.tabRefreshQueued = false;
      scheduleTabRefresh();
    }
  }
}

function disableTabLabels(message) {
  view.labelsEnabled = false;
  view.tabMap.clear();
  updateTabLabelsButton();
  if (message) showBanner(message, true);
  view.structureSignature = "";
  render();
}

async function probeTab(tabId, token) {
  const key = `__lockscope_probe_${token}`;
  const lockName = `__lockscope_internal_tab_${token}`;

  const cleanup = async () => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [key],
        func: (storageKey) => {
          delete window[storageKey];
          return true;
        },
      });
    } catch {
      // Tab closed or navigated; the marker dies with the document.
    }
  };

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [lockName, key],
      func: (name, storageKey) => {
        if (!window[storageKey] || window[storageKey].done) {
          window[storageKey] = { id: null, done: false };
          navigator.locks
            .request(name, { ifAvailable: true }, async (lock) => {
              if (!lock) {
                window[storageKey].done = true;
                return;
              }
              const state = await navigator.locks.query();
              const self = state.held.find((entry) => entry.name === name);
              window[storageKey].id = self ? self.clientId : null;
              window[storageKey].done = true;
            })
            .catch(() => {
              window[storageKey].done = true;
            });
        }
        return true;
      },
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await sleep(50);
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [key],
        func: (storageKey) => {
          const probe = window[storageKey];
          return probe ? { id: probe.id, done: probe.done } : null;
        },
      });

      const value = result?.result;
      if (value?.done) {
        await cleanup();
        return value.id || null;
      }
    }
  } catch {
    // The tab may be discarded, loading, or on another origin.
  }

  await cleanup();
  return null;
}

function urlOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function snapshotExpression(token = view.token) {
  return `window.__lockscope_${token} ? window.__lockscope_${token}.snapshot() : null`;
}

function callAgent(body, token = view.token) {
  return evalInPage(
    `(function () { var a = window.__lockscope_${token}; return a ? a.${body} : false; })()`,
  ).catch(() => false);
}

async function injectAgent(token = view.token) {
  const source = await getAgentSource();
  await evalInPage(source.replaceAll("__LOCKSCOPE_TOKEN__", token));
}

function getAgentSource() {
  if (!view.agentSourcePromise) {
    const url = chrome.runtime.getURL("page-agent.js");
    view.agentSourcePromise = fetch(url, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`Unable to load page-agent.js (${response.status})`);
        return response.text();
      })
      .catch((error) => {
        view.agentSourcePromise = null;
        throw error;
      });
  }
  return view.agentSourcePromise;
}

/**
 * The callback overload works on every Chrome version this extension targets,
 * before and after the Chrome 151 promise-based DevTools API.
 * @param {string} expression
 */
function evalInPage(expression) {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(expression, (result, exceptionInfo) => {
      if (!exceptionInfo) {
        resolve(result);
        return;
      }

      const details = Array.isArray(exceptionInfo.details)
        ? exceptionInfo.details.filter(Boolean).join(" ")
        : "";
      const message =
        [exceptionInfo.value, exceptionInfo.description, details]
          .filter(Boolean)
          .join(" — ") ||
        exceptionInfo.code ||
        "Evaluation failed in the inspected page.";

      const error = new Error(message);
      error.code = exceptionInfo.code || (exceptionInfo.isError ? "E_EVAL" : "E_JS");
      reject(error);
    });
  });
}

function isSnapshot(value) {
  return Boolean(value && Array.isArray(value.held) && Array.isArray(value.pending));
}

function clampInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.round(n)));
}

function makeToken() {
  const uuid =
    globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2).padEnd(12, "0");
  return uuid.replaceAll("-", "").slice(0, 12);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
