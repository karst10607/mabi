/**
 * AuraPet daemon - honoka events client (issue #53).
 *
 * Subscribes to honoka-publish's `GET /events` SSE stream and forwards
 * pipeline events to the pet body as bubbles over the existing WS protocol
 * (no protocol additions). The stream is optional: missing config, honoka
 * being offline, or errors just log and retry with exponential backoff -
 * UI notifications may be dropped, they are not a critical path.
 *
 * Payloads never contain tokens or note bodies (honoka scrubs them too);
 * download progress is collapsed to 25% buckets so bubbles stay quiet.
 */
'use strict';

const DEFAULT_BACKOFF = { initial: 1000, max: 30000, factor: 2 };
const CONNECT_TIMEOUT_MS = 10000;
const MAX_BUBBLE_TEXT = 160;

const isLoopback = (hostname) => {
  const host = String(hostname || '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
};

function normalizeHonokaEvents(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.protocol === 'http:' && !isLoopback(parsed.hostname)) return null;
  const token = typeof raw.token === 'string' ? raw.token : '';
  return { url, token };
}

function clip(text, max = MAX_BUBBLE_TEXT) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Map a honoka event to a body bubble payload, or null when it should not
 * surface. `progress` is bucketed to 25/50/75/100 per URL.
 */
function toBubble(event, progressState) {
  if (!event || typeof event.type !== 'string') return null;
  switch (event.type) {
    case 'url_received':
      return { text: `🔗 收到連結，開始處理：${clip(event.title || event.url)}`, emotion: 'happy', ttlMs: 5000 };
    case 'note_saved':
      return { text: `📝 已存入筆記：${clip(event.title || event.url)}`, emotion: 'happy', ttlMs: 7000 };
    case 'error':
      return { text: `⚠️ 連結處理失敗：${clip(event.error || 'unknown')}`, emotion: 'sad', ttlMs: 7000 };
    case 'download_progress': {
      const pct = Number(event.progress);
      if (!Number.isFinite(pct)) return null;
      const bucket = pct >= 100 ? 100 : Math.floor(pct / 25) * 25;
      if (bucket < 25) return null;
      const key = String(event.url || '');
      const last = progressState.get(key);
      if (last !== undefined && bucket <= last) return null;
      progressState.set(key, bucket);
      return { text: `⬇️ 下載中 ${bucket}%`, emotion: 'happy', ttlMs: 4000 };
    }
    default:
      return null;
  }
}

/** Incremental SSE parser over a fetch body stream. */
function createSseParser(handleEvent) {
  let buffer = '';
  let eventType = '';
  let eventId = '';
  let dataLines = [];

  const dispatch = () => {
    if (!eventType && dataLines.length === 0) {
      eventId = '';
      return;
    }
    let payload = null;
    if (dataLines.length > 0) {
      try {
        payload = JSON.parse(dataLines.join('\n'));
      } catch {
        payload = null;
      }
    }
    const id = eventId || (payload && payload.id) || '';
    if (payload && eventType) {
      handleEvent({ id, ...payload });
    }
    eventType = '';
    eventId = '';
    dataLines = [];
  };

  return function push(chunkText) {
    buffer += chunkText;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line === '') {
        dispatch();
      } else if (line.startsWith(':')) {
        // heartbeat comment
      } else if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      } else if (line.startsWith('id:')) {
        eventId = line.slice(3).trim();
      }
    }
  };
}

function createHonokaEventClient(options = {}) {
  const {
    configStore,
    onEvent = () => {},
    log = console,
    backoff: backoffOptions
  } = options;
  if (!configStore) throw new TypeError('createHonokaEventClient requires a config store');

  const backoff = { ...DEFAULT_BACKOFF, ...(backoffOptions || {}) };
  const progressState = new Map();
  let stopped = true;
  let attempt = 0;
  let timer = null;
  let controller = null;
  let state = 'stopped';
  let lastEventId = '';
  let activeUrl = '';

  function status() {
    return { state, ...(activeUrl ? { url: activeUrl } : {}), ...(lastEventId ? { lastEventId } : {}) };
  }

  function scheduleReconnect() {
    if (stopped || timer) return;
    const delay = Math.min(backoff.max, backoff.initial * Math.pow(backoff.factor, attempt));
    attempt += 1;
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, Math.max(backoff.initial, delay));
    if (typeof timer.unref === 'function') timer.unref();
  }

  function cancel() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (controller) {
      controller.abort();
      controller = null;
    }
  }

  async function consume(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const push = createSseParser((event) => {
      if (event.id) lastEventId = String(event.id);
      try {
        onEvent(event);
      } catch (error) {
        log.warn(`honoka-events: handler failed: ${error.message}`);
      }
    });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      push(decoder.decode(value, { stream: true }));
    }
  }

  async function connect() {
    if (stopped) return;
    const config = normalizeHonokaEvents(configStore.get('honokaEvents'));
    if (!config) {
      state = 'stopped';
      activeUrl = '';
      log.info('honoka-events: not configured (settings key honokaEvents)');
      return;
    }
    activeUrl = config.url;
    state = 'connecting';
    controller = new AbortController();
    const signal = controller.signal;
    const headers = { Accept: 'text/event-stream' };
    if (lastEventId) headers['Last-Event-ID'] = lastEventId;
    let url = config.url;
    if (config.token) {
      const parsed = new URL(url);
      parsed.searchParams.set('token', config.token);
      url = parsed.toString();
    }

    let connectTimer = null;
    try {
      const timeout = new Promise((_, reject) => {
        connectTimer = setTimeout(() => reject(new Error('connect timed out')), CONNECT_TIMEOUT_MS);
        if (typeof connectTimer.unref === 'function') connectTimer.unref();
      });
      const response = await Promise.race([fetch(url, { signal, headers }), timeout]);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error('no response body');
      state = 'streaming';
      attempt = 0;
      log.info(`honoka-events: streaming from ${config.url}`);
      await consume(response);
      if (!stopped) {
        state = 'error';
        scheduleReconnect();
      }
    } catch (error) {
      if (stopped) return;
      state = 'error';
      const message = String(error && error.message ? error.message : error).replace(/token=[^&\s"']+/gi, 'token=***');
      log.warn(`honoka-events: ${message}`);
      scheduleReconnect();
    } finally {
      if (connectTimer) clearTimeout(connectTimer);
    }
  }

  function start() {
    if (!stopped) return Promise.resolve(status());
    stopped = false;
    attempt = 0;
    connect();
    return Promise.resolve(status());
  }

  function reload() {
    cancel();
    progressState.clear();
    if (stopped) return Promise.resolve(status());
    connect();
    return Promise.resolve(status());
  }

  function stop() {
    stopped = true;
    cancel();
    state = 'stopped';
    progressState.clear();
  }

  return { start, stop, reload, status };
}

module.exports = {
  DEFAULT_BACKOFF,
  createHonokaEventClient,
  normalizeHonokaEvents,
  toBubble,
  createSseParser
};