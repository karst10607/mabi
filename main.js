const { app, BrowserWindow, ipcMain, globalShortcut, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-domain-blocking-for-3d-apis');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

// Enable transparent visuals for Linux compatibility
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
  app.disableHardwareAcceleration();
}

let mainWindow = null;
let tray = null;
let trayMenu = null;
let currentMode = 'pet'; // 'pet' or 'chat'

// Window dimensions for each mode
const WINDOW_SIZES = {
  pet: { width: 240, height: 290 },
  chat: { width: 460, height: 680 }
};

// Screen-edge roaming. The pet hops around the current display's work area
// instead of walking; the seated rig has no walk cycle.
const ROAM = {
  minDelay: 6000,
  maxDelay: 14000,
  minDistance: 110,
  tickMs: 16
};

let roamEnabled = false;
let roamTimer = null;
let hopTimer = null;
let roaming = false;
let uiBusy = false;
let lastHopFrameAt = 0;

const APP_SETTINGS_FILE = () => path.join(app.getPath('userData'), 'app-settings.json');

function readAppSettings() {
  try {
    return JSON.parse(fs.readFileSync(APP_SETTINGS_FILE(), 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeAppSettings(patch) {
  try {
    fs.mkdirSync(path.dirname(APP_SETTINGS_FILE()), { recursive: true });
    fs.writeFileSync(APP_SETTINGS_FILE(), JSON.stringify({ ...readAppSettings(), ...patch }, null, 2));
  } catch (err) {
    console.warn('Could not save app settings:', err.message);
  }
}

function defaultPetPosition() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  return {
    x: Math.max(20, width - WINDOW_SIZES.pet.width - 40),
    y: Math.max(20, height - WINDOW_SIZES.pet.height - 30)
  };
}

function savedPetPosition() {
  const pos = readAppSettings().petPosition;
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return null;
  const visible = screen.getAllDisplays().some(({ workArea }) =>
    pos.x + WINDOW_SIZES.pet.width > workArea.x + 40 &&
    pos.x < workArea.x + workArea.width - 40 &&
    pos.y + WINDOW_SIZES.pet.height > workArea.y + 40 &&
    pos.y < workArea.y + workArea.height - 40
  );
  return visible ? pos : null;
}

function savePetPosition() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [x, y] = mainWindow.getPosition();
  writeAppSettings({ petPosition: { x, y } });
}

function loginItemArgs() {
  return app.isPackaged ? [] : [app.getAppPath()];
}

function loginItemPath() {
  // electron-builder's portable exe runs from a temp extraction dir that is
  // deleted on exit; autostart must point at the portable file itself.
  if (process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_FILE) {
    return process.env.PORTABLE_EXECUTABLE_FILE;
  }
  if (process.platform === 'linux' && process.env.APPIMAGE) {
    return process.env.APPIMAGE;
  }
  return process.execPath;
}

function linuxAutostartFile() {
  return path.join(app.getPath('home'), '.config', 'autostart', 'aurapet.desktop');
}

function autostartSupported() {
  return process.platform !== 'darwin' || app.isPackaged;
}

function isAutostartEnabled() {
  try {
    if (process.platform === 'linux') return fs.existsSync(linuxAutostartFile());
    const opts = process.platform === 'win32'
      ? { path: loginItemPath(), args: loginItemArgs() }
      : {};
    return app.getLoginItemSettings(opts).openAtLogin;
  } catch {
    return false;
  }
}

function setAutostart(enabled) {
  if (process.platform === 'linux') {
    const file = linuxAutostartFile();
    if (!enabled) {
      fs.rmSync(file, { force: true });
      return;
    }
    const exec = loginItemPath();
    const args = process.env.APPIMAGE ? '' : loginItemArgs().map((a) => `"${a}"`).join(' ');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      '[Desktop Entry]',
      'Type=Application',
      'Name=AuraPet',
      `Exec="${exec}"${args ? ` ${args}` : ''}`,
      'X-GNOME-Autostart-enabled=true',
      'Terminal=false',
      ''
    ].join('\n'));
    return;
  }
  const opts = process.platform === 'win32'
    ? { path: loginItemPath(), args: loginItemArgs() }
    : {};
  app.setLoginItemSettings({ openAtLogin: enabled, ...opts });
}

