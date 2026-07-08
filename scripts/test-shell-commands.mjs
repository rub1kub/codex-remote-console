#!/usr/bin/env node
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  inspectProjectHealth,
  listProjectFiles,
  readProjectDiff,
  readProjectFile,
  searchProjectFiles
} = require("../build/server/remoteExec.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "codex-remote-shell-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "codex-remote-shell-test",
      scripts: {
        test: "node src/index.js",
        build: "node src/index.js"
      }
    }, null, 2));
    await writeFile(path.join(root, "src", "index.js"), "console.log('ok')\n");

    const profile = {
      id: "shell-test",
      name: "shell-test",
      mode: "local",
      sshTarget: "",
      projectPath: root,
      codexBin: "codex",
      approvalPolicy: "never",
      sandboxMode: "read-only",
      createdAt: "",
      updatedAt: ""
    };

    const listing = await listProjectFiles(profile, {}, ".");
    assert(listing.entries.some((entry) => entry.path === "src" && entry.kind === "directory"), "root listing misses src directory");
    assert(listing.entries.some((entry) => entry.path === "package.json" && entry.kind === "file"), "root listing misses package.json");

    const nested = await listProjectFiles(profile, {}, "src");
    assert(nested.entries.some((entry) => entry.path === "src/index.js"), "nested listing misses src/index.js");

    const file = await readProjectFile(profile, {}, "src/index.js");
    assert(file.path === "src/index.js", "file preview returns wrong path");
    assert(file.content.includes("console.log"), "file preview misses content");
    assert(!file.binary, "text file marked as binary");

    const matches = await searchProjectFiles(profile, {}, "index");
    assert(matches.some((match) => match.path === "src/index.js"), "file search misses src/index.js");

    const diff = await readProjectDiff(profile, {}, ["src/index.js"]);
    assert(diff.exitCode === 0, "diff command failed");

    const health = await inspectProjectHealth(profile, {});
    assert(health.diagnostics.some((item) => item.id === "project-dir" && item.status === "ok"), "health misses project-dir ok");
    assert(health.packageJson, "health misses package.json");

    for (const unsafePath of ["..", "../package.json", "/etc/passwd"]) {
      let blocked = false;
      try {
        await readProjectFile(profile, {}, unsafePath);
      } catch {
        blocked = true;
      }
      assert(blocked, `unsafe path was not blocked: ${unsafePath}`);
    }

    console.log("shell command tests: ok");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
