const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

process.env.NODE_ENV = "production";
process.env.CODEX_REMOTE_NO_AUTOSTART = "1";

let serverHandle;
let mainWindow;

const appDescription =
  "Desktop app for remote Codex CLI sessions over SSH with project history, folder picker, chat UI, and packaged builds for macOS, Windows, and Linux.";
const repoUrl = "https://github.com/rub1kub/codex-remote-console";

function getWindowIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(app.getAppPath(), "build", "icon.png");
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

async function createWindow() {
  serverHandle = await startBackend();

  mainWindow = new BrowserWindow({
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
            color: "#f0f2ef",
            symbolColor: "#202422",
            height: 36
          }
        }),
    backgroundColor: "#f0f2ef",
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  await mainWindow.loadURL(serverHandle.url);
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
