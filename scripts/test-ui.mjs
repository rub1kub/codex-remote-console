#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright";

const port = Number(process.env.CODEX_REMOTE_UI_TEST_PORT || 5199);
const baseUrl = `http://127.0.0.1:${port}`;
const dataDir = await mkdtemp(path.join(os.tmpdir(), "codex-remote-ui-"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("UI test server did not become healthy.");
}

const server = spawn(process.execPath, ["build/server/index.js"], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    CODEX_REMOTE_CONSOLE_HOME: dataDir
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let serverError = "";
server.stderr.on("data", (chunk) => {
  serverError += chunk.toString("utf8");
});

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(baseUrl);

  assert(await page.locator(".chat-header .connection-chip").count() === 0, "header duplicates the project connection status");
  assert(await page.locator(".sidebar-footer button").count() === 2, "sidebar footer is not reduced to tasks and settings");

  await page.getByTitle("Центр задач").click();
  const taskLayer = page.locator(".task-center-layer");
  const taskDrawer = page.locator(".task-center-drawer");
  await taskLayer.waitFor({ state: "visible" });
  const drawerBox = await taskDrawer.boundingBox();
  assert(drawerBox, "task center geometry is unavailable");
  await page.mouse.click(Math.max(8, drawerBox.x - 30), 120);
  await page.waitForFunction(
    () => document.querySelector(".task-center-layer")?.classList.contains("closing"),
    undefined,
    { timeout: 500 }
  );
  await taskLayer.waitFor({ state: "detached", timeout: 1_000 });

  await page.getByTitle("Настройки").click();
  const settingsLayer = page.locator(".settings-backdrop");
  await settingsLayer.waitFor({ state: "visible" });
  await page.mouse.click(20, 200);
  await settingsLayer.waitFor({ state: "detached", timeout: 1_200 });

  const composerBox = await page.locator(".composer-box").boundingBox();
  const textareaBox = await page.locator(".composer textarea").boundingBox();
  assert(composerBox && textareaBox, "composer geometry is unavailable");
  assert(textareaBox.y >= composerBox.y, "composer text starts above its container");
  assert(textareaBox.y + textareaBox.height <= composerBox.y + composerBox.height, "composer text overflows its container");

  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  const darkBackground = await page.locator(".app-shell").evaluate((element) => getComputedStyle(element).backgroundColor);
  assert(darkBackground !== "rgb(255, 255, 255)", "system dark theme did not apply");

  console.log("ui e2e: ok");
} catch (error) {
  if (serverError.trim()) console.error(serverError.trim());
  throw error;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await rm(dataDir, { recursive: true, force: true });
}