function logCrash(line) {
  try {
    const file = path.join(app.getPath('userData'), 'crash.log');
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* logging must never take the app down */
  }
}

let rendererReloads = [];

function recoverRenderer(reason) {
  const now = Date.now();
  rendererReloads = rendererReloads.filter((t) => now - t < 60000);
  if (rendererReloads.length >= 5) {
    logCrash(`renderer recovery suppressed (too many reloads): ${reason}`);
    return;
  }
  rendererReloads.push(now);
  logCrash(`recovering renderer: ${reason}`);
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
  }, 600);
}

const randomBetween = (min, max) => min + Math.random() * (max - min);

function clearRoamTimer() {
  if (roamTimer) {
    clearTimeout(roamTimer);
    roamTimer = null;
  }
}

function stopHop() {
  if (hopTimer) {
    clearInterval(hopTimer);
    hopTimer = null;
  }
  if (!roaming) return;
  roaming = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('roam-state', 'idle');
  }
}

function scheduleRoam(delay = randomBetween(ROAM.minDelay, ROAM.maxDelay)) {
  clearRoamTimer();
  if (!roamEnabled || uiBusy || currentMode !== 'pet') return;
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;
  roamTimer = setTimeout(() => {
    roamTimer = null;
    roamHop();
  }, delay);
}

function setRoamEnabled(enabled) {
  roamEnabled = !!enabled;
  writeAppSettings({ roamEnabled });
  if (trayMenu) {
    const item = trayMenu.getMenuItemById('roam-toggle');
    if (item) item.checked = roamEnabled;
  }
  if (!roamEnabled) {
    // Let a hop that is already airborne land; just don't schedule another.
    clearRoamTimer();
    return;
  }
  scheduleRoam(1800);
}

function pickRoamTarget() {
  const bounds = mainWindow.getBounds();
  const { workArea } = screen.getDisplayMatching(bounds);
  const maxX = workArea.x + workArea.width - bounds.width;
  const maxY = workArea.y + workArea.height - bounds.height;
  if (maxX < workArea.x || maxY < workArea.y) return null;

  // Mostly the taskbar edge, with occasional side/top perches and free jumps.
  const roll = Math.random();
  let x;
  let y;
  if (roll < 0.5) {
    x = randomBetween(workArea.x, maxX);
    y = maxY;
  } else if (roll < 0.7) {
    x = Math.random() < 0.5 ? workArea.x : maxX;
    y = randomBetween(workArea.y, maxY);
  } else if (roll < 0.82) {
    x = randomBetween(workArea.x, maxX);
    y = workArea.y;
  } else {
    x = randomBetween(workArea.x, maxX);
    y = randomBetween(workArea.y, maxY);
  }

  const target = { x: Math.round(x), y: Math.round(y) };
  if (Math.hypot(target.x - bounds.x, target.y - bounds.y) < ROAM.minDistance) return null;
  return target;
}

