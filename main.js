const { app, BrowserWindow, ipcMain, globalShortcut, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// Enable transparent visuals for Linux compatibility
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
  app.disableHardwareAcceleration();
}

let mainWindow = null;
let tray = null;
let currentMode = 'pet'; // 'pet' or 'chat'

// Window dimensions for each mode
const WINDOW_SIZES = {
  pet: { width: 240, height: 290 },
  chat: { width: 460, height: 680 }
};

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

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Ensure window stays on top across all workspaces (especially macOS)
  if (process.platform === 'darwin') {
    mainWindow.setAlwaysOnTop(true, 'floating', 1);
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } else {
    mainWindow.setAlwaysOnTop(true);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  let savePosTimer = null;
  const scheduleSavePosition = () => {
    if (currentMode !== 'pet') return;
    clearTimeout(savePosTimer);
    savePosTimer = setTimeout(savePetPosition, 500);
  };
  // 'move' fires during a drag (and for programmatic moves); 'moved' is not
  // emitted for native moves that never send WM_EXITSIZEMOVE.
  mainWindow.on('move', scheduleSavePosition);
  mainWindow.on('moved', scheduleSavePosition);

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
    if (mainWindow) mainWindow.minimize();
  });

  // Clicking close in Pet/Chat window hides to background/tray instead of destroying
  ipcMain.on('close-app', () => {
    if (mainWindow) mainWindow.hide();
  });

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
  }
}

function createTray() {
  // Simple generated 16x16 icon for tray
  const iconSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="14" fill="#6366f1"/>
      <circle cx="11" cy="13" r="2.5" fill="#ffffff"/>
      <circle cx="21" cy="13" r="2.5" fill="#ffffff"/>
      <path d="M 12 20 Q 16 24 20 20" stroke="#ffffff" stroke-width="2" fill="none" stroke-linecap="round"/>
    </svg>
  `;
  const iconBuffer = Buffer.from(iconSvg);
  const icon = nativeImage.createFromBuffer(iconBuffer).resize({ width: 18, height: 18 });

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
          mainWindow.hide();
        } else {
          mainWindow.show();
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
