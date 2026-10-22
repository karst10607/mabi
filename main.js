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

function createMainWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  // Initial position: Bottom-right corner of screen
  const initWidth = WINDOW_SIZES.pet.width;
  const initHeight = WINDOW_SIZES.pet.height;
  const posX = Math.max(20, screenWidth - initWidth - 40);
  const posY = Math.max(20, screenHeight - initHeight - 30);

  mainWindow = new BrowserWindow({
    width: initWidth,
    height: initHeight,
    x: posX,
    y: posY,
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

app.whenReady().then(() => {
  createMainWindow();
  createTray();
  registerShortcuts();

  app.on('activate', () => {
    showOrRestoreWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