function roamHop() {
  if (!roamEnabled || uiBusy || currentMode !== 'pet' || roaming) return;
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;

  const target = pickRoamTarget();
  if (!target) {
    scheduleRoam(1500);
    return;
  }

  const startBounds = mainWindow.getBounds();
  const startX = startBounds.x;
  const startY = startBounds.y;
  // Pin the design size rather than the current bounds: Windows adds ~1 DIP
  // per hop when each hop re-pins whatever size it just reported.
  const hopWidth = WINDOW_SIZES.pet.width;
  const hopHeight = WINDOW_SIZES.pet.height;
  const dx = target.x - startX;
  const dy = target.y - startY;
  const distance = Math.hypot(dx, dy);
  const duration = Math.round(Math.min(1050, Math.max(460, 380 + distance * 0.55)));
  const lift = Math.round(22 + Math.min(70, distance * 0.16));
  const { workArea } = screen.getDisplayMatching(startBounds);
  const startedAt = Date.now();
  let announcedAir = false;

  roaming = true;
  mainWindow.webContents.send('roam-state', 'takeoff');

  hopTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      stopHop();
      return;
    }
    const t = Math.min(1, (Date.now() - startedAt) / duration);
    if (!announcedAir && t > 0.2) {
      announcedAir = true;
      mainWindow.webContents.send('roam-state', 'air');
    }
    const eased = t * t * (3 - 2 * t);
    const x = Math.round(startX + dx * eased);
    // Clamp the arc to the work area: a hop along the top edge would otherwise
    // lift the whole window (and the pet) above the screen.
    const y = Math.max(workArea.y, Math.round(startY + dy * eased - Math.sin(Math.PI * t) * lift));
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      logCrash(`bad hop frame x=${x} y=${y} target=${JSON.stringify(target)} start=${startX},${startY} d=${distance} dur=${duration} lift=${lift} t=${t}`);
      stopHop();
      scheduleRoam();
      return;
    }
    lastHopFrameAt = Date.now();
    // setPosition on Windows grows the window a little on every call at this
    // DPI; pinning the size keeps a hop from turning the pet into a balloon.
    mainWindow.setBounds({ x, y, width: hopWidth, height: hopHeight }, false);

    if (t >= 1) {
      clearInterval(hopTimer);
      hopTimer = null;
      roaming = false;
      mainWindow.webContents.send('roam-state', 'land');
      savePetPosition();
      scheduleRoam();
    }
  }, ROAM.tickMs);
}

process.on('uncaughtException', (err) => {
  logCrash(`uncaughtException: ${err?.stack || err}`);
  let recent = false;
  try {
    const marker = path.join(app.getPath('userData'), 'relaunch-guard');
    recent = Date.now() - Number(fs.readFileSync(marker, 'utf8')) < 20000;
    if (!recent) fs.writeFileSync(marker, String(Date.now()));
  } catch {
    /* if this fails, still relaunch once */
  }
  if (!recent) app.relaunch();
  app.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logCrash(`unhandledRejection: ${reason?.stack || reason}`);
});

function createMainWindow() {
  // Restore the pet where the user left it, falling back to the bottom-right
  // corner when it would land off-screen (monitor unplugged, DPI change).
  const pos = savedPetPosition() || defaultPetPosition();

  mainWindow = new BrowserWindow({
    width: WINDOW_SIZES.pet.width,
    height: WINDOW_SIZES.pet.height,
    x: pos.x,
    y: pos.y,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      spellcheck: false
    }
  });

  // Windows inflates a freshly created frameless window by a few DIP at this
  // scale; normalizing once keeps the size steady for every later hop.
  mainWindow.setBounds({
    x: pos.x,
    y: pos.y,
    width: WINDOW_SIZES.pet.width,
    height: WINDOW_SIZES.pet.height
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Ensure window stays on top across all workspaces (especially macOS)
  if (process.platform === 'darwin') {
    mainWindow.setAlwaysOnTop(true, 'floating', 1);
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } else {
    mainWindow.setAlwaysOnTop(true);
  }

  mainWindow.on('closed', () => {
    clearRoamTimer();
    stopHop();
    mainWindow = null;
  });

  let savePosTimer = null;
  const scheduleSavePosition = () => {
    // Hops move the window too; don't treat those frames as a user drag.
    // The final setPosition's 'move' can arrive just after landing, so also
    // ignore anything right after the last hop frame.
    if (roaming || Date.now() - lastHopFrameAt < 150) return;
    clearRoamTimer();
    if (currentMode === 'pet') scheduleRoam(randomBetween(5000, 9000));
    if (currentMode !== 'pet') return;
    clearTimeout(savePosTimer);
    savePosTimer = setTimeout(savePetPosition, 500);
  };
  // 'move' fires during a drag (and for programmatic moves); 'moved' is not
  // emitted for native moves that never send WM_EXITSIZEMOVE.
  mainWindow.on('move', scheduleSavePosition);
  mainWindow.on('moved', scheduleSavePosition);

  mainWindow.webContents.on('did-finish-load', () => {
    // A renderer reload may have left the settings modal state behind.
    uiBusy = false;
    scheduleRoam(9000);
  });

  mainWindow.on('hide', () => {
    clearRoamTimer();
    stopHop();
  });
  mainWindow.on('minimize', () => {
    clearRoamTimer();
    stopHop();
  });
  mainWindow.on('show', () => scheduleRoam(2000));
  mainWindow.on('restore', () => scheduleRoam(2000));

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    if (details.reason === 'clean-exit') return;
    recoverRenderer(`render-process-gone (${details.reason})`);
  });

  mainWindow.on('unresponsive', () => recoverRenderer('unresponsive'));
}

