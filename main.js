const { app, BrowserWindow, ipcMain, globalShortcut, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-domain-blocking-for-3d-apis');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
// `ignore-gpu-blocklist` makes ANGLE re-log a failed EGL device-attribute probe at
// ERROR severity ~28 times/second on Intel/Haswell. Keep the switch (measured: GPU helper
// ~13% with it vs ~20% without) and cap the stream it opens instead.
app.commandLine.appendSwitch('log-level', '3');

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

// Screen-edge roaming. The pet walks along its current row of the work area;
// `speed` is px/s and stays slow enough that the four-legged gait reads as a
// stroll rather than a dash.
const ROAM = {
  minDelay: 6000,
  maxDelay: 14000,
  minDistance: 110,
  speed: 78,
  // The walk is time-based, so a 30 Hz window move matches the 30 fps gait and
  // halves the per-frame cost of resizing an always-on-top transparent window.
  tickMs: 33
};

let roamEnabled = false;
let roamTimer = null;
let walkTimer = null;
let roaming = false;
let uiBusy = false;
let lastWalkFrameAt = 0;

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

function stopWalk() {
  if (walkTimer) {
    clearInterval(walkTimer);
    walkTimer = null;
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
    roamWalk();
  }, delay);
}

// A renderer cannot tell a hidden window from a merely unfocused one, and macOS
// fires no 'hide'/'show' event for this frameless transparent window, so the code
// that actually moves the window in and out is what tells the pet to park or wake.
function sendVisibility(visible) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('window-visibility', visible);
  }
}

function showPetWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  sendVisibility(true);
  scheduleRoam(2000);
}

function hidePetWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  clearRoamTimer();
  stopWalk();
  mainWindow.hide();
  sendVisibility(false);
}

function minimizePetWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  clearRoamTimer();
  stopWalk();
  mainWindow.minimize();
  sendVisibility(false);
}

function setRoamEnabled(enabled) {
  roamEnabled = !!enabled;
  writeAppSettings({ roamEnabled });
  if (trayMenu) {
    const item = trayMenu.getMenuItemById('roam-toggle');
    if (item) item.checked = roamEnabled;
  }
  if (!roamEnabled) {
    // Stop any walk that is still scheduled; one already in progress finishes.
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

  // A walking pet stays on the ground it is on: it only changes x, so it never
  // has to leave the floor to reach the next spot.
  const y = Math.min(Math.max(bounds.y, workArea.y), maxY);
  const x = randomBetween(workArea.x, maxX);
  if (Math.abs(x - bounds.x) < ROAM.minDistance) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

function roamWalk() {
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
  // per move when each step re-pins whatever size it just reported.
  const walkWidth = WINDOW_SIZES.pet.width;
  const walkHeight = WINDOW_SIZES.pet.height;
  const dx = target.x - startX;
  // Walking keeps the window exactly level; only x changes. ROAM.speed is the
  // cruise speed, so crossing a wide display legitimately takes tens of seconds.
  const duration = Math.round(Math.min(24000, Math.max(900, (Math.abs(dx) / ROAM.speed) * 1000)));
  const ramp = 0.15;
  const cruise = 1 / (1 - ramp);
  const startedAt = Date.now();

  roaming = true;
  mainWindow.webContents.send('roam-state', dx > 0 ? 'walk-right' : 'walk-left');

  walkTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      stopWalk();
      return;
    }
    const t = Math.min(1, (Date.now() - startedAt) / duration);
    // Trapezoidal speed profile: the pet eases into and out of its stride but
    // holds one steady pace between, which is what a walk looks like.
    let eased;
    if (t < ramp) eased = (cruise * t * t) / (2 * ramp);
    else if (t > 1 - ramp) {
      const u = 1 - t;
      eased = 1 - (cruise * u * u) / (2 * ramp);
    } else eased = cruise * (ramp / 2 + (t - ramp));
    const x = Math.round(startX + dx * eased);
    if (!Number.isFinite(x)) {
      logCrash(`bad walk frame x=${x} target=${JSON.stringify(target)} start=${startX},${startY} d=${dx} dur=${duration} t=${t}`);
      stopWalk();
      scheduleRoam();
      return;
    }
    lastWalkFrameAt = Date.now();
    // setPosition on Windows grows the window a little on every call at this
    // DPI; pinning the size keeps a walk from turning the pet into a balloon.
    mainWindow.setBounds({ x, y: startY, width: walkWidth, height: walkHeight }, false);

    if (t >= 1) {
      clearInterval(walkTimer);
      walkTimer = null;
      roaming = false;
      mainWindow.webContents.send('roam-state', 'idle');
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
      spellcheck: false,
      // macOS marks a frameless transparent always-on-top window as backgrounded
      // as soon as it loses focus. Throttling then freezes every animation frame
      // while the pet is still on screen, so the window is left showing a stale
      // (often black) surface until it repaints — a flicker that looks random.
      backgroundThrottling: false
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
    stopWalk();
    mainWindow = null;
  });

  let savePosTimer = null;
  const scheduleSavePosition = () => {
    // Hops move the window too; don't treat those frames as a user drag.
    // The final setPosition's 'move' can arrive just after landing, so also
    // ignore anything right after the last hop frame.
    if (roaming || Date.now() - lastWalkFrameAt < 150) return;
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
    // A freshly loaded renderer starts its animation loop; a hidden window must
    // be told to park it again instead of drawing off screen.
    sendVisibility(mainWindow.isVisible());
    scheduleRoam(9000);
  });

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
      stopWalk();
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
    minimizePetWindow();
  });

  // Clicking close in Pet/Chat window hides to background/tray instead of destroying
  ipcMain.on('close-app', () => {
    hidePetWindow();
  });

  // The settings modal covers the pet window; pausing hops keeps it still
  // while the user is changing options.
  ipcMain.on('set-ui-busy', (event, busy) => {
    uiBusy = !!busy;
    if (uiBusy) clearRoamTimer();
    else scheduleRoam(2500);
  });

  // Pointer activity only reaches the pet while its window is on screen, so this
  // doubles as the safety net that re-wakes a loop parked by a missed show.
  ipcMain.on('pet-activity', () => {
    sendVisibility(true);
    scheduleRoam(randomBetween(5000, 9000));
  });

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
    showPetWindow();
    mainWindow.focus();
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
          hidePetWindow();
        } else {
          showPetWindow();
          mainWindow.focus();
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
      label: '到處走 (螢幕邊緣)',
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
        showPetWindow();
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
      showPetWindow();
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
      hidePetWindow();
    } else {
      showPetWindow();
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
  stopWalk();
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
