const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

process.env.NODE_ENV = "production";
process.env.CODEX_REMOTE_NO_AUTOSTART = "1";

let serverHandle;
let mainWindow;

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
    backgroundColor: "#ffffff",
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
