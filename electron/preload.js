'use strict';
// Narrow bridge between the UI and the main process. The page gets no Node access.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  api: (method, path, query, body) => ipcRenderer.invoke('api', { method, path, query, body }),
  copy: (text) => ipcRenderer.invoke('clipboard', text),
  onUpdate: (fn) => { ipcRenderer.on('update', (_e, d) => fn(d)); },
  setTitleBar: (colors) => ipcRenderer.send('titlebar', colors),
  platform: process.platform,
});
