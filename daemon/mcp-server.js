/**
 * AuraPet daemon - MCP server face (issue #14).
 *
 * Standard MCP Streamable HTTP transport (JSON-RPC 2.0 over loopback HTTP),
 * never the private body WS. MCP clients (Qoder, MCP Inspector, ...) get the
 * pet tools; every tool call is translated into brain state / WS messages so
 * the body never learns that MCP exists.
 *
 * Security: bound to 127.0.0.1, bearer token (`mcpToken`, 0600 config file),
 * Origin/Host allowlist for loopback. Slow work is bounded (notes.search) or
 * ticket-based (pet.ask) so a tool call never blocks a client's 60s timeout.
 */
'use strict';

const crypto = require('crypto');
const http = require('http');
const AIService = require('./ai-service');

const DEFAULT_MCP_PORT = 47822;
const DEFAULT_PATH = '/mcp';
const MCP_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY_BYTES = 256 * 1024;
const SEARCH_BUDGET_MS = 4500;
const UPSTREAM_TIMEOUT_MS = 2000;
const ASK_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_TEXT = 4000;

function packageVersion() {
  try {
    return require('../package.json').version;
  } catch {
    return '0.0.0';
  }
}

const SERVER_INFO = { name: 'aurapet-mcp', version: packageVersion() };

function ensureToken(store) {
  const existing = store.get('mcpToken');
  if (typeof existing === 'string' && existing.length >= 32) return existing;
  const token = crypto.randomBytes(32).toString('hex');
  store.patch({ mcpToken: token });
  return token;
}

const textResult = (payload, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  structuredContent: payload,
  ...(isError ? { isError: true } : {})
});

const TOOLS = [
  {
    name: 'pet.say',
    description: 'Make the desktop pet show a speech bubble. Returns once the body has been sent the message (never blocks on rendering).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 2000, description: 'Bubble text' },
        emotion: { type: 'string', maxLength: 32, description: 'Optional emotion hint (happy, eating, ...)' },
        ttlMs: { type: 'integer', minimum: 0, maximum: 60000, description: 'How long the bubble stays visible' },
        speech: { type: 'boolean', description: 'Ask the body for TTS when available' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'pet.mood.get',
    description: 'Read the current pet/brain state: mode, posture, skin, nickname, roaming and body connection.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'pet.ask',
    description: 'Ask the pet AI a question asynchronously. Returns a ticket immediately; poll pet.ask.result with it.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: MAX_TEXT, description: 'Question for the pet AI' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'pet.ask.result',
    description: 'Poll an async pet.ask ticket. state is pending | done | error.',
    inputSchema: {
      type: 'object',
      properties: {
        ticket: { type: 'string', minLength: 1, maxLength: 128 }
      },
      required: ['ticket'],
      additionalProperties: false
    }
  },
  {
    name: 'notes.search',
    description: 'Search configured upstream note MCP servers (Streamable HTTP) and aggregate their results. Bounded to a few seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500 },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max aggregated results (default 10)' },
        sources: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          maxItems: 10,
          description: 'Optional upstream names to query (default: all configured)'
        }
      },
      required: ['query'],
      additionalProperties: false
    }
  }
];

const TOOL_NAMES = TOOLS.map((tool) => tool.name);

function isLoopbackHost(value) {
  if (typeof value !== 'string') return false;
  const host = value.trim().toLowerCase().replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function originAllowed(origin) {
  if (!origin) return true; // native MCP clients send no Origin
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHost(url.host);
  } catch {
    return false;
  }
}

function hostAllowed(host) {
  if (!host) return true;
  return isLoopbackHost(host);
}

function tokenMatches(expected, header) {
  if (typeof header !== 'string') return false;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const given = Buffer.from(match[1].trim());
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/** Accept application/json or an SSE frame with the matching JSON-RPC reply. */
function parseJsonRpcBody(body, id) {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    /* fall through to SSE */
  }
  const messages = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      /* ignore partial frames */
    }
  }
  return messages.find((message) => message && message.id === id) || messages[0] || null;
}

