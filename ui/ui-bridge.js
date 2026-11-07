/*
 * AuraPet daemon UI bridge (issue #12).
 *
 * Runs in the browser page served by daemon/ui-server.js. It provides the two
 * globals the existing renderer expects:
 *   - a localStorage-shaped store backed by the daemon config (writes become
 *     settings.set patches),
 *   - window.electronAPI + AIService backed by the WS protocol.
 *
 * The page keeps the existing index.html/app.js/pet.js verbatim.
 */
(function () {
  'use strict';

  const boot = window.__AURAPET__;
  if (!boot || !boot.token) {
    document.body.innerHTML = '<p style="font:14px sans-serif;padding:24px">AuraPet UI: missing bridge token. Open this page from the tray.</p>';
    return;
  }

  const nativeStorage = window.localStorage;
  const settings = new Map();
  for (const [key, value] of Object.entries(boot.settings || {})) {
    if (key.startsWith('aurapet_')) settings.set(key, String(value));
  }

  let socket = null;
  let connected = false;
  let helloId = 1;
  let nextId = 2;
  let reconnectDelay = 1000;
  let knownMode = 'chat';
  let roamEnabled = false;
  const mcp = { server: null, upstreams: [] };
  window.__AURAPET_MCP__ = mcp;
  const pending = new Map();
  const queue = [];
  const listeners = {
    modeChanged: [],
    toggleModeRequest: [],
    petInteraction: [],
    roamState: [],
    windowVisibility: []
  };

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
    if (!rawSend(message) && queue.length < 100) queue.push(message);
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
      if (!rawSend({ id, t: type, ...payload }) && queue.length < 100) queue.push({ id, t: type, ...payload });
    });
  }

  function flushQueue() {
    const queued = queue.splice(0);
    for (const message of queued) rawSend(message);
  }

  // --- settings-backed localStorage -------------------------------------

  function pushSetting(key, value) {
    fire('settings.set', { patch: { [key]: value } });
  }

  function patchStorage() {
    const proto = Storage.prototype;
    const original = {
      getItem: proto.getItem,
      setItem: proto.setItem,
      removeItem: proto.removeItem,
      clear: proto.clear,
      key: proto.key,
      length: Object.getOwnPropertyDescriptor(proto, 'length')
    };
    const mine = (self) => self === nativeStorage;

    proto.getItem = function (key) {
      if (!mine(this)) return original.getItem.call(this, key);
      const name = String(key);
      return settings.has(name) ? settings.get(name) : null;
    };
    proto.setItem = function (key, value) {
      if (!mine(this)) return original.setItem.call(this, key, value);
      const name = String(key);
      settings.set(name, String(value));
      pushSetting(name, String(value));
    };
    proto.removeItem = function (key) {
      if (!mine(this)) return original.removeItem.call(this, key);
      const name = String(key);
      settings.delete(name);
      pushSetting(name, null);
    };
    proto.clear = function () {
      if (!mine(this)) return original.clear.call(this);
      const removed = {};
      for (const name of [...settings.keys()]) {
        if (!name.startsWith('aurapet_')) continue;
        settings.delete(name);
        removed[name] = null;
      }
      if (Object.keys(removed).length) fire('settings.set', { patch: removed });
    };
    proto.key = function (index) {
      if (!mine(this)) return original.key.call(this, index);
      const keys = [...settings.keys()];
      return index >= 0 && index < keys.length ? keys[index] : null;
    };
    Object.defineProperty(proto, 'length', {
      configurable: true,
      get() {
        return mine(this) ? settings.size : original.length.get.call(this);
      }
    });
  }

  patchStorage();

  // --- WS client --------------------------------------------------------

  function applySettingPatch(patch) {
    for (const [key, value] of Object.entries(patch || {})) {
      if (!key.startsWith('aurapet_')) continue;
      if (value === null) settings.delete(key);
      else settings.set(key, String(value));
    }
  }

  function handleEvent(message) {
    switch (message.t) {
      case 'state.sync':
        if (message.mode === 'pet' || message.mode === 'chat') {
          knownMode = message.mode;
          dispatch('modeChanged', knownMode);
        }
        roamEnabled = Boolean(message.roamEnabled);
        if (typeof message.visibility === 'boolean') dispatch('windowVisibility', message.visibility);
        return;
      case 'mode.set':
        knownMode = message.mode;
        dispatch('modeChanged', message.mode);
        return;
      case 'mode.changed':
        knownMode = message.mode;
        dispatch('modeChanged', message.mode);
        return;
      case 'window.state':
        if (typeof message.visible === 'boolean') dispatch('windowVisibility', message.visible);
        return;
      case 'roam.state':
        dispatch('roamState', message.state);
        return;
      case 'roam.enabled':
        roamEnabled = Boolean(message.enabled);
        return;
      case 'react':
        dispatch('petInteraction', message.kind);
        return;
      case 'settings.changed':
        applySettingPatch(message.patch);
        return;
      case 'mcp.status':
        mcp.upstreams = Array.isArray(message.servers) ? message.servers : [];
        window.dispatchEvent(new CustomEvent('aurapet:mcp-status'));
        return;
      case 'mcp.server.status':
        mcp.server = {
          enabled: Boolean(message.enabled),
          port: Number.isInteger(message.port) ? message.port : 0,
          clients: Number.isInteger(message.clients) ? message.clients : 0,
          tools: Array.isArray(message.tools) ? message.tools : []
        };
        window.dispatchEvent(new CustomEvent('aurapet:mcp-status'));
        return;
      case 'chat.delta':
        if (activeStream) activeStream.onChunk(String(message.text || ''));
        return;
      case 'chat.done':
        if (activeStream) {
          const stream = activeStream;
          activeStream = null;
          stream.onDone(String(message.full || ''));
        }
        return;
      case 'chat.error':
        if (activeStream) {
          const stream = activeStream;
          activeStream = null;
          stream.onError(String(message.error || 'unknown error'));
        }
        return;
      case 'ping':
        if (message.id != null) rawSend({ id: message.id, ok: true, ts: message.ts });
        else fire('pong', { ts: Date.now() });
        return;
      default:
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
      if (message.id === helloId) {
        if (message.ok) {
          connected = true;
          reconnectDelay = 1000;
          flushQueue();
        } else {
          socket.close();
        }
        return;
      }
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
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
      socket = new WebSocket(`ws://127.0.0.1:${boot.wsPort}`);
    } catch {
      scheduleReconnect();
      return;
    }
    socket.addEventListener('open', () => {
      helloId = nextId++;
      socket.send(JSON.stringify({
        v: 1, id: helloId, t: 'hello', role: 'ui', name: 'aurapet-web-ui',
        version: '1.6.0', protocol: 1, token: boot.token
      }));
    });
    socket.addEventListener('message', (event) => handleMessage(event.data));
    socket.addEventListener('close', () => {
      connected = false;
      pending.clear();
      scheduleReconnect();
    });
    socket.addEventListener('error', () => {});
  }

  // --- AIService over WS ------------------------------------------------

  let activeStream = null;

  class AIService {
    constructor() {
      this.loadConfig();
    }

    loadConfig() {
      this.provider = localStorage.getItem('aurapet_ai_provider') || 'builtin';
      this.apiKey = localStorage.getItem('aurapet_api_key') || '';
      this.baseUrl = localStorage.getItem('aurapet_base_url') || '';
      this.modelName = localStorage.getItem('aurapet_model_name') || '';
      this.systemPrompt = localStorage.getItem('aurapet_system_prompt') || '';
    }

    saveConfig(config = {}) {
      this.provider = config.provider || 'builtin';
      this.apiKey = config.apiKey || '';
      this.baseUrl = config.baseUrl || '';
      this.modelName = config.modelName || '';
      this.systemPrompt = config.systemPrompt || '';
      localStorage.setItem('aurapet_ai_provider', this.provider);
      localStorage.setItem('aurapet_api_key', this.apiKey);
      localStorage.setItem('aurapet_base_url', this.baseUrl);
      localStorage.setItem('aurapet_model_name', this.modelName);
      localStorage.setItem('aurapet_system_prompt', this.systemPrompt);
    }

    get userTitle() {
      return localStorage.getItem('aurapet_user_title') || '主人';
    }

    abortCurrent() {
      if (!activeStream) return;
      fire('chat.abort');
    }

    async streamChat(messages, onChunk, onDone, onError) {
      if (!connected) {
        onError('daemon 未連線，請確認 AuraPet 已在執行。');
        return;
      }
      if (activeStream) this.abortCurrent();
      activeStream = { onChunk, onDone, onError };
      const last = messages[messages.length - 1];
      fire('chat.send', { text: last ? String(last.content || '') : '' });
    }
  }

  // --- electronAPI shim -------------------------------------------------

  window.electronAPI = {
    platform: navigator.platform,
    switchMode: (mode) => fire('mode.request', { mode }),
    setAlwaysOnTop: (flag) => fire('window.set', { alwaysOnTop: Boolean(flag) }),
    minimizeApp: () => window.blur(),
    closeApp: () => window.close(),
    setIgnoreMouseEvents: () => {},
    onModeChanged: (callback) => { listeners.modeChanged.push(callback); },
    onToggleModeRequest: (callback) => {
      listeners.toggleModeRequest.push(callback);
      callback(knownMode);
    },
    onPetInteraction: (callback) => { listeners.petInteraction.push(callback); },
    onRoamState: (callback) => { listeners.roamState.push(callback); },
    onWindowVisibility: (callback) => { listeners.windowVisibility.push(callback); },
    setUiBusy: (busy) => fire('ui.busy', { busy: Boolean(busy) }),
    notifyPetActivity: () => fire('activity'),
    getRoamEnabled: () => (connected ? request('roam.get').then((reply) => Boolean(reply.enabled)) : Promise.resolve(roamEnabled)),
    setRoamEnabled: (enabled) => fire('roam.set-enabled', { enabled: Boolean(enabled) })
  };

  window.AIService = AIService;
  connect();
})();
