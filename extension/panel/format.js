/**
 * Pure formatting helpers. Kept dependency-free so Node can test them.
 */

/**
 * @param {unknown} value
 * @param {number} [length]
 */
export function shortId(value, length = 8) {
  const text = String(value ?? "");
  return text.length > length ? text.slice(0, length) : text;
}

/**
 * @param {unknown} mode
 */
export function modeLabel(mode) {
  if (mode === "exclusive") return "Exclusive";
  if (mode === "shared") return "Shared";
  return mode ? String(mode) : "—";
}

/**
 * @param {number} ms
 */
export function formatInterval(ms) {
  if (ms >= 1000) {
    const seconds = ms / 1000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
  }
  return `${Math.round(ms)} ms`;
}

/**
 * Observed durations are always "at least" this long.
 * @param {number} ms
 */
export function formatDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 10_000) return `${(value / 1000).toFixed(1)} s`;
  if (value < 59_500) return `${Math.round(value / 1000)} s`;

  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * Exact instrumentation durations: milliseconds under a second, then 2dp.
 * @param {number} ms
 */
export function formatExact(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 10_000) return `${(value / 1000).toFixed(2)} s`;
  return formatDuration(value);
}

/**
 * Match pattern for an http(s) URL's origin, used for optional host permissions.
 * @param {string | undefined} url
 */
export function originPattern(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.protocol}//${parsed.host}/*`;
  } catch {
    return null;
  }
}

/**
 * @param {string | undefined} url
 */
export function formatUrl(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return String(url);
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return `${parsed.host}${path === "/" ? "" : path}`;
  } catch {
    return String(url);
  }
}
