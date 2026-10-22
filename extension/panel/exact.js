import { formatExact } from "./format.js";

/**
 * Renders the exact instrumentation records and their stack drawers.
 * The controller decides when the Exact dock is visible.
 */
export function createExactView({ countEl, clearEl, emptyEl, listEl }) {
  let signature = "";

  function updateCount(enabled, records) {
    const count = records?.length || 0;
    countEl.textContent = count ? `${count} record${count === 1 ? "" : "s"}` : "";
    clearEl.disabled = !enabled || count === 0;
  }

  function render(enabled, records, active) {
    if (!active) {
      updateCount(enabled, records);
      return;
    }

    updateCount(enabled, records);

    if (!enabled) {
      emptyEl.hidden = false;
      emptyEl.textContent =
        "Instrumentation is off. Click Instrument to record exact request, acquire, and release times with the awaiting call stack.";
      listEl.replaceChildren();
      signature = "";
      return;
    }

    if (!records?.length) {
      emptyEl.hidden = false;
      emptyEl.textContent =
        "No instrumented requests yet. Trigger a lock request on the page.";
      listEl.replaceChildren();
      signature = "";
      return;
    }

    emptyEl.hidden = true;

    const shown = records.slice(-120).reverse();
    const nextSignature = shown
      .map((record) => `${record.id}:${record.outcome}:${record.acquiredAt}:${record.releasedAt}`)
      .join("|");

    if (nextSignature !== signature) {
      signature = nextSignature;
      rebuild(shown);
    } else {
      updateTimings(shown);
    }
  }

  function reset() {
    signature = "";
  }

  function rebuild(records) {
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
      status.className = `exact-status ${statusClass(record.outcome)}`;
      status.textContent = statusLabel(record.outcome);

      const timing = document.createElement("span");
      timing.className = "exact-timing";
      timing.dataset.exactTiming = String(record.id);
      timing.textContent = timingText(record);

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

    listEl.replaceChildren(fragment);
  }

  function updateTimings(records) {
    const byId = new Map(records.map((record) => [record.id, record]));
    for (const node of listEl.querySelectorAll("[data-exact-timing]")) {
      const record = byId.get(Number(node.dataset.exactTiming));
      if (record) node.textContent = timingText(record);
    }
  }

  function timingText(record) {
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

  function statusLabel(outcome) {
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

  function statusClass(outcome) {
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

  return { render, reset };
}
