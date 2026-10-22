const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  switchMode: (mode) => ipcRenderer.send('switch-mode', mode),
  setAlwaysOnTop: (flag) => ipcRenderer.send('set-always-on-top', flag),
  minimizeApp: () => ipcRenderer.send('minimize-app'),
  closeApp: () => ipcRenderer.send('close-app'),
  setIgnoreMouseEvents: (ignore, options) => ipcRenderer.send('set-ignore-mouse-events', ignore, options),
  
  onModeChanged: (callback) => {
    ipcRenderer.on('mode-changed', (_event, mode) => callback(mode));
  },
  onToggleModeRequest: (callback) => {
    ipcRenderer.on('toggle-mode-request', (_event, mode) => callback(mode));
  },
  onPetInteraction: (callback) => {
    ipcRenderer.on('pet-interaction', (_event, type) => callback(type));
  }
});
