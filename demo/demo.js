const params = new URLSearchParams(location.search);
const role = params.get("deadlock") === "2"
  ? "deadlock follower"
  : params.get("tab")
    ? `tab ${params.get("tab")}`
    : "tab 1";
const supported = Boolean(navigator.locks) && window.isSecureContext;

const els = {
  origin: document.getElementById("origin"),
  role: document.getElementById("role"),
  unsupported: document.getElementById("unsupported"),
  live: document.getElementById("live"),
  log: document.getElementById("log"),
};

const releaseFns = new Map();
const aborters = new Set();
const workers = new Set();
let seq = 0;
let deadlock = null;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

init();

function init() {
  els.origin.textContent = location.host;
  els.role.textContent = role;

  if (!supported) {
    els.unsupported.hidden = false;
    for (const button of document.querySelectorAll("button")) button.disabled = true;
    return;
  }

  const actions = {
    exclusive: () => hold("resource-a", { ms: 8000 }),
    queue: () => {
      for (let i = 0; i < 3; i += 1) hold("resource-a", { ms: 2500 });
    },
    shared: () => {
      for (let i = 0; i < 3; i += 1) hold("resource-b", { mode: "shared", ms: 6000 });
      setTimeout(() => hold("resource-b", { ms: 4000 }), 300);
    },
    "cross-tab": openCrossTab,
    "abort-queued": abortQueued,
    "abort-granted": abortGranted,
    "if-available": ifAvailable,
    steal: steal,
    worker: workerLock,
    deadlock: startDeadlock,
    release: releaseAll,
    copy: copyJson,
  };

  for (const button of document.querySelectorAll("[data-action]")) {
    const action = actions[button.dataset.action];
    if (!action) continue;
    button.addEventListener("click", () => {
      try {
        action();
      } catch (error) {
        log(`action failed: ${error.message}`, "muted");
      }
    });
  }

  log(`ready — ${role}`, "muted");
  void refreshLive();

  if (params.get("deadlock") === "2") {
    void followDeadlock(params.get("run"));
  } else if (params.get("auto") === "1") {
    setTimeout(() => {
      log("auto scenario from ?auto=1", "muted");
      hold("resource-a", { ms: 12000 });
    }, 300);
  }

  window.addEventListener("pagehide", () => {
    if (deadlock) releaseDeadlock(deadlock, true);
  });
}

function openCrossTab() {
  const url = new URL(location.href);
  url.searchParams.set("tab", "2");
  url.searchParams.set("auto", "1");
  window.open(url.toString(), "_blank");
  log("opened a second tab that holds resource-a for 12 s", "muted");
}

/**
 * @param {string} name
 * @param {{mode?: "exclusive"|"shared", ms?: number}} [options]
 */
function hold(name, { mode = "exclusive", ms = 8000 } = {}) {
  const requestId = ++seq;
  const controller = new AbortController();
  aborters.add(controller);

  let acquired = false;
  log(`#${requestId} request ${name} (${mode})`);

  navigator.locks
    .request(name, { mode, signal: controller.signal }, async () => {
      acquired = true;
      aborters.delete(controller);
      log(`#${requestId} acquired ${name}`);
      await new Promise((resolve) => {
        let timer;
        const finish = () => {
          clearTimeout(timer);
          releaseFns.delete(requestId);
          resolve();
        };
        timer = setTimeout(finish, ms);
        releaseFns.set(requestId, finish);
      });
      log(`#${requestId} released ${name}`);
    })
    .catch((error) => {
      aborters.delete(controller);
      if (error.name === "AbortError") {
        log(
          acquired
            ? `#${requestId} preempted after grant ${name}`
            : `#${requestId} aborted while queued ${name}`,
          "muted",
        );
      } else {
        log(`#${requestId} failed ${name}: ${error.message}`, "muted");
      }
    });
}

function holdTimer(ms) {
  return new Promise((resolve) => {
    const id = ++seq;
    let timer;
    const finish = () => {
      clearTimeout(timer);
      releaseFns.delete(id);
      resolve();
    };
    timer = setTimeout(finish, ms);
    releaseFns.set(id, finish);
  });
}

function abortQueued() {
  hold("abort-queued", { ms: 6000 });

  setTimeout(() => {
    const controller = new AbortController();
    aborters.add(controller);
    log("request abort-queued with a signal");

    navigator.locks
      .request("abort-queued", { signal: controller.signal }, async () => {
        log("abort-queued acquired (holder released early?)", "muted");
        await wait(400);
      })
      .catch((error) => {
        if (error.name === "AbortError") log("aborted while queued", "muted");
        else log(`abort-queued failed: ${error.message}`, "muted");
      })
      .finally(() => aborters.delete(controller));

    setTimeout(() => {
      controller.abort();
      log("AbortController.abort() while queued", "muted");
    }, 800);
  }, 200);
}

