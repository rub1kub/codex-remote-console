const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexRemote", {
  openWorkspace(profileId) {
    return ipcRenderer.invoke("codex-remote:open-workspace", profileId);
  },
  setTheme(theme) {
    return ipcRenderer.invoke("codex-remote:set-theme", theme);
  }
});
