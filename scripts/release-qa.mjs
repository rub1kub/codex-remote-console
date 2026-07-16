#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const root = new URL("..", import.meta.url);

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, root), "utf8"));
}

function readText(path) {
  return readFileSync(new URL(path, root), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exists(path) {
  return existsSync(new URL(path, root));
}

function gitStatus() {
  return execFileSync("git", ["status", "--short"], {
    cwd: new URL(".", root),
    encoding: "utf8"
  }).trim();
}

const pkg = readJson("package.json");
const lock = readJson("package-lock.json");
const version = pkg.version;

assert(version, "package.json version is empty");
assert(lock.version === version, "package-lock root version does not match package.json");
assert(lock.packages?.[""]?.version === version, "package-lock package version does not match package.json");
assert(readText("src/App.tsx").includes(`const appVersion = "${version}"`), "src/App.tsx appVersion does not match package version");
assert(readText("server/codexBridge.ts").includes(`version: "${version}"`), "server/codexBridge.ts clientInfo version does not match package version");

for (const file of ["build/icon.png", "build/icon.icns", "build/icon.ico"]) {
  assert(exists(file), `${file} is missing`);
}

for (const script of ["build", "test:task-protocol", "test:model-catalog", "test:message-history", "test:ui", "test:project-tools", "test:shell", "smoke:ssh", "qa:release"]) {
  assert(pkg.scripts?.[script], `npm script ${script} is missing`);
}

assert(exists("electron/preload.cjs"), "electron/preload.cjs is missing");
assert(readText("electron/main.cjs").includes("codex-remote:open-workspace"), "multi-window IPC is missing");

if (args.has("--require-clean")) {
  assert(!gitStatus(), "git worktree is not clean");
}

if (args.has("--assets")) {
  const required = [
    `release/Codex-Remote-${version}-mac-arm64.dmg`,
    `release/Codex-Remote-${version}-mac-arm64.zip`,
    `release/Codex-Remote-${version}-mac-x64.dmg`,
    `release/Codex-Remote-${version}-mac-x64.zip`,
    `release/Codex-Remote-${version}-win-arm64.exe`,
    `release/Codex-Remote-${version}-win-x64.exe`,
    `release/Codex-Remote-${version}-linux-arm64.AppImage`,
    `release/Codex-Remote-${version}-linux-arm64.deb`,
    `release/Codex-Remote-${version}-linux-x86_64.AppImage`,
    `release/Codex-Remote-${version}-linux-amd64.deb`,
    "release/latest.yml",
    "release/latest-mac.yml",
    "release/latest-linux.yml",
    "release/latest-linux-arm64.yml"
  ];
  for (const file of required) {
    assert(exists(file), `${file} is missing`);
  }
}

console.log(`release qa: ok (${version})`);
