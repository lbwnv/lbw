'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 渲染进程能调用的全部能力，仅此而已
contextBridge.exposeInMainWorld('relay', Object.freeze({
  status: () => ipcRenderer.invoke('relay:status'),
  login: form => ipcRenderer.invoke('relay:login', form),
  refresh: () => ipcRenderer.invoke('relay:refresh'),
  logs: query => ipcRenderer.invoke('relay:logs', query),
  logout: () => ipcRenderer.invoke('relay:logout'),
  openSite: () => ipcRenderer.invoke('relay:open-site'),
  getSettings: () => ipcRenderer.invoke('app:get-settings'),
  setTheme: theme => ipcRenderer.invoke('app:set-theme', theme),
  setMode: mode => ipcRenderer.invoke('app:set-mode', mode),
  setAlwaysOnTop: enabled => ipcRenderer.invoke('app:set-always-on-top', Boolean(enabled)),
  minimize: () => ipcRenderer.invoke('win:minimize'),
  close: () => ipcRenderer.invoke('win:close'),
  toggleMaximize: () => ipcRenderer.invoke('win:toggle-maximize'),
  resize: size => ipcRenderer.send('win:resize', size),
  resizeEnd: () => ipcRenderer.send('win:resize-end'),
  onRefreshRequest: callback => ipcRenderer.on('app:refresh', () => callback()),
  onSettings: callback => ipcRenderer.on('app:settings', (_event, value) => callback(value))
}));
