import { originPattern } from "./format.js";

/**
 * Opt-in tab attribution.
 *
 * Requests `scripting` + the inspected origin, probes each same-origin tab in
 * the MAIN world, and maps each tab's clientId to a title.
 */
export function createTabLabels({ button, getUrl, onChange, showBanner }) {
  const state = {
    enabled: false,
    map: new Map(),
    pending: false,
    fatal: false,
    inFlight: false,
    queued: false,
    scheduled: false,
    listenersRegistered: false,
  };

  button.addEventListener("click", () => void toggle());

  return { map: () => state.map, onNavigated, setFatal };

  function updateButton() {
    button.textContent = state.pending
      ? "Tab labels…"
      : state.enabled
        ? "Tab labels on"
        : "Tab labels";
    button.disabled = state.pending || state.fatal;
    button.setAttribute("aria-pressed", String(state.enabled));
    button.classList.toggle("is-active", state.enabled);
  }

  async function toggle() {
    if (state.enabled) {
      state.enabled = false;
      state.map.clear();
      updateButton();
      onChange();
      return;
    }

    const url = getUrl();
    if (!url) {
      showBanner("Still connecting to the inspected page. Try again in a moment.", true);
      return;
    }

    const pattern = originPattern(url);
    if (!pattern) {
      showBanner("Tab labels need an http(s) inspected page.", true);
      return;
    }

    state.pending = true;
    updateButton();

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
      state.pending = false;
      updateButton();
    }

    state.enabled = true;
    updateButton();
    registerListeners();
    await refresh();
  }

  function registerListeners() {
    if (state.listenersRegistered) return;
    try {
      chrome.tabs.onCreated?.addListener(schedule);
      chrome.tabs.onRemoved?.addListener(schedule);
      chrome.tabs.onUpdated?.addListener((_tabId, changeInfo) => {
        if (changeInfo.status === "complete" || changeInfo.url || changeInfo.title) {
          schedule();
        }
      });
      state.listenersRegistered = true;
    } catch {
      // Retry after the optional permission is granted.
    }
  }

  function schedule() {
    if (!state.enabled || state.scheduled) return;
    state.scheduled = true;
    setTimeout(() => {
      state.scheduled = false;
      void refresh();
    }, 400);
  }

  async function refresh() {
    if (!state.enabled) return;

    if (state.inFlight) {
      state.queued = true;
      return;
    }

    state.inFlight = true;

    try {
      const url = getUrl();
      if (!url) {
        setTimeout(schedule, 800);
        return;
      }

      const pattern = originPattern(url);
      if (!pattern) {
        disable("Tab labels need an http(s) inspected page.");
        return;
      }

      const granted = await chrome.permissions.contains({
        permissions: ["scripting"],
        origins: [pattern],
      });
      if (!granted) {
        disable("Tab labels permission is missing for this origin. Enable it again.");
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

      if (!state.enabled) return;
      state.map = new Map(results.filter(Boolean));
      onChange();
    } catch (error) {
      showBanner(`Tab labels failed: ${errorText(error)}`, true);
    } finally {
      state.inFlight = false;
      if (state.queued) {
        state.queued = false;
        schedule();
      }
    }
  }

  function disable(message) {
    state.enabled = false;
    state.map.clear();
    updateButton();
    if (message) showBanner(message, true);
    onChange();
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
                const result = await navigator.locks.query();
                const self = result.held.find((entry) => entry.name === name);
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

  function onNavigated() {
    state.map.clear();
    if (state.enabled) schedule();
  }

  function setFatal(fatal) {
    state.fatal = fatal;
    if (fatal) state.map.clear();
    updateButton();
    if (!fatal && state.enabled) schedule();
  }
}

function urlOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeToken() {
  const uuid =
    globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2).padEnd(12, "0");
  return uuid.replaceAll("-", "").slice(0, 12);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
