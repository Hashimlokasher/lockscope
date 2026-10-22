import { createExactView } from "./exact.js";

const HEARTBEAT_MS = 10_000;
const POLL_MS = 1000;

/**
 * Owns the opt-in LockManager.request patch, its page-side heartbeat, and the
 * bottom dock (Timeline / Exact).
 */
export function createInstrumentation({
  button,
  dockTimeline,
  dockExact,
  legend,
  timelineCount,
  zoom,
  timelinePane,
  exactPane,
  exactCount,
  exactClear,
  exactEmpty,
  exactList,
  evalInPage,
  showBanner,
  onShowTimeline,
}) {
  const exact = createExactView({ countEl: exactCount, clearEl: exactClear, emptyEl: exactEmpty, listEl: exactList });

  const state = {
    on: false,
    pending: false,
    fatal: false,
    dock: "timeline",
    token: makeToken(),
    data: null,
    polledAt: 0,
    heartbeat: null,
    sourcePromise: null,
  };

  button.addEventListener("click", () => void toggle());
  dockTimeline.addEventListener("click", () => setDock("timeline"));
  dockExact.addEventListener("click", () => setDock("exact"));
  exactClear.addEventListener("click", () => void clearRecords());

  setDock("timeline");
  updateButton();

  return { refreshIfDue, onNavigated, onFatal, setFatal, onPageHide };

  function updateButton() {
    button.textContent = state.on ? "Instrument on" : "Instrument";
    button.disabled = state.pending || state.fatal;
    button.setAttribute("aria-pressed", String(state.on));
    button.classList.toggle("is-active", state.on);
  }

  function setDock(dock) {
    state.dock = dock;
    const isExact = dock === "exact";

    timelinePane.hidden = isExact;
    exactPane.hidden = !isExact;
    dockTimeline.classList.toggle("is-active", !isExact);
    dockExact.classList.toggle("is-active", isExact);
    dockTimeline.setAttribute("aria-selected", String(!isExact));
    dockExact.setAttribute("aria-selected", String(isExact));

    legend.hidden = isExact;
    timelineCount.hidden = isExact;
    zoom.hidden = isExact;
    exactCount.hidden = !isExact;
    exactClear.hidden = !isExact;

    if (isExact) renderExact();
    else onShowTimeline();
  }

  function renderExact() {
    exact.render(state.on, state.data?.records || [], state.dock === "exact");
  }

  async function toggle() {
    if (state.on) {
      await disable();
      return;
    }

    state.pending = true;
    updateButton();

    try {
      await install({ switchDock: true });
    } catch (error) {
      showBanner(`Instrumentation failed: ${errorText(error)}`, true);
    } finally {
      state.pending = false;
      updateButton();
    }
  }

  async function install({ switchDock = false } = {}) {
    const source = await getSource();
    const expression = source.replaceAll("__LOCKSCOPE_INSTRUMENT_TOKEN__", state.token);

    const result = await evalInPage(expression);
    if (!result || result.installed !== true) {
      throw new Error("LockManager.request could not be patched in this page.");
    }

    state.on = true;
    updateButton();
    startHeartbeat();

    try {
      await refresh();
    } catch (error) {
      state.on = false;
      stopHeartbeat();
      updateButton();
      throw error;
    }

    if (switchDock) setDock("exact");
  }

  async function reinstall() {
    if (!state.on) return;
    try {
      await install();
    } catch (error) {
      state.on = false;
      updateButton();
      showBanner(`Instrumentation was lost: ${errorText(error)}`, true);
    }
  }

  async function disable() {
    stopHeartbeat();
    await call("uninstall()");
    await call("clear()");
    state.on = false;
    state.data = null;
    exact.reset();
    updateButton();
    setDock("timeline");
    renderExact();
  }

  async function clearRecords() {
    if (!state.on) return;
    await call("clear()");
    state.data = { version: 1, installed: true, records: [] };
    exact.reset();
    renderExact();
  }

  async function refreshIfDue() {
    if (!state.on || Date.now() - state.polledAt < POLL_MS) return;
    await refresh().catch(() => {});
  }

  async function refresh() {
    const data = await evalInPage(
      `window.__lockscope_instrument_${state.token} ? window.__lockscope_instrument_${state.token}.snapshot() : null`,
    );

    if (!data || data.version !== 1) return;

    if (!data.installed) {
      if (state.on) {
        state.on = false;
        stopHeartbeat();
        updateButton();
        showBanner("Instrumentation stopped because the page patch was removed.", true);
      }
      state.data = null;
      exact.reset();
      renderExact();
      return;
    }

    state.polledAt = Date.now();
    state.data = data;
    renderExact();
  }

  function startHeartbeat() {
    stopHeartbeat();
    state.heartbeat = setInterval(() => {
      if (!state.on) return;
      void call("touch()");
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    if (state.heartbeat !== null) {
      clearInterval(state.heartbeat);
      state.heartbeat = null;
    }
  }

  function call(body) {
    return evalInPage(
      `window.__lockscope_instrument_${state.token} ? window.__lockscope_instrument_${state.token}.${body} : null`,
    ).catch(() => null);
  }

  function getSource() {
    if (!state.sourcePromise) {
      const url = chrome.runtime.getURL("instrument.js");
      state.sourcePromise = fetch(url, { cache: "no-store" })
        .then((response) => {
          if (!response.ok) throw new Error(`Unable to load instrument.js (${response.status})`);
          return response.text();
        })
        .catch((error) => {
          state.sourcePromise = null;
          throw error;
        });
    }
    return state.sourcePromise;
  }

  function onNavigated() {
    state.data = null;
    exact.reset();
    stopHeartbeat();
    renderExact();

    if (state.on) setTimeout(() => void reinstall(), 900);
  }

  function onFatal() {
    state.on = false;
    state.pending = false;
    state.data = null;
    stopHeartbeat();
    exact.reset();
    updateButton();
    setDock("timeline");
    renderExact();
  }

  function setFatal(fatal) {
    state.fatal = fatal;
    updateButton();
  }

  function onPageHide() {
    stopHeartbeat();
    if (state.on) void call("uninstall()");
  }

  function makeToken() {
    const uuid =
      globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2).padEnd(12, "0");
    return uuid.replaceAll("-", "").slice(0, 12);
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
