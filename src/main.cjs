'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { RelayClient, ClientError } = require('./client.cjs');

const SIZES = {
  widget: { width: 384, height: 552 },
  full: { width: 1180, height: 820, minWidth: 900, minHeight: 640 }
};

let win = null;
let tray = null;
let client = null;
let quitting = false;
let settings = { mode: 'widget', theme: 'dark', alwaysOnTop: false, bounds: {} };
let animation = null;

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

async function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(await fs.readFile(settingsFile(), 'utf8')) }; } catch { /* 首次启动 */ }
}

let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(settingsFile(), JSON.stringify(settings), 'utf8').catch(() => {}), 300);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// 让窗口始终落在某块屏幕的工作区内（多显示器拔插后也不会“丢窗”）
function fitToWorkArea(bounds) {
  const work = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(bounds.width, work.width);
  const height = Math.min(bounds.height, work.height);
  return {
    width,
    height,
    x: clamp(bounds.x, work.x, work.x + work.width - width),
    y: clamp(bounds.y, work.y, work.y + work.height - height)
  };
}

function animateBounds(target, duration = 260) {
  if (!win) return;
  if (animation) clearInterval(animation);
  const from = win.getBounds();
  const started = Date.now();
  const ease = t => 1 - (1 - t) ** 4;
  animation = setInterval(() => {
    if (!win || win.isDestroyed()) return clearInterval(animation);
    const t = clamp((Date.now() - started) / duration, 0, 1);
    const k = ease(t);
    win.setBounds({
      x: Math.round(from.x + (target.x - from.x) * k),
      y: Math.round(from.y + (target.y - from.y) * k),
      width: Math.round(from.width + (target.width - from.width) * k),
      height: Math.round(from.height + (target.height - from.height) * k)
    });
    if (t >= 1) {
      clearInterval(animation);
      animation = null;
      rememberBounds();
    }
  }, 16);
}

function rememberBounds() {
  if (!win || win.isDestroyed() || win.isMaximized()) return;
  settings.bounds[settings.mode] = win.getBounds();
  saveSettings();
}

function targetBounds(mode) {
  const size = SIZES[mode];
  const saved = settings.bounds[mode];
  const current = win ? win.getBounds() : null;
  const width = mode === 'full' && saved ? Math.max(saved.width, size.minWidth) : size.width;
  const height = mode === 'full' && saved ? Math.max(saved.height, size.minHeight) : size.height;
  let x;
  let y;
  if (current) {
    // 以当前窗口中心为锚点展开/收起
    x = Math.round(current.x + current.width / 2 - width / 2);
    y = Math.round(current.y + current.height / 2 - height / 2);
  } else if (saved) {
    ({ x, y } = saved);
  } else {
    const work = screen.getPrimaryDisplay().workArea;
    x = Math.round(work.x + (work.width - width) / 2);
    y = Math.round(work.y + (work.height - height) / 2);
  }
  return fitToWorkArea({ x, y, width, height });
}

function createWindow() {
  const bounds = targetBounds(settings.mode);
  win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    skipTaskbar: false,
    alwaysOnTop: settings.alwaysOnTop,
    title: 'CapyLedger · 卡皮账本',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  });
  if (settings.alwaysOnTop) win.setAlwaysOnTop(true, 'floating');
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show();
  });
  win.on('close', event => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });
  win.on('moved', rememberBounds);

  // 渲染进程不允许跳转、不允许开新窗口
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function trayIcon() {
  // .ico 内含 16/20/24/32 等尺寸，系统按当前 DPI 自动挑选最清晰的一张
  return nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico'));
}

function buildTrayMenu() {
  const login = app.getLoginItemSettings();
  return Menu.buildFromTemplate([
    { label: '显示面板', click: showWindow },
    { label: '刷新数据', click: () => { showWindow(); win?.webContents.send('app:refresh'); } },
    { type: 'separator' },
    {
      label: '窗口置顶',
      type: 'checkbox',
      checked: settings.alwaysOnTop,
      click: item => setAlwaysOnTop(item.checked)
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: login.openAtLogin,
      click: item => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] })
    },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]);
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('CapyLedger · 卡皮账本');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => (win?.isVisible() && win.isFocused() ? win.hide() : showWindow()));
}

