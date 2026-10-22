import { createInstrumentation } from "./instrumentation.js";
import { createLaneView } from "./lanes.js";
import { createModel } from "./model.js";
import { createTabLabels } from "./tabs.js";
import { createTimeline } from "./timeline.js";
import { formatInterval, formatUrl } from "./format.js";

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
  tabs: null,
  lanes: null,
  instrumentation: null,
};

init();

function init() {
  applyTheme();
  view.timeline = createTimeline(els.timelineCanvas, els.timelineTip);

  view.tabs = createTabLabels({
    button: els.tabLabels,
    getUrl: () => view.snapshot?.url,
    onChange: render,
    showBanner,
  });

  view.lanes = createLaneView({
    lanesEl: els.lanes,
    emptyEl: els.empty,
    emptyTitle: els.emptyTitle,
    emptyCopy: els.emptyCopy,
    emptySnippet: els.emptySnippet,
    statsEl: els.stats,
    getTabMap: () => view.tabs.map(),
    getFilter: () => view.filter,
    getModeFilter: () => view.modeFilter,
  });

  view.instrumentation = createInstrumentation({
    button: els.instrument,
    dockTimeline: els.dockTimeline,
    dockExact: els.dockExact,
    legend: els.timelineLegend,
    timelineCount: els.timelineCount,
    zoom: els.timelineZoom,
    timelinePane: els.timelinePane,
    exactPane: els.exactPane,
    exactCount: els.exactCount,
    exactClear: els.exactClear,
    exactEmpty: els.exactEmpty,
    exactList: els.exactList,
    evalInPage,
    showBanner,
    onShowTimeline: () => view.timeline?.redraw(),
  });

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
    return;
  }

  try {
    chrome.devtools.network.onNavigated.addListener(handleNavigated);
  } catch {
    // The network module is not critical; polling still notices URL changes.
  }

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

    await view.instrumentation.refreshIfDue();
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
}

function clearHistory() {
  view.model.clear(Date.now());
  view.lanes.reset();
  render();
}

function handleNavigated(url) {
  view.token = makeToken();
  view.snapshot = null;
  view.model.reset();
  view.lanes.reset();
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

  view.tabs.onNavigated();
  view.instrumentation.onNavigated();
}

function render() {
  const snapshot = view.snapshot;
  if (!snapshot) return;

  const data = view.model.view(Date.now());

  els.heldCount.textContent = String(data.totals.held);
  els.pendingCount.textContent = String(data.totals.pending);
  setUrl(snapshot.url);
  const recent = updateTimeline(data);

  if (snapshot.ok === false) {
    showBanner(snapshot.error || UNAVAILABLE_MESSAGE, true);
  }

  view.lanes.render(data, snapshot, recent.length > 0);
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
  view.lanes.reset();
  view.tabs.setFatal(true);
  view.instrumentation.onFatal();

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
  view.tabs.setFatal(false);
  view.instrumentation.setFatal(false);
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
    view.instrumentation.onPageHide();
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
