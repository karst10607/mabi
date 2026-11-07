/**
 * AuraPet preload - bridge shim.
 *
 * Keeps the `window.electronAPI` surface the renderer already uses, but the
 * transport is the daemon WebSocket (protocol v1). Window capability still
 * lives in the Electron main process: window.apply / window.minimize / window.close
 * are forwarded over IPC, and main reports window.state / roam.state back here.
 */
const { contextBridge, ipcRenderer } = require('electron');

const bridgeConfig = ipcRenderer.sendSync('bridge-config');
const listeners = {
  modeChanged: [],
  toggleModeRequest: [],
  petInteraction: [],
  roamState: [],
  windowVisibility: []
};

let socket = null;
let connected = false;
let helloId = null;
let nextId = 1;
let reconnectDelay = 1000;
let lastVisibility = null;
let roamEnabled = false;
let knownMode = 'pet';
let pendingModeToggle = false;

const pending = new Map();
const queue = [];

function dispatch(name, value) {
  for (const callback of listeners[name]) {
    try {
      callback(value);
    } catch (err) {
      console.error(`electronAPI listener (${name}) failed:`, err);
    }
  }
}

function rawSend(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !connected) return false;
  socket.send(JSON.stringify({ v: 1, ...message }));
  return true;
}

function fire(type, payload = {}) {
  const message = { id: nextId++, t: type, ...payload };
  if (!rawSend(message)) {
    if (queue.length < 50) queue.push(message);
  }
}

function request(type, payload = {}) {
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: { code: 'timeout', message: `${type} timed out` } });
    }, 5000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    const message = { id, t: type, ...payload };
    if (!rawSend(message) && queue.length < 50) queue.push(message);
  });
}

function flushQueue() {
  const queued = queue.splice(0);
  for (const message of queued) rawSend(message);
}

// One-time hand-off of the v1.5.2 renderer localStorage into the daemon config
// so the browser UI (issue #12) starts with the same keys without changing the
// Electron renderer, which keeps reading localStorage.
function migrateSettings() {
  const marker = 'aurapet_ui_migrated';
  try {
    if (localStorage.getItem(marker) === '1') return;
  } catch {
    return;
  }
  const defaults = {
    aurapet_skin: 'cat2d',
    aurapet_name: '條碼',
    aurapet_user_title: '主人',
    aurapet_sound: 'true',
    aurapet_speech: 'true',
    aurapet_affection: '40',
    aurapet_energy: '40',
    aurapet_posture: 'sit',
    aurapet_hidden_skins: '[]',
    aurapet_custom_frame: 'aura-contour',
    aurapet_pet_species: '',
    aurapet_pet_habits: '',
    aurapet_ai_provider: 'builtin',
    aurapet_api_key: '',
    aurapet_base_url: '',
    aurapet_model_name: ''
  };
  const patch = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const current = localStorage.getItem(key);
    patch[key] = current === null ? fallback : current;
  }
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && key.startsWith('aurapet_') && key !== marker && !(key in patch)) {
      patch[key] = localStorage.getItem(key);
    }
  }
  request('settings.set', { patch }).catch(() => {});
  localStorage.setItem(marker, '1');
}

function handleReply(message) {
  if (message.id === helloId) {
    helloId = null;
    if (message.ok) {
      connected = true;
      reconnectDelay = 1000;
      flushQueue();
      migrateSettings();
    } else {
      socket.close();
    }
    return;
  }
  const resolve = pending.get(message.id);
  if (!resolve) return;
  pending.delete(message.id);
  resolve(message);
}

function applyWindow(patch) {
  ipcRenderer.send('window-apply', patch);
}

function dispatchVisibility(visible) {
  if (visible === lastVisibility) return;
  lastVisibility = visible;
  dispatch('windowVisibility', visible);
}

function handleEvent(message) {
  switch (message.t) {
    case 'state.sync': {
      roamEnabled = Boolean(message.roamEnabled);
      if (message.mode === 'pet' || message.mode === 'chat') knownMode = message.mode;
      const patch = { mode: message.mode };
      if (typeof message.alwaysOnTop === 'boolean') patch.alwaysOnTop = message.alwaysOnTop;
      if (typeof message.clickThrough === 'boolean') patch.clickThrough = message.clickThrough;
      applyWindow(patch);
      dispatch('toggleModeRequest', knownMode);
      // The body owns the real window; ask main for a fresh snapshot instead of
      // trusting the brain's last-known visibility.
      ipcRenderer.send('bridge-state-request');
      return;
    }
    case 'mode.set':
      knownMode = message.mode;
      applyWindow({ mode: message.mode });
      fire('mode.changed', { mode: message.mode });
      if (pendingModeToggle) {
        pendingModeToggle = false;
        dispatch('toggleModeRequest', message.mode);
      } else {
        dispatch('modeChanged', message.mode);
      }
      return;
    case 'window.apply':
      applyWindow(message);
      return;
    case 'window.minimize':
      ipcRenderer.send('window-command', 'minimize');
      return;
    case 'window.close':
      ipcRenderer.send('window-command', 'close');
      return;
    case 'roam.command':
      ipcRenderer.send('roam-exec', { action: message.action });
      return;
    case 'roam.enabled':
      roamEnabled = Boolean(message.enabled);
      return;
    case 'react':
      dispatch('petInteraction', message.kind);
      return;
    case 'ping':
      if (message.id != null) {
        rawSend({ id: message.id, ok: true, ts: message.ts });
      } else {
        fire('pong', { ts: message.ts });
      }
      return;
    default:
      // Unknown events are ignored (forward compatible).
      return;
  }
}

function handleMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (!message || message.v !== 1) return;
  if (message.id != null && 'ok' in message) {
    handleReply(message);
    return;
  }
  if (typeof message.t === 'string') handleEvent(message);
}

function scheduleReconnect() {
  setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(30000, reconnectDelay * 2);
}

function connect() {
  try {
    socket = new WebSocket(`ws://127.0.0.1:${bridgeConfig.port}`);
  } catch {
    scheduleReconnect();
    return;
  }
  socket.addEventListener('open', () => {
    helloId = nextId++;
    socket.send(JSON.stringify({
      v: 1,
      id: helloId,
      t: 'hello',
      role: 'body',
      name: 'electron-body',
      version: bridgeConfig.version,
      protocol: 1,
      token: bridgeConfig.token
    }));
  });
  socket.addEventListener('message', (event) => handleMessage(event.data));
  socket.addEventListener('close', () => {
    connected = false;
    helloId = null;
    pending.clear();
    scheduleReconnect();
  });
  socket.addEventListener('error', () => {
    /* close follows */
  });
}

function handleInput(input) {
  if (!input || typeof input.type !== 'string') return;
  switch (input.type) {
    case 'pat':
    case 'feed':
      fire('interaction', { kind: input.type, source: 'tray' });
      return;
    case 'toggle-mode':
      pendingModeToggle = true;
      fire('mode.toggle');
      return;
    case 'set-always-on-top':
      fire('window.set', { alwaysOnTop: Boolean(input.value) });
      return;
    case 'set-visible':
      fire('window.set', { visible: Boolean(input.value) });
      return;
    case 'set-roam-enabled':
      roamEnabled = Boolean(input.value);
      fire('roam.set-enabled', { enabled: roamEnabled });
      return;
    default:
      return;
  }
}

ipcRenderer.on('bridge-input', (_event, input) => handleInput(input));

ipcRenderer.on('bridge-window-state', (_event, windowState) => {
  fire('window.state', {
    alwaysOnTop: windowState.alwaysOnTop,
    clickThrough: windowState.clickThrough,
    visible: windowState.visible,
    x: windowState.x,
    y: windowState.y
  });
  dispatchVisibility(windowState.visible);
});

ipcRenderer.on('bridge-roam-state', (_event, roamState) => {
  dispatch('roamState', roamState.state);
  fire('roam.state', { state: roamState.state, x: roamState.x, y: roamState.y });
});

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  switchMode: (mode) => fire('mode.request', { mode }),
  setAlwaysOnTop: (flag) => fire('window.set', { alwaysOnTop: Boolean(flag) }),
  minimizeApp: () => fire('window.minimize'),
  closeApp: () => fire('window.close'),
  setIgnoreMouseEvents: (ignore, options) => fire('window.set', {
    clickThrough: Boolean(ignore),
    forward: Boolean(options && options.forward)
  }),

  onModeChanged: (callback) => listeners.modeChanged.push(callback),
  onToggleModeRequest: (callback) => {
    listeners.toggleModeRequest.push(callback);
    // A reloaded renderer starts in pet mode; restore it to the brain's mode.
    callback(knownMode);
  },
  onPetInteraction: (callback) => listeners.petInteraction.push(callback),
  onRoamState: (callback) => listeners.roamState.push(callback),
  onWindowVisibility: (callback) => listeners.windowVisibility.push(callback),

  setUiBusy: (busy) => fire('ui.busy', { busy: Boolean(busy) }),
  notifyPetActivity: () => fire('activity'),
  getRoamEnabled: () => (connected ? request('roam.get').then((reply) => Boolean(reply.enabled)) : Promise.resolve(roamEnabled)),
  setRoamEnabled: (enabled) => {
    roamEnabled = Boolean(enabled);
    fire('roam.set-enabled', { enabled: roamEnabled });
  }
});

connect();