async function postJsonRpc(url, message, headers, timeoutMs) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(Math.max(250, timeoutMs))
  });
  return response;
}

function pickSearchTool(tools) {
  if (!Array.isArray(tools)) return null;
  const names = tools.map((tool) => tool && tool.name).filter((name) => typeof name === 'string');
  const patterns = [/^search$/i, /search/i, /find/i, /query/i];
  for (const pattern of patterns) {
    const hit = names.find((name) => pattern.test(name));
    if (hit) return tools.find((tool) => tool.name === hit);
  }
  return null;
}

function searchArgumentName(tool, fallback) {
  const props = tool?.inputSchema?.properties;
  if (!props || typeof props !== 'object') return fallback;
  if (Object.hasOwn(props, 'query')) return 'query';
  if (Object.hasOwn(props, 'q')) return 'q';
  if (Object.hasOwn(props, 'text')) return 'text';
  return fallback;
}

function extractItems(text) {
  if (typeof text !== 'string') return [];
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* plain text */
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : null;
  if (!list) {
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 240);
    return snippet ? [{ title: '', snippet }] : [];
  }
  return list
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      title: String(item.title ?? item.name ?? item.path ?? ''),
      snippet: String(item.snippet ?? item.excerpt ?? item.content ?? item.text ?? '')
        .replace(/\s+/g, ' ')
        .slice(0, 240),
      ...(item.url || item.link ? { url: String(item.url ?? item.link) } : {})
    }));
}

function normalizeUpstreams(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    if (!name || !url || seen.has(name)) continue;
    try {
      const parsed = new URL(url);
      if (!isLoopbackHost(parsed.host) && parsed.hostname !== '127.0.0.1') {
        // Remote note services are an explicit opt-in; allow https only.
        if (parsed.protocol !== 'https:') continue;
      }
    } catch {
      continue;
    }
    seen.add(name);
    out.push({
      name,
      url,
      token: typeof entry.token === 'string' ? entry.token : '',
      transport: entry.transport === 'stdio' ? 'stdio' : 'streamable-http'
    });
  }
  return out;
}

