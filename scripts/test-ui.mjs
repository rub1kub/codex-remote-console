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

  await page.getByTitle("Модель и режим ответа").click();
  await page.waitForTimeout(220);
  const composerPopover = page.locator(".composer-popover");
  const popoverBox = await composerPopover.boundingBox();
  assert(popoverBox, "model popover geometry is unavailable");
  assert(popoverBox.width <= 400, "model popover is wider than a compact desktop menu");
  assert(popoverBox.height < 600, "model popover covers too much of the workspace");
  assert(await page.locator(".modal-backdrop, .settings-backdrop").count() === 0, "model popover created an unexpected overlay");
  await page.locator(".popover-disclosure").filter({ hasText: "Модель" }).click();
  assert(await page.getByRole("button", { name: "GPT-5.6-Sol" }).isVisible(), "GPT-5.6-Sol is missing from the model picker");
  assert(await page.getByRole("button", { name: "GPT-5.6-Terra" }).isVisible(), "GPT-5.6-Terra is missing from the model picker");
  assert(await page.getByRole("button", { name: "GPT-5.6-Luna" }).isVisible(), "GPT-5.6-Luna is missing from the model picker");
  await page.keyboard.press("Escape");

  await page.getByTitle("Центр задач").click();
  const taskLayer = page.locator(".task-center-layer");
  const taskDrawer = page.locator(".task-center-drawer");
  await taskLayer.waitFor({ state: "visible" });
  const drawerBox = await taskDrawer.boundingBox();
  assert(drawerBox, "task center geometry is unavailable");
  assert(Math.abs(drawerBox.x - (1280 - drawerBox.width) / 2) <= 2, "task center is not centered");
  assert(drawerBox.height <= 764, "task center exceeds the viewport");
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

  await page.locator(".messages").evaluate((messages) => {
    const fixture = document.createElement("section");
    fixture.className = "turn-group ui-geometry-fixture";
    fixture.innerHTML = `
      <article class="message user">
        <div class="message-avatar">Вы</div>
        <div class="message-body">
          <div class="message-head"><span class="message-author">Вы</span></div>
          <div class="message-content">${"Длинное пользовательское сообщение ".repeat(24)}</div>
        </div>
      </article>
      <article class="message assistant">
        <div class="message-avatar">C</div>
        <div class="message-body">
          <div class="message-head"><span class="message-author">Codex</span></div>
          <div class="message-content">${"Развернутый итог задачи ".repeat(20)}</div>
        </div>
      </article>
    `;
    messages.append(fixture);
  });
  const fixtureMessages = page.locator(".ui-geometry-fixture > .message");
  const userMessageBox = await fixtureMessages.nth(0).boundingBox();
  const assistantMessageBox = await fixtureMessages.nth(1).boundingBox();
  const userBodyBox = await fixtureMessages.nth(0).locator(".message-body").boundingBox();
  const assistantBodyBox = await fixtureMessages.nth(1).locator(".message-body").boundingBox();
  assert(userMessageBox && assistantMessageBox && userBodyBox && assistantBodyBox, "message geometry is unavailable");
  assert(assistantMessageBox.y >= userMessageBox.y + userMessageBox.height, "messages in one turn are laid out horizontally");
  assert(userBodyBox.width >= userMessageBox.width * 0.6, "long user message collapsed into a narrow column");
  assert(assistantBodyBox.width >= assistantMessageBox.width * 0.8, "assistant message collapsed into a narrow column");
  await page.locator(".ui-geometry-fixture").evaluate((element) => element.remove());

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