function registerIpcHandlers() {
  // Handle mode switches and window resizing smoothly
  ipcMain.on('switch-mode', (event, mode) => {
    if (!mainWindow) return;
    currentMode = mode;
    if (mode === 'pet') {
      scheduleRoam(2500);
    } else {
      clearRoamTimer();
      stopHop();
    }
    const targetSize = WINDOW_SIZES[mode] || WINDOW_SIZES.pet;
    const [curX, curY] = mainWindow.getPosition();
    const [curW, curH] = mainWindow.getSize();

    // Anchor bottom-right position when expanding to chat mode
    let newX = curX - (targetSize.width - curW);
    let newY = curY - (targetSize.height - curH);

    // Keep within screen bounds
    const display = screen.getDisplayNearestPoint({ x: curX, y: curY });
    const { x: boundX, y: boundY, width: boundW, height: boundH } = display.workArea;

    if (newX < boundX + 10) newX = boundX + 10;
    if (newX + targetSize.width > boundX + boundW - 10) newX = boundX + boundW - targetSize.width - 10;
    if (newY < boundY + 10) newY = boundY + 10;
    if (newY + targetSize.height > boundY + boundH - 10) newY = boundY + boundH - targetSize.height - 10;

    mainWindow.setBounds({
      x: Math.round(newX),
      y: Math.round(newY),
      width: targetSize.width,
      height: targetSize.height
    });

    event.sender.send('mode-changed', mode);
  });

  ipcMain.on('set-always-on-top', (event, flag) => {
    if (mainWindow) {
      if (process.platform === 'darwin') {
        mainWindow.setAlwaysOnTop(flag, 'floating', 1);
      } else {
        mainWindow.setAlwaysOnTop(flag);
      }
    }
  });

  ipcMain.on('minimize-app', () => {
    clearRoamTimer();
    if (mainWindow) mainWindow.minimize();
  });

  // Clicking close in Pet/Chat window hides to background/tray instead of destroying
  ipcMain.on('close-app', () => {
    clearRoamTimer();
    if (mainWindow) mainWindow.hide();
  });

  // The settings modal covers the pet window; pausing hops keeps it still
  // while the user is changing options.
  ipcMain.on('set-ui-busy', (event, busy) => {
    uiBusy = !!busy;
    if (uiBusy) clearRoamTimer();
    else scheduleRoam(2500);
  });

  ipcMain.on('pet-activity', () => scheduleRoam(randomBetween(5000, 9000)));

  ipcMain.handle('get-roam-enabled', () => roamEnabled);
  ipcMain.on('set-roam-enabled', (event, enabled) => setRoamEnabled(enabled));

  ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.setIgnoreMouseEvents(ignore, options);
    }
  });
}

function showOrRestoreWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
    scheduleRoam(2000);
  }
}

function createTrayImage() {
  const asset = (name) => path.join(__dirname, 'assets', name);
  if (process.platform === 'darwin') {
    const image = nativeImage.createEmpty();
    image.addRepresentation({
      scaleFactor: 1,
      width: 18,
      height: 18,
      buffer: fs.readFileSync(asset('trayTemplate.png'))
    });
    image.addRepresentation({
      scaleFactor: 2,
      width: 36,
      height: 36,
      buffer: fs.readFileSync(asset('trayTemplate@2x.png'))
    });
    image.setTemplateImage(true);
    return image;
  }
  return nativeImage
    .createFromBuffer(fs.readFileSync(asset('tray.png')))
    .resize({ width: 18, height: 18 });
}

