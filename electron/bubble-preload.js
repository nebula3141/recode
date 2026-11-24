'use strict';
// Bridge for the floating bubble page. Only the calls the bubble needs.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bubble', {
  onState: (fn) => ipcRenderer.on('bubble:state', (_e, s) => fn(s)),
  click: () => ipcRenderer.send('bubble:click'),
  pick: (sessionId) => ipcRenderer.send('bubble:pick', String(sessionId)),
  openApp: () => ipcRenderer.send('bubble:open-app'),
  collapse: () => ipcRenderer.send('bubble:collapse'),
  menu: () => ipcRenderer.send('bubble:menu'),
  dragStart: (x, y) => ipcRenderer.send('bubble:drag-start', { x, y }),
  dragMove: (x, y) => ipcRenderer.send('bubble:drag-move', { x, y }),
  dragEnd: () => ipcRenderer.send('bubble:drag-end'),
});
