/**
 * LockScope — DevTools bootstrap.
 *
 * The panel runs inside the DevTools window, so it has direct access to
 * chrome.devtools.*. All sampling state lives in the panel; this page only
 * registers it. That avoids a second transport (runtime ports need a service
 * worker) and keeps the extension free of a background context.
 */

chrome.devtools.panels.create(
  "LockScope",
  "icons/icon32.png",
  "panel/panel.html",
);
