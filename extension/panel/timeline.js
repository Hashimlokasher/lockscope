/**
 * Canvas timeline for LockScope.
 *
 * Draws one lane per lock name over a trailing window. Held intervals are solid,
 * pending intervals are dashed/hatched, and overlapping intervals within a lane
 * stack into sub-rows. No continuous animation: redraw only when data, size,
 * hover, or theme changes.
 */

import { formatDuration, shortId } from "./format.js";

const AXIS_H = 17;
const PAD_BOTTOM = 5;
const LANE_GAP = 3;
const BAR_H = 9;
const BAR_STEP = 11;
const MAX_SUBROWS = 4;
const MIN_LANE_H = 15;

export function createTimeline(canvas, tooltip) {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return { setData() {}, setWindow() {}, redraw() {}, destroy() {} };
  }

  let data = { now: 0, paused: false, intervals: [], windowMs: 60_000, filtered: false };
  let width = 0;
  let height = 0;
  let dpr = 1;
  let frame = 0;
  let hits = [];
  let hoverId = null;
  let destroyed = false;

  const observer = new ResizeObserver(resize);
  observer.observe(canvas.parentElement || canvas);

  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerleave", clearHover);
  canvas.addEventListener("blur", clearHover);

  resize();

  return { setData, setWindow, redraw: schedule, destroy };

  function setData(next) {
    data = { ...data, ...next };
    schedule();
  }

  function setWindow(ms) {
    data.windowMs = Math.max(5000, Number(ms) || 60_000);
    clearHover();
    schedule();
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));

    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

    schedule();
  }

  function schedule() {
    if (frame || destroyed) return;

    // rAF is paused in a hidden DevTools iframe (headless captures, minimized
    // windows), but the canvas still renders. Draw synchronously there.
    if (document.visibilityState === "hidden") {
      draw();
      return;
    }

    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  }

  function draw() {
    if (destroyed) return;

    const style = getComputedStyle(canvas);
    const colors = {
      text: css(style, "--text", "#1f2328"),
      muted: css(style, "--muted", "#636c76"),
      border: css(style, "--border", "#d8dee4"),
      subtle: css(style, "--border-subtle", "#eaeef2"),
      band: css(style, "--bg-subtle", "#f6f8fa"),
    };
    const dark = document.documentElement.dataset.theme === "dark";
    const now = data.now || Date.now();
    const windowMs = data.windowMs;
    const start = now - windowMs;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const left = Math.min(172, Math.max(94, Math.round(width * 0.24)));
    const right = 8;
    const plotW = Math.max(20, width - left - right);
    const plotTop = AXIS_H;
    const plotH = Math.max(20, height - AXIS_H - PAD_BOTTOM);
    const plotBottom = plotTop + plotH;

    drawAxis({ colors, left, plotW, plotTop, plotH, start, now, windowMs });

    const visible = data.intervals.filter(
      (interval) => (interval.end ?? now) >= start && interval.start <= now,
    );

    if (!visible.length) {
      hits = [];
      ctx.fillStyle = colors.muted;
      ctx.font = "11px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        data.filtered
          ? "No matching activity in this window"
          : "No lock activity in this window",
        left + plotW / 2,
        plotTop + plotH / 2,
      );
      updateAria(0);
      return;
    }

    const byName = new Map();
    for (const interval of visible) {
      const list = byName.get(interval.name);
      if (list) list.push(interval);
      else byName.set(interval.name, [interval]);
    }

    const names = [...byName.keys()].sort((a, b) => a.localeCompare(b));
    hits = [];

    let y = plotTop;
    let drawn = 0;
    let hiddenLanes = 0;

    for (const name of names) {
      const layout = layoutLane(byName.get(name), start, now);
      if (!layout.items.length) continue;

      const subrows = Math.min(MAX_SUBROWS, layout.rows);
      const laneH = Math.max(MIN_LANE_H, subrows * BAR_STEP + 4);

      if (y + laneH > plotBottom) {
        hiddenLanes = names.length - drawn;
        break;
      }

      ctx.fillStyle = colors.band;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(left, y, plotW, laneH);
      ctx.globalAlpha = 1;

      ctx.fillStyle = colors.text;
      ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(fitText(name, left - 14), 6, y + Math.min(laneH / 2, 10));

      for (const bar of layout.items) {
        if (bar.row >= MAX_SUBROWS) continue;
        drawBar({ bar, colors, dark, left, plotW, windowMs, start, now, y });
      }

      if (layout.rows > MAX_SUBROWS) {
        ctx.fillStyle = colors.muted;
        ctx.font = "9.5px system-ui, sans-serif";
        ctx.textAlign = "right";
        ctx.fillText(`+${layout.rows - MAX_SUBROWS}`, left + plotW - 4, y + laneH - 5);
      }

      ctx.strokeStyle = colors.subtle;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(4, y + laneH + 1.5);
      ctx.lineTo(left + plotW, y + laneH + 1.5);
      ctx.stroke();

      y += laneH + LANE_GAP;
      drawn += 1;
    }

    if (hiddenLanes > 0) {
      ctx.fillStyle = colors.muted;
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(`+${hiddenLanes} more lane${hiddenLanes === 1 ? "" : "s"}`, left, height - 2);
    }

    updateAria(drawn);
  }

  function drawAxis({ colors, left, plotW, plotTop, plotH, start, now, windowMs }) {
    const step = windowMs <= 15_000 ? 2000 : windowMs <= 60_000 ? 10_000 : 60_000;
    const first = Math.ceil(start / step) * step;

    ctx.font = "9.5px system-ui, -apple-system, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";

    for (let t = first; t < now; t += step) {
      const x = left + ((t - start) / windowMs) * plotW;
      ctx.strokeStyle = colors.subtle;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, plotTop - 2);
      ctx.lineTo(x + 0.5, plotTop + plotH);
      ctx.stroke();

      ctx.fillStyle = colors.muted;
      ctx.fillText(`${Math.round((t - now) / 1000)}s`, Math.max(left + 12, x), 8);
    }

    ctx.strokeStyle = colors.subtle;
    ctx.beginPath();
    ctx.moveTo(left + plotW + 0.5, plotTop - 2);
    ctx.lineTo(left + plotW + 0.5, plotTop + plotH);
    ctx.stroke();

    ctx.fillStyle = colors.muted;
    ctx.textAlign = "right";
    ctx.fillText("now", left + plotW, 8);

    ctx.strokeStyle = colors.border;
    ctx.beginPath();
    ctx.moveTo(4, plotTop - 2.5);
    ctx.lineTo(left + plotW, plotTop - 2.5);
    ctx.stroke();
  }

  function drawBar({ bar, colors, dark, left, plotW, windowMs, start, now, y }) {
    const x = left + ((Math.max(bar.s, start) - start) / windowMs) * plotW;
    const w = Math.max(2, ((bar.e - bar.s) / windowMs) * plotW);
    const top = y + 2 + bar.row * BAR_STEP;
    const color = clientColor(bar.clientId, dark);
    const id = intervalId(bar);

    ctx.save();
    if (bar.state === "pending") {
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = color;
      roundedRect(ctx, x, top, w, BAR_H, 2);
      ctx.fill();

      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      roundedRect(ctx, x, top, w, BAR_H, 2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = color;
      roundedRect(ctx, x, top, w, BAR_H, 2);
      ctx.fill();
    }

    if (id === hoverId) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = colors.text;
      ctx.lineWidth = 1.5;
      roundedRect(ctx, x, top, w, BAR_H, 2);
      ctx.stroke();
    }
    ctx.restore();

    hits.push({ x, y: top, w, h: BAR_H, bar });
  }

  function layoutLane(intervals, start, now) {
    const items = [];

    for (const interval of intervals) {
      const s = Math.max(interval.start, start);
      const e = Math.min(interval.end ?? now, now);
      if (e < s) continue;
      items.push({ ...interval, s, e, row: 0 });
    }

    items.sort((a, b) => a.s - b.s || (a.state === "held" ? -1 : 1));

    const rows = [];
    for (const item of items) {
      let rowIndex = -1;
      for (let i = 0; i < rows.length; i += 1) {
        if (item.s >= rows[i]) {
          rowIndex = i;
          break;
        }
      }
      if (rowIndex === -1) {
        rowIndex = rows.length;
        rows.push(item.e);
      } else {
        rows[rowIndex] = Math.max(rows[rowIndex], item.e);
      }
      item.row = rowIndex;
    }

    return { items, rows: rows.length };
  }

  function onPointerMove(event) {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hit = hits.find(
      (box) => x >= box.x - 2 && x <= box.x + box.w + 2 && y >= box.y - 2 && y <= box.y + box.h + 2,
    );

    if (!hit) {
      clearHover();
      return;
    }

    const id = intervalId(hit.bar);
    if (id !== hoverId) {
      hoverId = id;
      schedule();
    }

    showTooltip(hit.bar, event.clientX, event.clientY);
  }

  function showTooltip(bar, clientX, clientY) {
    const now = data.now || Date.now();
    const duration = Math.max(0, (bar.end ?? now) - bar.start);
    const startedAgo = Math.max(0, now - bar.start);

    tooltip.textContent = [
      bar.name,
      `${bar.mode} · ${bar.state === "held" ? "held" : "waiting ≥"} ${formatDuration(duration)}`,
      `client ${shortId(bar.clientId)} · started ${formatDuration(startedAgo)} ago`,
    ].join("\n");
    tooltip.hidden = false;

    const host = tooltip.offsetParent?.getBoundingClientRect() || canvas.getBoundingClientRect();
    let left = clientX - host.left + 12;
    let top = clientY - host.top + 14;

    left = Math.max(4, Math.min(left, host.width - tooltip.offsetWidth - 6));
    top = Math.max(4, Math.min(top, host.height - tooltip.offsetHeight - 6));

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function clearHover() {
    const changed = hoverId !== null || !tooltip.hidden;
    hoverId = null;
    tooltip.hidden = true;
    if (changed) schedule();
  }

  function updateAria(count) {
    canvas.setAttribute(
      "aria-label",
      `Timeline: ${count} lock lane${count === 1 ? "" : "s"} over the last ${formatDuration(
        data.windowMs,
      )}.`,
    );
  }

  function fitText(text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let value = text;
    while (value.length > 1 && ctx.measureText(`${value}…`).width > maxWidth) {
      value = value.slice(0, -1);
    }
    return `${value}…`;
  }

  function destroy() {
    destroyed = true;
    if (frame) cancelAnimationFrame(frame);
    observer.disconnect();
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerleave", clearHover);
    canvas.removeEventListener("blur", clearHover);
  }
}

function css(style, name, fallback) {
  return style.getPropertyValue(name).trim() || fallback;
}

function intervalId(bar) {
  return `${bar.key}:${bar.state}:${bar.start}`;
}

function clientColor(clientId, dark) {
  let hash = 2166136261;
  const text = String(clientId || "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hue = Math.abs(hash) % 360;
  return dark ? `hsl(${hue} 62% 68%)` : `hsl(${hue} 64% 42%)`;
}

function roundedRect(ctx, x, y, w, h, radius) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, radius);
  } else {
    ctx.rect(x, y, w, h);
  }
}
