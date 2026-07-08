#!/usr/bin/env node
import { spawn } from "node:child_process";

const port = Number(process.env.CODEX_REMOTE_SMOKE_PORT || 5197);
const baseUrl = process.env.CODEX_REMOTE_SMOKE_BASE_URL || `http://127.0.0.1:${port}`;
const profileIdFromEnv = process.env.CODEX_REMOTE_SMOKE_PROFILE_ID || "";
const smokeFileFromEnv = process.env.CODEX_REMOTE_SMOKE_FILE || "";
const password = process.env.CODEX_REMOTE_SMOKE_PASSWORD || "";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `${path} returned ${response.status}`);
  }
  return data;
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const data = await request("/api/health");
      if (data.ok) return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("server did not become healthy");
}

async function findReadableFile(profileId, rootListing) {
  if (smokeFileFromEnv) return smokeFileFromEnv;
  const directFile = rootListing.entries.find((entry) => entry.kind === "file" && (entry.size || 0) > 0);
  if (directFile) return directFile.path;

  for (const directory of rootListing.entries.filter((entry) => entry.kind === "directory").slice(0, 8)) {
    const data = await request("/api/project/tree", { profileId, password, path: directory.path });
    const file = data.listing.entries.find((entry) => entry.kind === "file" && (entry.size || 0) > 0);
    if (file) return file.path;
  }
  throw new Error("no readable file found for smoke test");
}

async function main() {
  let server = null;
  if (!process.env.CODEX_REMOTE_SMOKE_BASE_URL) {
    server = spawn(process.execPath, ["build/server/index.js"], {
      env: { ...process.env, NODE_ENV: "production", PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    server.stdout.on("data", (chunk) => process.stdout.write(chunk));
    server.stderr.on("data", (chunk) => process.stderr.write(chunk));
  }

  try {
    await waitForHealth();
    const profilesData = await request("/api/profiles");
    const profileId = profileIdFromEnv || profilesData.profiles?.[0]?.id;
    assert(profileId, "no profile found; set CODEX_REMOTE_SMOKE_PROFILE_ID");

    const body = { profileId, password };
    const health = await request("/api/project/health", body);
    assert(health.health.diagnostics?.some((item) => item.id === "ssh" && item.status === "ok"), "diagnostics did not confirm SSH/project command");
    assert(!health.health.diagnostics?.some((item) => item.status === "fail"), "diagnostics contains failed checks");

    const tree = await request("/api/project/tree", { ...body, path: "." });
    assert(tree.listing.entries.length > 0, "project tree is empty");

    const filePath = await findReadableFile(profileId, tree.listing);
    const file = await request("/api/project/file", { ...body, path: filePath });
    assert(file.file.path === filePath, "file preview path mismatch");
    assert(file.file.size >= 0, "file preview size missing");

    const stem = filePath.split("/").pop()?.replace(/\.[^.]+$/, "").slice(0, 40) || filePath;
    const files = await request("/api/project/files", { ...body, query: stem });
    assert(Array.isArray(files.files), "file search did not return an array");

    const diff = await request("/api/project/diff", { ...body, files: [filePath] });
    assert(diff.diff.exitCode === 0, "diff endpoint failed");

    const blocked = await fetch(`${baseUrl}/api/project/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, path: "/etc/passwd" })
    }).then((response) => response.json());
    assert(blocked.error, "absolute path traversal was not blocked");

    console.log(`smoke ssh: ok (${profileId}, ${filePath})`);
  } finally {
    if (server) {
      server.kill("SIGTERM");
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