function createTray() {
  let icon;
  try {
    icon = createTrayImage();
  } catch (err) {
    console.warn('Tray icon asset load failed:', err.message);
    return;
  }
  if (icon.isEmpty()) {
    console.warn('Tray icon is empty; skipping tray creation');
    return;
  }

  try {
    tray = new Tray(icon);
  } catch (err) {
    console.warn('Tray icon initialization note:', err.message);
    return;
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'AuraPet 桌面寵物',
      enabled: false
    },
    { type: 'separator' },
    {
      label: '切換寵物/對話形態',
      accelerator: 'Option+Space',
      click: () => {
        showOrRestoreWindow();
        const nextMode = currentMode === 'pet' ? 'chat' : 'pet';
        mainWindow.webContents.send('toggle-mode-request', nextMode);
      }
    },
    {
      label: '顯示 / 隱藏',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          createMainWindow();
          return;
        }
        if (mainWindow.isVisible()) {
          clearRoamTimer();
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
          scheduleRoam(2000);
        }
      }
    },
    {
      label: '置頂顯示',
      type: 'checkbox',
      checked: true,
      click: (item) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setAlwaysOnTop(item.checked);
        }
      }
    },
    {
      id: 'roam-toggle',
      label: '到處跳 (螢幕邊緣)',
      type: 'checkbox',
      checked: roamEnabled,
      click: (item) => setRoamEnabled(item.checked)
    },
    {
      label: '開機自動啟動',
      type: 'checkbox',
      checked: isAutostartEnabled(),
      enabled: autostartSupported(),
      click: (item) => {
        try {
          setAutostart(item.checked);
        } catch (err) {
          console.warn('Could not change autostart:', err.message);
          item.checked = isAutostartEnabled();
        }
      }
    },
    { type: 'separator' },
    {
      label: '撫摸寵物 ❤️',
      click: () => {
        showOrRestoreWindow();
        mainWindow.webContents.send('pet-interaction', 'pat');
      }
    },
    {
      label: '餵食美味小點心 🍣',
      click: () => {
        showOrRestoreWindow();
        mainWindow.webContents.send('pet-interaction', 'feed');
      }
    },
    { type: 'separator' },
    {
      label: '徹底退出 AuraPet (結束後台)',
      click: () => {
        app.quit();
      }
    }
  ]);

  trayMenu = contextMenu;
  tray.setToolTip('AuraPet - AI 桌面夥伴');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow();
    } else {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
        scheduleRoam(2000);
      }
    }
  });
}

function registerShortcuts() {
  // Option/Alt+Space: Toggle between Pet Mode and Chat Mode
  const shortcutKey = 'Alt+Space';
  globalShortcut.register(shortcutKey, () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow();
      return;
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
    }
    const nextMode = currentMode === 'pet' ? 'chat' : 'pet';
    mainWindow.webContents.send('toggle-mode-request', nextMode);
  });

  // Cmd/Ctrl+Shift+P: Quick Focus / Summon or Hide
  globalShortcut.register('CommandOrControl+Shift+P', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow();
      return;
    }
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  // A second pet window would overlap the first and read as a ghost cat
  // peeking out whenever the front one breathes.
  app.quit();
} else {
  app.on('second-instance', showOrRestoreWindow);

  app.whenReady().then(() => {
    roamEnabled = readAppSettings().roamEnabled === true;
    registerIpcHandlers();
    createMainWindow();
    createTray();
    registerShortcuts();

    app.on('activate', () => {
      showOrRestoreWindow();
    });
  });
}

app.on('before-quit', () => {
  clearRoamTimer();
  stopHop();
  if (currentMode === 'pet') savePetPosition();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
