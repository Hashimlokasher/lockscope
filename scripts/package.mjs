#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = path.join(root, "extension");
const manifestPath = path.join(extensionDir, "manifest.json");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const distDir = path.join(root, "dist");
const outFile = path.join(distDir, `lockscope-${manifest.version}.zip`);

const required = [
  "manifest.json",
  "devtools.html",
  "devtools.js",
  "page-agent.js",
  "instrument.js",
  "panel/panel.html",
  "panel/panel.css",
  "panel/panel.js",
  "panel/model.js",
  "panel/timeline.js",
  "panel/format.js",
  "panel/lanes.js",
  "panel/tabs.js",
  "panel/instrumentation.js",
  "panel/exact.js",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
];

for (const file of required) {
  if (!fs.existsSync(path.join(extensionDir, file))) {
    throw new Error(`Missing required extension file: ${file}`);
  }
}

const files = [];
const walk = (dir, prefix = "") => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === ".DS_Store") continue;
    const rel = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
    else if (entry.isFile()) files.push(rel);
  }
};
walk(extensionDir);

fs.mkdirSync(distDir, { recursive: true });
if (fs.existsSync(outFile)) fs.unlinkSync(outFile);

try {
  execFileSync("zip", ["-q", "-r", "-X", outFile, ...files], {
    cwd: extensionDir,
    stdio: "inherit",
  });
} catch (error) {
  if (error.code === "ENOENT") {
    throw new Error("The `zip` command is required to build the extension archive.");
  }
  throw error;
}

const size = fs.statSync(outFile).size;
console.log(`Packaged ${manifest.name} v${manifest.version}`);
console.log(`${path.relative(root, outFile)} · ${files.length} files · ${(size / 1024).toFixed(1)} KB`);

console.log(`Files (${files.length}):`);
for (const file of files) console.log(`  ${file}`);