function createMcpServer(options = {}) {
  const {
    configStore,
    bridge,
    port = DEFAULT_MCP_PORT,
    path = DEFAULT_PATH,
    log = console,
    aiServiceFactory
  } = options;
  if (!configStore) throw new TypeError('createMcpServer requires a config store');
  if (!bridge) throw new TypeError('createMcpServer requires the bridge server');

  const token = ensureToken(configStore);
  const sessions = new Map();
  const tickets = new Map();
  let server = null;
  let actualPort = port;
  let stopped = false;

  const store = {
    get: (key) => configStore.get(key),
    set: (key, value) => configStore.patch({ [key]: value })
  };
  const makeAi = aiServiceFactory || (() => new AIService({ store }));

  function prune() {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastSeen > SESSION_TTL_MS) sessions.delete(id);
    }
    for (const [id, ticket] of tickets) {
      if (ticket.state !== 'pending' && now - ticket.createdAt > ASK_TTL_MS) tickets.delete(id);
      else if (ticket.state === 'pending' && now - ticket.createdAt > ASK_TTL_MS * 2) tickets.delete(id);
    }
  }

  function publishStatus() {
    prune();
    if (stopped) return;
    bridge.setMcpStatus({
      enabled: true,
      port: actualPort,
      clients: sessions.size,
      tools: TOOL_NAMES
    });
  }

  function upstreamServers() {
    return normalizeUpstreams(configStore.get('mcpUpstreams')).map((upstream) => ({
      name: upstream.name,
      transport: upstream.transport,
      state: 'configured',
      toolCount: 0
    }));
  }

  // ---------------------------------------------------------------- tools

  function toolSay(args) {
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text || text.length > 2000) return textResult({ ok: false, error: 'text must be 1..2000 chars' }, true);
    const payload = { text };
    if (typeof args.emotion === 'string' && args.emotion.trim()) payload.emotion = args.emotion.trim().slice(0, 32);
    if (Number.isInteger(args.ttlMs) && args.ttlMs >= 0 && args.ttlMs <= 60000) payload.ttlMs = args.ttlMs;
    if (typeof args.speech === 'boolean') payload.speech = args.speech;
    const delivered = bridge.say(payload);
    if (!delivered) return textResult({ ok: false, delivered: false, error: 'body offline' }, true);
    return textResult({ ok: true, delivered: true });
  }

  function toolMood() {
    const state = bridge.getState();
    return textResult({
      mode: state.mode,
      posture: state.posture,
      skin: state.skin,
      nickname: state.nickname,
      roamEnabled: state.roamEnabled,
      roaming: state.roaming,
      visible: state.visible,
      bodyConnected: bridge.isBodyConnected()
    });
  }

  function toolAsk(args) {
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text || text.length > MAX_TEXT) return textResult({ ok: false, error: `text must be 1..${MAX_TEXT} chars` }, true);
    prune();
    const ticket = crypto.randomBytes(8).toString('hex');
    const record = { ticket, state: 'pending', createdAt: Date.now(), answer: '', error: '' };
    tickets.set(ticket, record);
    const ai = makeAi();
    let partial = '';
    ai.streamChat(
      [{ role: 'user', content: text }],
      (chunk) => {
        partial = chunk;
      },
      () => {
        record.state = 'done';
        record.answer = partial;
      },
      (error) => {
        record.state = 'error';
        record.error = String(error || 'unknown error');
      }
    ).catch((error) => {
      record.state = 'error';
      record.error = error.message;
    });
    return textResult({ ticket, state: 'pending' });
  }

  function toolAskResult(args) {
    const ticket = typeof args.ticket === 'string' ? args.ticket : '';
    const record = tickets.get(ticket);
    if (!record) return textResult({ ok: false, error: 'unknown ticket' }, true);
    return textResult({
      ticket: record.ticket,
      state: record.state,
      ...(record.state === 'done' ? { answer: record.answer } : {}),
      ...(record.state === 'error' ? { error: record.error } : {})
    });
  }

  async function callUpstream(upstream, query, limit, deadline) {
    if (upstream.transport !== 'streamable-http') {
      return { name: upstream.name, state: 'skipped', error: 'stdio upstreams are not aggregated yet' };
    }
    const headers = {};
    if (upstream.token) headers.Authorization = `Bearer ${upstream.token}`;
    const remaining = () => Math.max(250, Math.min(UPSTREAM_TIMEOUT_MS, deadline - Date.now()));

    const init = await postJsonRpc(
      upstream.url,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'aurapet-mcp', version: SERVER_INFO.version }
        }
      },
      headers,
      remaining()
    );
    if (init.status === 401 || init.status === 403) {
      return { name: upstream.name, state: 'error', error: `upstream rejected credentials (${init.status})` };
    }
    const sessionId = init.headers.get('mcp-session-id');
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const initBody = parseJsonRpcBody(await init.text(), 1);
    if (!initBody || initBody.error) {
      return { name: upstream.name, state: 'error', error: initBody?.error?.message || `initialize failed (${init.status})` };
    }

    await postJsonRpc(
      upstream.url,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      headers,
      remaining()
    ).catch(() => null);

    const listResponse = await postJsonRpc(
      upstream.url,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      headers,
      remaining()
    );
    const listBody = parseJsonRpcBody(await listResponse.text(), 2);
    const tool = pickSearchTool(listBody?.result?.tools);
    if (!tool) return { name: upstream.name, state: 'error', error: 'no search-like tool' };

    const callResponse = await postJsonRpc(
      upstream.url,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: tool.name,
          arguments: { [searchArgumentName(tool, 'query')]: query, limit }
        }
      },
      headers,
      remaining()
    );
    const callBody = parseJsonRpcBody(await callResponse.text(), 3);
    if (!callBody || callBody.error) {
      return { name: upstream.name, state: 'error', error: callBody?.error?.message || `tools/call failed (${callResponse.status})` };
    }
    const content = callBody.result?.content;
    const text = Array.isArray(content)
      ? content.filter((item) => item && item.type === 'text' && typeof item.text === 'string').map((item) => item.text).join('\n')
      : '';
    const items = extractItems(text).map((item) => ({ source: upstream.name, ...item }));
    return { name: upstream.name, state: 'ok', tool: tool.name, items };
  }

  async function toolNotesSearch(args) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query || query.length > 500) return textResult({ ok: false, error: 'query must be 1..500 chars' }, true);
    const limit = Number.isInteger(args.limit) ? Math.min(50, Math.max(1, args.limit)) : 10;
    const wanted = Array.isArray(args.sources) ? args.sources.filter((name) => typeof name === 'string') : null;
    const upstreams = normalizeUpstreams(configStore.get('mcpUpstreams'))
      .filter((upstream) => !wanted || wanted.includes(upstream.name))
      .slice(0, 10);

    if (upstreams.length === 0) {
      return textResult({
        query,
        results: [],
        sources: [],
        note: 'no upstream MCP servers configured (settings key mcpUpstreams)'
      });
    }

    const deadline = Date.now() + SEARCH_BUDGET_MS;
    const settled = await Promise.all(upstreams.map((upstream) =>
      callUpstream(upstream, query, limit, deadline).catch((error) => ({
        name: upstream.name,
        state: 'error',
        error: error.name === 'TimeoutError' ? 'timed out' : error.message
      }))
    ));

    const results = [];
    const sources = [];
    for (const entry of settled) {
      sources.push({
        name: entry.name,
        state: entry.state,
        ...(entry.tool ? { tool: entry.tool } : {}),
        ...(entry.error ? { error: entry.error } : {})
      });
      for (const item of entry.items || []) {
        if (results.length >= limit) break;
        results.push(item);
      }
    }
    return textResult({ query, results, sources });
  }

  async function callTool(name, args) {
    switch (name) {
      case 'pet.say':
        return toolSay(args);
      case 'pet.mood.get':
        return toolMood();
      case 'pet.ask':
        return toolAsk(args);
      case 'pet.ask.result':
        return toolAskResult(args);
      case 'notes.search':
        return toolNotesSearch(args);
      default:
        return null;
    }
  }

  // ------------------------------------------------------------- JSON-RPC

  function handleRpc(message) {
    const { id, method, params } = message;
    const isNotification = !Object.hasOwn(message, 'id');
    if (typeof method !== 'string') {
      return isNotification ? null : jsonRpcError(id, -32600, 'method must be a string');
    }
    if (method === 'initialize') {
      const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSION;
      return jsonRpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO
      });
    }
    if (isNotification) return null; // notifications/initialized etc.

    switch (method) {
      case 'ping':
        return jsonRpcResult(id, {});
      case 'tools/list':
        return jsonRpcResult(id, { tools: TOOLS });
      case 'tools/call': {
        const name = typeof params?.name === 'string' ? params.name : '';
        if (!TOOL_NAMES.includes(name)) return jsonRpcError(id, -32602, `unknown tool: ${name}`);
        const args = params?.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? params.arguments
          : {};
        return callTool(name, args).then((result) => jsonRpcResult(id, result));
      }
      default:
        return jsonRpcError(id, -32601, `method not found: ${method}`);
    }
  }

  // ---------------------------------------------------------------- HTTP

  function corsHeaders(origin) {
    if (!origin) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version',
      'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id',
      Vary: 'Origin'
    };
  }

  function sendJson(res, status, payload, extra = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra
    });
    res.end(body);
  }

  function sendEmpty(res, status, extra = {}) {
    res.writeHead(status, extra);
    res.end();
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(Object.assign(new Error('body too large'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function onRequest(req, res) {
    const origin = req.headers.origin;
    const cors = corsHeaders(origin && originAllowed(origin) ? origin : null);

    if (!hostAllowed(req.headers.host)) {
      sendJson(res, 403, jsonRpcError(null, -32600, 'host not allowed'), cors);
      return;
    }
    if (!originAllowed(origin)) {
      sendJson(res, 403, jsonRpcError(null, -32600, 'origin not allowed'), cors);
      return;
    }
    if (req.method === 'OPTIONS') {
      sendEmpty(res, 204, cors);
      return;
    }

    let pathname = '';
    try {
      pathname = new URL(req.url, `http://127.0.0.1:${actualPort}`).pathname;
    } catch {
      sendJson(res, 400, jsonRpcError(null, -32600, 'bad url'), cors);
      return;
    }
    if (pathname !== path) {
      sendEmpty(res, 404, cors);
      return;
    }
    if (!tokenMatches(token, req.headers.authorization)) {
      sendJson(res, 401, jsonRpcError(null, -32600, 'unauthorized'), {
        ...cors,
        'WWW-Authenticate': 'Bearer realm="aurapet-mcp"'
      });
      return;
    }

    if (req.method === 'GET') {
      sendEmpty(res, 405, { ...cors, Allow: 'POST, DELETE' });
      return;
    }
    if (req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'];
      if (typeof sessionId === 'string' && sessions.delete(sessionId)) {
        publishStatus();
        sendEmpty(res, 204, cors);
      } else {
        sendJson(res, 404, jsonRpcError(null, -32600, 'unknown session'), cors);
      }
      return;
    }
    if (req.method !== 'POST') {
      sendEmpty(res, 405, { ...cors, Allow: 'POST, DELETE' });
      return;
    }

    const sessionHeader = req.headers['mcp-session-id'];
    if (typeof sessionHeader === 'string' && !sessions.has(sessionHeader)) {
      sendJson(res, 404, jsonRpcError(null, -32600, 'unknown session'), cors);
      return;
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (error) {
      sendJson(res, error.status || 400, jsonRpcError(null, -32700, error.message), cors);
      return;
    }
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      sendJson(res, 400, jsonRpcError(null, -32700, 'parse error'), cors);
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
      sendJson(res, 400, jsonRpcError(message?.id ?? null, -32600, 'invalid request'), cors);
      return;
    }

    let sessionId = typeof sessionHeader === 'string' ? sessionHeader : '';
    if (!sessionId && message.method === 'initialize') {
      sessionId = crypto.randomBytes(16).toString('hex');
      sessions.set(sessionId, { createdAt: Date.now(), lastSeen: Date.now() });
    } else if (sessionId) {
      const session = sessions.get(sessionId);
      if (session) session.lastSeen = Date.now();
    }

    let response;
    try {
      response = await handleRpc(message);
    } catch (error) {
      log.warn('mcp: tool call failed:', error.message);
      response = Object.hasOwn(message, 'id')
        ? jsonRpcError(message.id, -32603, 'internal error')
        : null;
    }

    const headers = { ...cors };
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
      headers['MCP-Protocol-Version'] = MCP_PROTOCOL_VERSION;
    }

    if (response == null) {
      sendEmpty(res, 202, headers);
    } else {
      sendJson(res, 200, response, headers);
    }
    publishStatus();
  }

  return {
    port: () => actualPort,
    path,
    token,
    tools: TOOL_NAMES,
    upstreamServers,
    start() {
      return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          onRequest(req, res).catch((error) => {
            log.warn('mcp: request failed:', error.message);
            if (!res.headersSent) sendJson(res, 500, jsonRpcError(null, -32603, 'internal error'));
            else res.end();
          });
        });
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          actualPort = server.address().port;
          stopped = false;
          log.info(`mcp: listening on http://127.0.0.1:${actualPort}${path} (bearer token required)`);
          publishStatus();
          resolve({ port: actualPort });
        });
      });
    },
    stop() {
      stopped = true;
      for (const session of sessions.values()) session.lastSeen = 0;
      sessions.clear();
      tickets.clear();
      if (server) {
        server.close();
        server = null;
      }
      if (bridge) bridge.setMcpStatus({ enabled: false, port: 0, clients: 0, tools: TOOL_NAMES });
    }
  };
}

module.exports = {
  DEFAULT_MCP_PORT,
  DEFAULT_PATH,
  MCP_PROTOCOL_VERSION,
  TOOLS,
  TOOL_NAMES,
  createMcpServer,
  normalizeUpstreams
};
