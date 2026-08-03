const { app, BrowserWindow, Menu, ipcMain, nativeTheme, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

process.env.NODE_ENV = "production";
process.env.CODEX_REMOTE_NO_AUTOSTART = "1";

let serverHandle;
let mainWindow;
const appWindows = new Set();

const appDescription =
  "Desktop app for remote Codex CLI sessions over SSH with project history, folder picker, chat UI, and packaged builds for macOS, Windows, and Linux.";
const repoUrl = "https://github.com/rub1kub/codex-remote-console";

function getWindowIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(app.getAppPath(), "build", "icon.png");
}

const titleBarThemes = {
  light: { background: "#f5f5f7", overlay: "#f5f5f7", symbol: "#1d1d1f" },
  dark: { background: "#1c1c1e", overlay: "#1c1c1e", symbol: "#f5f5f7" }
};

function resolveTitleBarTheme(theme) {
  if (theme === "light" || theme === "dark") return titleBarThemes[theme];
  return nativeTheme.shouldUseDarkColors ? titleBarThemes.dark : titleBarThemes.light;
}

function applyWindowTheme(window, theme) {
  const colors = resolveTitleBarTheme(theme);
  window.setBackgroundColor(colors.background);
  if (process.platform !== "darwin" && typeof window.setTitleBarOverlay === "function") {
    window.setTitleBarOverlay({
      color: colors.overlay,
      symbolColor: colors.symbol,
      height: 40
    });
  }
}

async function startBackend() {
  const appRoot = app.getAppPath();
  const serverEntry = path.join(appRoot, "build", "server", "index.js");
  const serverModule = await import(pathToFileURL(serverEntry).href);
  return serverModule.startServer({
    host: "127.0.0.1",
    port: 0,
    root: appRoot,
    isProduction: true
  });
}

function createMenu() {
  const template = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" }
            ]
          }
        ]
      : []),
    {
      label: "Файл",
      submenu: [
        process.platform === "darwin" ? { role: "close" } : { role: "quit" }
      ]
    },
    {
      label: "Правка",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { type: "separator" },
        { role: "selectAll" }
      ]
    },
    {
      label: "Вид",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" }
      ]
    },
    {
      label: "Справка",
      submenu: [
        {
          label: "О приложении",
          click: () => app.showAboutPanel()
        },
        {
          label: "GitHub",
          click: () => shell.openExternal(repoUrl)
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function ensureBackend() {
  if (!serverHandle) {
    serverHandle = await startBackend();
  }
  return serverHandle;
}

function isTrustedRenderer(event) {
  if (!serverHandle) return false;
  try {
    const senderUrl = new URL(event.senderFrame.url);
    const backendUrl = new URL(serverHandle.url);
    return senderUrl.origin === backendUrl.origin;
  } catch {
    return false;
  }
}

async function createWindow(profileId = "") {
  const backend = await ensureBackend();
  const initialTheme = resolveTitleBarTheme("system");

  const window = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 860,
    minHeight: 620,
    title: "Codex Remote",
    icon: getWindowIconPath(),
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 14, y: 11 }
        }
      : {
          titleBarStyle: "hidden",
          titleBarOverlay: {
            color: initialTheme.overlay,
            symbolColor: initialTheme.symbol,
            height: 40
          }
        }),
    backgroundColor: initialTheme.background,
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  appWindows.add(window);
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = window;

  window.on("closed", () => {
    appWindows.delete(window);
    if (mainWindow === window) {
      mainWindow = BrowserWindow.getAllWindows()[0] || null;
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  const targetUrl = new URL(backend.url);
  if (profileId) targetUrl.searchParams.set("profile", profileId);
  await window.loadURL(targetUrl.toString());
  return window;
}

app.whenReady().then(async () => {
  app.setName("Codex Remote");
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(getWindowIconPath());
  }
  app.setAboutPanelOptions({
    applicationName: "Codex Remote",
    applicationVersion: app.getVersion(),
    iconPath: getWindowIconPath(),
    copyright: "© 2026 rub1kub",
    credits: `${appDescription}\n\nGitHub: ${repoUrl}`
  });
  createMenu();
  ipcMain.handle("codex-remote:open-workspace", async (event, profileId) => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted renderer.");
    if (typeof profileId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(profileId)) {
      throw new Error("Invalid project id.");
    }
    await createWindow(profileId);
    return true;
  });
  ipcMain.handle("codex-remote:set-theme", (event, theme) => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted renderer.");
    if (theme !== "light" && theme !== "dark" && theme !== "system") {
      throw new Error("Invalid theme.");
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && !window.isDestroyed()) {
      applyWindowTheme(window, theme);
    }
    return true;
  });
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  if (serverHandle) {
    await serverHandle.close().catch(() => undefined);
    serverHandle = undefined;
  }
});