function abortGranted() {
  const controller = new AbortController();
  aborters.add(controller);

  navigator.locks
    .request("abort-granted", { signal: controller.signal }, async () => {
      aborters.delete(controller);
      log("acquired abort-granted");
      await wait(300);
      controller.abort();
      log("abort() after grant — the lock is still held", "muted");
      await holdTimer(3000);
      log("released abort-granted");
    })
    .catch((error) => log(`abort-granted failed: ${error.message}`, "muted"));
}

function ifAvailable() {
  hold("if-available", { ms: 6000 });

  setTimeout(() => {
    log("request if-available with ifAvailable: true");
    navigator.locks
      .request("if-available", { ifAvailable: true }, async (lock) => {
        if (!lock) {
          log("ifAvailable: skipped (no lock)", "muted");
          return;
        }
        log("ifAvailable: acquired (holder was gone)", "muted");
        await holdTimer(300);
      })
      .then(() => log("ifAvailable request settled without queueing", "muted"));
  }, 300);
}

function steal() {
  hold("steal-demo", { ms: 10000 });

  setTimeout(() => {
    log("request steal-demo with steal: true");
    navigator.locks
      .request("steal-demo", { steal: true }, async () => {
        log("stole steal-demo — original holder is preempted");
        await holdTimer(3000);
        log("stealer released");
      })
      .catch((error) => log(`steal failed: ${error.message}`, "muted"));
  }, 1200);
}

function workerLock() {
  let worker;
  try {
    worker = new Worker("./worker.js");
  } catch (error) {
    log(`worker unavailable: ${error.message}`, "muted");
    return;
  }

  workers.add(worker);
  worker.onmessage = (event) => {
    const data = event.data || {};
    if (data.message) log(`worker: ${data.message}`, "muted");
    if (data.done) {
      workers.delete(worker);
      worker.terminate();
    }
  };
  worker.onerror = (event) => {
    log(`worker error: ${event.message || "unknown"}`, "muted");
    workers.delete(worker);
    worker.terminate();
  };
  worker.postMessage({ name: "worker-lock", ms: 8000 });
  log("started worker for worker-lock");
}

function startDeadlock() {
  if (!("BroadcastChannel" in window)) {
    log("BroadcastChannel is unavailable", "muted");
    return;
  }

  if (deadlock) releaseDeadlock(deadlock, true);

  const runId = String(Date.now());
  const channel = new BroadcastChannel(`lockscope-deadlock-${runId}`);
  const state = createDeadlockState(channel, runId);
  deadlock = state;
  let started = false;

  channel.onmessage = (event) => {
    const data = event.data || {};
    if (data.type === "follower-ready" && !started) {
      started = true;
      void runMainDeadlock(state);
    } else if (data.type === "b-held") {
      state.bHeld.resolve();
    } else if (data.type === "release") {
      releaseDeadlock(state, false);
    }
  };

  const url = new URL(location.href);
  url.searchParams.set("deadlock", "2");
  url.searchParams.set("run", runId);
  const opened = window.open(url.toString(), "_blank");
  if (!opened) {
    log("popup blocked — allow popups for this demo", "muted");
    releaseDeadlock(state);
    return;
  }

  log(`opened follower tab (run ${runId})`);

  setTimeout(() => {
    if (!started && deadlock === state) {
      log("follower did not connect; releasing", "muted");
      releaseDeadlock(state);
    }
  }, 6000);
}

async function runMainDeadlock(state) {
  log("follower connected; acquiring deadlock-a");

  try {
    await navigator.locks.request("deadlock-a", async () => {
      if (state.closed) return;
      log("holds deadlock-a");
      state.channel.postMessage({ type: "a-held" });

      const outcome = await Promise.race([
        state.bHeld.promise.then(() => "b-held"),
        state.released.promise.then(() => "released"),
        wait(30_000).then(() => "timeout"),
      ]);

      if (outcome !== "b-held") {
        log(`deadlock main: ${outcome}`, "muted");
        return;
      }
      if (state.closed) return;

      log("waiting for deadlock-b");
      await deadlockSecond(state, "deadlock-b");
    });
    log("released deadlock-a");
  } catch (error) {
    log(`deadlock main failed: ${error.message}`, "muted");
  }
}

