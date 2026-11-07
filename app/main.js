// Kiln desktop app: hosts the dashboard in a native window and keeps mining from the tray.
'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, shell, screen, dialog } = require('electron');
const path = require('path');
const { execFile } = require('child_process');

// XMRig, its download and Kiln's data live in one folder:
// - built from the repo (<miner>\dist\Kiln-win32-x64\Kiln.exe): the repo folder
// - downloaded from a release and unzipped anywhere: %LOCALAPPDATA%\Kiln
function rootFolder() {
  if (!app.isPackaged) return path.resolve(__dirname, '..');
  const exeDir = path.dirname(process.execPath);
  if (path.basename(path.dirname(exeDir)).toLowerCase() === 'dist') return path.resolve(exeDir, '..', '..');
  return path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Kiln');
}
const ROOT = rootFolder();
process.env.KILN_ROOT = ROOT;

const ICON = path.join(__dirname, 'assets', 'icon.png');
const TRAY_ICON = path.join(__dirname, 'assets', 'tray.png');
const startHidden = process.argv.includes('--hidden');

app.setAppUserModelId('Kiln');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(boot);
}

let core = null;   // server.js
let win = null;
let tray = null;
let url = null;
let quitting = false;
let toldAboutTray = false;

async function boot() {
  core = require('./server.js');
  try {
    url = await core.ready;
  } catch (err) {
    dialog.showErrorBox('Kiln could not start', `Port 4545 is in use. Is another copy of Kiln (or Kiln.cmd) already running?\n\n${err.message}`);
    app.exit(1);
    return;
  }
  createTray();
  createWindow();
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1480, width - 40),
    height: Math.min(980, height - 40),
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Kiln',
    icon: ICON,
    backgroundColor: '#f1f2f2',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f1f2f2', symbolColor: '#111413', height: 63 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.loadURL(url + '/?app=1');
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });

  // Links (Solscan etc.) open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https:\/\//.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(url)) { e.preventDefault(); if (/^https:\/\//.test(target)) shell.openExternal(target); }
  });

  // Closing the window keeps Kiln running in the tray.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!toldAboutTray && Notification.isSupported()) {
      toldAboutTray = true;
      new Notification({
        title: 'Kiln is still running',
        body: core.isMining() ? 'Mining continues in the background. Right-click the tray icon to quit.' : 'Kiln is in the tray. Right-click the icon to quit.',
        icon: ICON,
      }).show();
    }
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
  tray.on('click', showWindow);
  refreshTray();
  setInterval(refreshTray, 3000);
}

function refreshTray() {
  if (!tray) return;
  const st = core.status();
  const mining = core.isMining();
  const hr = st.hashrate ? `${Math.round(st.hashrate).toLocaleString('en-US')} H/s` : '';
  tray.setToolTip(mining ? `Kiln — mining${hr ? ' · ' + hr : ''}` : 'Kiln — idle');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Kiln', click: showWindow },
    { type: 'separator' },
    mining
      ? { label: 'Stop mining', click: () => core.stop().then(refreshTray) }
      : { label: 'Start mining', click: () => { core.start(); setTimeout(refreshTray, 500); } },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
    },
    { label: st.elevated ? 'Running as administrator' : 'Restart as administrator', enabled: !st.elevated, click: relaunchElevated },
    { type: 'separator' },
    { label: 'Quit Kiln', click: quit },
  ]));
}

// Admin rights let XMRig apply the MSR tweak and grant itself huge pages.
async function relaunchElevated() {
  const wasMining = core.isMining();
  await core.stop();
  app.releaseSingleInstanceLock();
  const exe = process.execPath.replace(/'/g, "''");
  const args = (app.isPackaged ? [] : [app.getAppPath()]).concat(wasMining ? ['--mine'] : []);
  const argList = args.length ? ` -ArgumentList ${args.map((a) => `'"${a.replace(/'/g, "''")}"'`).join(',')}` : '';
  execFile('powershell', ['-NoProfile', '-Command', `Start-Process -FilePath '${exe}'${argList} -Verb RunAs`], { windowsHide: true }, async (err) => {
    if (err) {
      // UAC was declined: carry on as before.
      app.requestSingleInstanceLock();
      if (wasMining) core.start();
      return;
    }
    quit();
  });
}

async function quit() {
  quitting = true;
  if (tray) tray.destroy();
  await core.shutdown().catch(() => {});
  app.exit(0);
}

ipcMain.handle('kiln:elevate', () => relaunchElevated());
ipcMain.handle('kiln:hide', () => win && win.hide());

app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => { quitting = true; });

// Started by "Restart as administrator" while mining: resume straight away.
if (process.argv.includes('--mine')) {
  app.whenReady().then(() => setTimeout(() => core && core.start(), 1500));
}
