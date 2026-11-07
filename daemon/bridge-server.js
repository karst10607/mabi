/**
 * AuraPet daemon - body↔daemon WebSocket bridge (protocol v1 subset).
 *
 * Brain-side state (mode, roam schedule, ui.busy) lives here; the body executes
 * window/movement and reports back. Loopback only, shared token from the config
 * store, protocol contract in docs/ws-protocol.md.
 */
'use strict';

const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const AIService = require('./ai-service');

const PROTOCOL_VERSION = 1;
const DEFAULT_PORT = 47821;
const HELLO_TIMEOUT_MS = 5000;
const ROAM = { minDelay: 6000, maxDelay: 14000 };

const randomBetween = (min, max) => min + Math.random() * (max - min);

function ensureToken(store) {
  const existing = store.get('bridgeToken');
  if (typeof existing === 'string' && existing.length >= 32) return existing;
  const token = crypto.randomBytes(32).toString('hex');
  store.patch({ bridgeToken: token });
  return token;
}

function createBridgeServer(options = {}) {
  const {
    configStore,
    port = DEFAULT_PORT,
    brainVersion = '0.0.0',
    log = console
  } = options;
  if (!configStore) throw new TypeError('createBridgeServer requires a config store');

  const token = ensureToken(configStore);
  const session = crypto.randomBytes(8).toString('hex');
  const ai = options.aiService || new AIService({
    store: {
      get: (key) => configStore.get(key),
      set: (key, value) => configStore.patch({ [key]: value })
    }
  });
  const state = {
    mode: 'pet',
    posture: configStore.get('posture') || 'sit',
    skin: configStore.get('skin') || 'cat2d',
    nickname: configStore.get('nickname') || '',
    roamEnabled: configStore.get('roamEnabled') === true,
    uiBusy: false,
    visible: true,
    alwaysOnTop: true,
    clickThrough: false,
    roaming: false
  };

  let wss = null;
  let body = null;
  const uiClients = new Set();
  let roamTimer = null;

  const send = (ws, message) => {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...message }));
  };
  const reply = (ws, id, payload = {}) => send(ws, { id, ok: true, ...payload });
  const fail = (ws, id, code, message) => send(ws, { id, ok: false, error: { code, message } });
  const emit = (ws, t, payload = {}) => send(ws, { t, ...payload });
  const toUi = (t, payload = {}) => {
    for (const client of uiClients) emit(client, t, payload);
  };

  function clearRoamTimer() {
    if (roamTimer) {
      clearTimeout(roamTimer);
      roamTimer = null;
    }
  }

  function canRoam() {
    return state.roamEnabled && state.mode === 'pet' && !state.uiBusy && state.visible &&
      Boolean(body) && body.readyState === body.OPEN;
  }

  function scheduleRoam(delay = randomBetween(ROAM.minDelay, ROAM.maxDelay)) {
    clearRoamTimer();
    if (!canRoam() || state.roaming) return;
    roamTimer = setTimeout(() => {
      roamTimer = null;
      if (!canRoam()) return;
      state.roaming = true;
      emit(body, 'roam.command', { action: 'start' });
    }, delay);
  }

  function pauseRoam() {
    clearRoamTimer();
    if (!state.roaming) return;
    state.roaming = false;
    emit(body, 'roam.command', { action: 'stop' });
  }

  function applyRoamPolicy() {
    if (canRoam()) scheduleRoam(2000);
    else pauseRoam();
  }

  function setMode(ws, id, mode) {
    if (mode !== 'pet' && mode !== 'chat') {
      fail(ws, id, 'bad-request', 'mode must be pet or chat');
      return;
    }
    const changed = state.mode !== mode;
    state.mode = mode;
    reply(ws, id, { mode });
    if (!changed) return;
    emit(body, 'mode.set', { mode });
    if (mode === 'pet') scheduleRoam(2500);
    else pauseRoam();
  }

  function setRoamEnabled(enabled) {
    state.roamEnabled = Boolean(enabled);
    configStore.patch({ roamEnabled: state.roamEnabled });
    emit(body, 'roam.enabled', { enabled: state.roamEnabled });
    toUi('roam.enabled', { enabled: state.roamEnabled });
    if (state.roamEnabled) scheduleRoam(1800);
    else pauseRoam();
    return state.roamEnabled;
  }

  function tokenMatches(given) {
    if (typeof given !== 'string') return false;
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function publicConfig() {
    const all = configStore.getAll();
    delete all.bridgeToken;
    delete all.schemaVersion;
    return all;
  }

  function applySettings(ws, msg) {
    const { id, patch } = msg;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      if (id != null) fail(ws, id, 'bad-request', 'patch must be an object');
      return;
    }
    const applied = {};
    const removals = [];
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'bridgeToken' || key === 'schemaVersion') continue;
      applied[key] = value;
      if (value === null) removals.push(key);
    }
    for (const key of removals) delete applied[key];
    if (removals.length) configStore.remove(removals);
    const flat = Object.fromEntries(Object.entries(applied).filter(([, v]) => v !== null));
    if (Object.keys(flat).length) configStore.patch(flat);
    ai.loadConfig();
    if (id != null) reply(ws, id, { patch: { ...flat, ...Object.fromEntries(removals.map((k) => [k, null])) } });
    toUi('settings.changed', { patch });
  }

  function startChat(ws, msg) {
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (!text) return;
    if (!ws.chat) ws.chat = { history: [], active: false, full: '' };
    if (ws.chat.active) {
      ai.abortCurrent();
      ws.chat.active = false;
    }
    const stream = { history: ws.chat.history, active: true, full: '' };
    ws.chat = stream;
    stream.history.push({ role: 'user', content: text });
    ai.streamChat(
      stream.history,
      (partial) => {
        if (!stream.active) return;
        stream.full = partial;
        emit(ws, 'chat.delta', { text: partial });
      },
      () => {
        if (!stream.active) return;
        stream.active = false;
        stream.history.push({ role: 'assistant', content: stream.full });
        emit(ws, 'chat.done', { full: stream.full });
      },
      (error) => {
        if (!stream.active) return;
        stream.active = false;
        emit(ws, 'chat.error', { error: String(error) });
      }
    ).catch((err) => {
      if (!stream.active) return;
      stream.active = false;
      emit(ws, 'chat.error', { error: err.message });
    });
  }

  function abortChat(ws) {
    if (!ws.chat || !ws.chat.active) return;
    ai.abortCurrent();
    ws.chat.active = false;
    emit(ws, 'chat.done', { full: ws.chat.full });
  }

  function handleHello(ws, msg) {
    if (!tokenMatches(msg.token)) {
      if (msg.id != null) fail(ws, msg.id, 'unauthorized', 'invalid token');
      ws.close();
      return;
    }
    if (msg.protocol !== PROTOCOL_VERSION) {
      if (msg.id != null) fail(ws, msg.id, 'bad-protocol', `protocol ${PROTOCOL_VERSION} required`);
      ws.close();
      return;
    }
    ws.authed = true;
    clearTimeout(ws.helloTimeout);
    const role = msg.role === 'ui' ? 'ui' : 'body';
    ws.role = role;
    if (role === 'body') {
      if (body && body !== ws) {
        try {
          body.close();
        } catch {
          /* replace stale body */
        }
      }
      body = ws;
      reply(ws, msg.id, { session, protocol: PROTOCOL_VERSION, brainVersion });
      emit(ws, 'state.sync', {
        mode: state.mode,
        posture: state.posture,
        skin: state.skin,
        nickname: state.nickname,
        roamEnabled: state.roamEnabled,
        visibility: state.visible,
        clickThrough: state.clickThrough,
        alwaysOnTop: state.alwaysOnTop
      });
      if (state.roamEnabled) scheduleRoam(2000);
      return;
    }
    uiClients.add(ws);
    reply(ws, msg.id, { session, protocol: PROTOCOL_VERSION, brainVersion });
    emit(ws, 'state.sync', { mode: state.mode, roamEnabled: state.roamEnabled });
  }

  function handleWindowSet(ws, msg) {
    const patch = {};
    for (const key of ['alwaysOnTop', 'clickThrough', 'forward', 'visible']) {
      if (key in msg) patch[key] = msg[key];
    }
    if (typeof patch.visible === 'boolean') state.visible = patch.visible;
    if (msg.id != null) reply(ws, msg.id, {});
    if (body) emit(body, 'window.apply', patch);
    if (typeof patch.visible === 'boolean') applyRoamPolicy();
  }

  function handleMessage(ws, msg) {
    if (!msg || msg.v !== PROTOCOL_VERSION || typeof msg.t !== 'string') {
      if (msg && msg.id != null) fail(ws, msg.id, 'bad-envelope', 'invalid envelope');
      return;
    }
    if (msg.t === 'hello') {
      handleHello(ws, msg);
      return;
    }
    if (!ws.authed) {
      if (msg.id != null) fail(ws, msg.id, 'unauthorized', 'hello required');
      return;
    }

    const { id } = msg;
    switch (msg.t) {
      case 'ping':
        if (id != null) reply(ws, id, { ts: msg.ts });
        else emit(ws, 'pong', { ts: msg.ts });
        return;
      case 'pong':
        return;
      case 'mode.request':
        setMode(ws, id, msg.mode);
        return;
      case 'mode.toggle':
        setMode(ws, id, state.mode === 'pet' ? 'chat' : 'pet');
        return;
      case 'mode.changed':
        toUi('mode.changed', { mode: msg.mode });
        return;
      case 'window.set':
        handleWindowSet(ws, msg);
        return;
      case 'window.minimize':
      case 'window.close':
        if (id != null) reply(ws, id, {});
        if (body) emit(body, msg.t);
        return;
      case 'window.state':
        if (typeof msg.visible === 'boolean') state.visible = msg.visible;
        if (typeof msg.alwaysOnTop === 'boolean') state.alwaysOnTop = msg.alwaysOnTop;
        if (typeof msg.clickThrough === 'boolean') state.clickThrough = msg.clickThrough;
        toUi('window.state', {
          alwaysOnTop: msg.alwaysOnTop,
          clickThrough: msg.clickThrough,
          visible: msg.visible,
          x: msg.x,
          y: msg.y
        });
        if (typeof msg.visible === 'boolean') applyRoamPolicy();
        return;
      case 'roam.get':
        if (id != null) reply(ws, id, { enabled: state.roamEnabled });
        return;
      case 'roam.set-enabled': {
        const enabled = setRoamEnabled(msg.enabled);
        if (id != null) reply(ws, id, { enabled });
        return;
      }
      case 'roam.state': {
        const roamState = msg.state;
        toUi('roam.state', { state: roamState, x: msg.x, y: msg.y });
        if (roamState === 'idle') {
          state.roaming = false;
          scheduleRoam();
        } else if (roamState === 'walk-left' || roamState === 'walk-right') {
          state.roaming = true;
          clearRoamTimer();
        }
        return;
      }
      case 'ui.busy':
        state.uiBusy = Boolean(msg.busy);
        applyRoamPolicy();
        return;
      case 'chat.send':
        startChat(ws, msg);
        return;
      case 'chat.abort':
        abortChat(ws);
        return;
      case 'settings.get':
        if (id != null) reply(ws, id, { patch: publicConfig() });
        return;
      case 'settings.set':
        applySettings(ws, msg);
        return;
      case 'activity':
        if (canRoam()) scheduleRoam(randomBetween(5000, 9000));
        return;
      case 'interaction': {
        if (id != null) reply(ws, id, { kind: msg.kind });
        if (!body) return;
        emit(body, 'react', {
          kind: msg.kind,
          emotion: msg.kind === 'feed' ? 'eating' : 'happy'
        });
        return;
      }
      default:
        // Unknown type: reply to requests, ignore fire-and-forget events.
        if (id != null) fail(ws, id, 'unknown-type', `unknown message type: ${msg.t}`);
    }
  }

  function onConnection(ws) {
    ws.authed = false;
    ws.helloTimeout = setTimeout(() => {
      if (!ws.authed) ws.close();
    }, HELLO_TIMEOUT_MS);
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      try {
        handleMessage(ws, msg);
      } catch (err) {
        log.warn('bridge: message handling failed:', err.message);
        if (msg && msg.id != null) fail(ws, msg.id, 'internal', 'handler failed');
      }
    });
    ws.on('close', () => {
      clearTimeout(ws.helloTimeout);
      uiClients.delete(ws);
      if (ws.chat && ws.chat.active) {
        ai.abortCurrent();
        ws.chat.active = false;
      }
      if (body === ws) {
        body = null;
        state.roaming = false;
        clearRoamTimer();
      }
    });
    ws.on('error', () => {});
  }

  return {
    port,
    token,
    getState() {
      return { ...state };
    },
    setRoamEnabled(enabled) {
      return setRoamEnabled(enabled);
    },
    start() {
      return new Promise((resolve, reject) => {
        wss = new WebSocketServer({ host: '127.0.0.1', port });
        wss.once('listening', () => {
          log.info(`bridge: listening on ws://127.0.0.1:${port}`);
          resolve({ port });
        });
        wss.once('error', (err) => reject(err));
        wss.on('connection', onConnection);
      });
    },
    stop() {
      clearRoamTimer();
      if (!wss) return;
      for (const client of wss.clients) {
        try {
          client.close();
        } catch {
          /* already gone */
        }
      }
      wss.close();
      wss = null;
      body = null;
    }
  };
}

module.exports = {
  PROTOCOL_VERSION,
  DEFAULT_PORT,
  createBridgeServer
};
