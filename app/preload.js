'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kiln', {
  app: true,
  elevate: () => ipcRenderer.invoke('kiln:elevate'),
});