function setAlwaysOnTop(enabled) {
  settings.alwaysOnTop = Boolean(enabled);
  win?.setAlwaysOnTop(settings.alwaysOnTop, settings.alwaysOnTop ? 'floating' : 'normal');
  saveSettings();
  tray?.setContextMenu(buildTrayMenu());
  win?.webContents.send('app:settings', settings);
  return settings.alwaysOnTop;
}

// 把主进程的错误转成干净的中文消息给界面
function safe(handler) {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      throw new Error(error instanceof ClientError ? error.message : '操作失败，请稍后再试');
    }
  };
}

function registerIpc() {
  ipcMain.handle('app:get-settings', () => settings);
  ipcMain.handle('app:set-theme', (_event, theme) => {
    settings.theme = theme === 'light' ? 'light' : 'dark';
    saveSettings();
    return settings.theme;
  });
  ipcMain.handle('app:set-always-on-top', (_event, enabled) => setAlwaysOnTop(enabled));
  ipcMain.handle('app:set-mode', (_event, mode) => {
    if (!win) return null;
    const next = mode === 'full' ? 'full' : 'widget';
    if (win.isMaximized()) win.unmaximize();
    rememberBounds();
    settings.mode = next;
    saveSettings();
    animateBounds(targetBounds(next));
    return next;
  });
  ipcMain.handle('win:minimize', () => win?.minimize());
  ipcMain.handle('win:close', () => win?.hide());
  ipcMain.handle('win:toggle-maximize', () => {
    if (!win || settings.mode !== 'full') return false;
    // 透明窗口无法使用系统最大化，这里手动铺满工作区
    if (settings.maximizedFrom) {
      animateBounds(settings.maximizedFrom, 220);
      settings.maximizedFrom = null;
      return false;
    }
    settings.maximizedFrom = win.getBounds();
    animateBounds(screen.getDisplayMatching(win.getBounds()).workArea, 220);
    return true;
  });
  // 自绘的右下角缩放手柄（透明窗口没有系统缩放边框）
  ipcMain.on('win:resize', (_event, { width, height }) => {
    if (!win || settings.mode !== 'full') return;
    const bounds = win.getBounds();
    const work = screen.getDisplayMatching(bounds).workArea;
    settings.maximizedFrom = null;
    win.setBounds({
      ...bounds,
      width: clamp(Math.round(width), SIZES.full.minWidth, work.x + work.width - bounds.x),
      height: clamp(Math.round(height), SIZES.full.minHeight, work.y + work.height - bounds.y)
    });
  });
  ipcMain.on('win:resize-end', rememberBounds);

  ipcMain.handle('relay:status', safe(() => client.status()));
  ipcMain.handle('relay:login', safe((_event, form) => client.login(form || {})));
  ipcMain.handle('relay:refresh', safe(() => client.refresh()));
  ipcMain.handle('relay:logs', safe((_event, query) => client.logs(query || {})));
  ipcMain.handle('relay:logout', safe(() => client.logout()));
  ipcMain.handle('relay:open-site', async () => {
    const status = await client.status();
    if (/^https:\/\//.test(status.baseUrl)) await shell.openExternal(status.baseUrl);
  });
}

function lockDownSession() {
  // 渲染进程只加载本地文件；拒绝一切权限申请（摄像头、通知、定位等）
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith('file://') && !details.url.startsWith('devtools://') });
  });
}

// 旧版本（RelayUsage）的数据目录迁移过来，改名后不用重新登录
async function migrateLegacyData() {
  const current = app.getPath('userData');
  const legacy = path.join(path.dirname(current), 'RelayUsage');
  for (const file of ['credentials.bin', 'usage-cache.json', 'settings.json']) {
    try {
      await fs.copyFile(path.join(legacy, file), path.join(current, file), fs.constants.COPYFILE_EXCL);
    } catch { /* 旧文件不存在或已迁移 */ }
  }
}

app.whenReady().then(async () => {
  app.setAppUserModelId('local.capyledger');
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await migrateLegacyData();
  await loadSettings();
  settings.maximizedFrom = null;
  lockDownSession();
  client = new RelayClient(app.getPath('userData'));
  registerIpc();
  createWindow();
  createTray();
});

app.on('window-all-closed', () => { /* 常驻托盘 */ });
app.on('before-quit', () => { quitting = true; });