async function followDeadlock(runId) {
  if (!runId) {
    log("missing deadlock run id", "muted");
    return;
  }

  const channel = new BroadcastChannel(`lockscope-deadlock-${runId}`);
  const state = createDeadlockState(channel, runId);
  deadlock = state;

  channel.onmessage = (event) => {
    const data = event.data || {};
    if (data.type === "a-held") state.aHeld.resolve();
    else if (data.type === "release") releaseDeadlock(state, false);
  };

  channel.postMessage({ type: "follower-ready" });
  log("follower ready; waiting for deadlock-a");

  const outcome = await Promise.race([
    state.aHeld.promise.then(() => "a-held"),
    state.released.promise.then(() => "released"),
    wait(30_000).then(() => "timeout"),
  ]);

  if (outcome !== "a-held" || state.closed) {
    log(`deadlock follower: ${outcome}`, "muted");
    releaseDeadlock(state);
    return;
  }

  try {
    await navigator.locks.request("deadlock-b", async () => {
      if (state.closed) return;
      log("holds deadlock-b");
      channel.postMessage({ type: "b-held" });
      await deadlockSecond(state, "deadlock-a");
    });
    log("released deadlock-b");
  } catch (error) {
    log(`deadlock follower failed: ${error.message}`, "muted");
  }
}

async function deadlockSecond(state, name) {
  if (state.closed) return;

  const controller = new AbortController();
  state.aborts.add(controller);

  try {
    await navigator.locks.request(name, { signal: controller.signal }, async () => {
      if (state.closed) return;
      log(`acquired ${name} — deadlock resolved`);
      await Promise.race([state.released.promise, wait(10_000)]);
      log(`released ${name}`);
    });
  } catch (error) {
    if (error.name === "AbortError") log(`aborted waiting for ${name}`, "muted");
    else log(`deadlock wait failed: ${error.message}`, "muted");
  } finally {
    state.aborts.delete(controller);
  }
}

function createDeadlockState(channel, runId) {
  const deferred = () => {
    let resolve;
    const promise = new Promise((resolver) => {
      resolve = resolver;
    });
    return { promise, resolve };
  };

  return {
    channel,
    runId,
    closed: false,
    aborts: new Set(),
    released: deferred(),
    aHeld: deferred(),
    bHeld: deferred(),
  };
}

function releaseDeadlock(state, broadcast = true) {
  if (!state || state.closed) return;
  state.closed = true;
  state.released.resolve();
  for (const controller of state.aborts) controller.abort();
  state.aborts.clear();

  if (broadcast) {
    try {
      state.channel.postMessage({ type: "release" });
    } catch {
      // Channel already closed.
    }
  }

  setTimeout(() => {
    try {
      state.channel.close();
    } catch {
      // Already closed.
    }
  }, 200);

  log("deadlock released", "muted");
}

function releaseAll() {
  if (deadlock) {
    releaseDeadlock(deadlock);
    deadlock = null;
  }

  const pending = aborters.size;
  for (const controller of aborters) controller.abort();
  aborters.clear();

  const holders = [...releaseFns.values()];
  releaseFns.clear();
  for (const finish of holders) finish();

  for (const worker of workers) worker.terminate();
  workers.clear();

  log(`released ${holders.length} holder(s), aborted ${pending} waiter(s)`, "muted");
}

async function copyJson() {
  try {
    const state = await navigator.locks.query();
    await navigator.clipboard.writeText(JSON.stringify(state, null, 2));
    log("copied query() JSON", "muted");
  } catch (error) {
    log(`copy failed: ${error.message}`, "muted");
  }
}

async function refreshLive() {
  try {
    const state = await navigator.locks.query();
    renderLive(state);
  } catch (error) {
    els.live.textContent = `query() failed: ${error.message}`;
  }
  setTimeout(() => void refreshLive(), 500);
}

function renderLive(state) {
  const held = state.held.filter((lock) => !isInternal(lock));
  const pending = state.pending.filter((lock) => !isInternal(lock));
  const total = held.length + pending.length;

  if (total === 0) {
    els.live.textContent = "No locks held or requested in this origin.";
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const lock of held) fragment.append(liveRow("held", lock, "held"));
  for (const lock of pending) fragment.append(liveRow("pending", lock, "waiting"));
  els.live.replaceChildren(fragment);
}

function liveRow(kind, lock, label) {
  const row = document.createElement("div");
  row.className = "live-row";

  const state = document.createElement("span");
  state.className = `state ${kind}`;
  state.textContent = label;

  const code = document.createElement("code");
  code.textContent = `${lock.name} · ${lock.mode} · ${String(lock.clientId).slice(0, 8)}`;
  code.title = code.textContent;

  row.append(state, code);
  return row;
}

function isInternal(lock) {
  return typeof lock?.name === "string" && lock.name.startsWith("__lockscope_internal_");
}

function log(text, kind) {
  const item = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString([], { hour12: false });

  const message = document.createElement("span");
  message.textContent = text;
  if (kind) message.className = kind;

  item.append(time, message);
  els.log.prepend(item);

  while (els.log.children.length > 120) {
    els.log.lastElementChild.remove();
  }
}
