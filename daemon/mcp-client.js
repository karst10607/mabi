/**
 * AuraPet daemon - upstream MCP client face (issue #13 / #32).
 *
 * The daemon is an MCP *client* for servers the user already runs:
 * Obsidian (Local REST API / mcp-obsidian), Joplin (built-in `POST /mcp` or a
 * community stdio server), Notion (official MCP) and Jira (official or community
 * stdio / HTTP server). Two transports:
 *
 *   - streamable-http: `@modelcontextprotocol/sdk` StreamableHTTPClientTransport
 *   - stdio:           `@modelcontextprotocol/sdk` StdioClientTransport
 *
 * Tool names exposed internally are namespaced `<server>.<tool>`; the client
 * only declares `tools` (no sampling / roots passthrough). Auth tokens live in
 * the 0600 daemon config and are never written to logs, WS payloads or status
 * replies - `redact()` scrubs them (and `?token=` query strings) from errors.
 *
 * Reconnects use exponential backoff (default 1s..30s). `reload()` diffs the
 * `mcpUpstreams` config so a settings change reconnects only what changed.
 */
'use strict';

const DEFAULT_BACKOFF = { initial: 1000, max: 30000, factor: 2 };
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const DEFAULT_LIST_TIMEOUT_MS = 8000;
const DEFAULT_CALL_TIMEOUT_MS = 30000;
const DEFAULT_SEARCH_BUDGET_MS = 4500;
const MAX_SEARCH_RESULTS = 50;
const MAX_NAME = 32;
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const UPSTREAM_STATES = ['configured', 'connecting', 'ready', 'error', 'stopped'];
const SECRET_KEY_PATTERN = /token|secret|passw|api[-_]?key|bearer/i;

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function packageVersion() {
  try {
    return require('../package.json').version;
  } catch {
    return '0.0.0';
  }
}

/**
 * Normalise the `mcpUpstreams` config into connection descriptors.
 * Invalid entries are dropped; duplicate names keep the first entry.
 *
 * @param {unknown} raw
 * @returns {Array<object>}
 */
function normalizeUpstreams(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name || name.length > MAX_NAME || !NAME_PATTERN.test(name) || seen.has(name)) continue;

    const transport = entry.transport === 'stdio' ? 'stdio' : 'streamable-http';
    if (transport === 'stdio') {
      const command = typeof entry.command === 'string' ? entry.command.trim() : '';
      if (!command) continue;
      const args = Array.isArray(entry.args)
        ? entry.args.filter((arg) => typeof arg === 'string')
        : [];
      const env = {};
      if (isPlainObject(entry.env)) {
        for (const [key, value] of Object.entries(entry.env)) {
          if (typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = value;
        }
      }
      seen.add(name);
      out.push({ name, transport, command, args, env });
      continue;
    }

    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    if (!url) continue;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    // Loopback may stay plain HTTP; anything else must be HTTPS.
    if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) continue;

    const token = typeof entry.token === 'string' ? entry.token : '';
    const tokenIn = entry.tokenIn === 'query' ? 'query' : 'header';
    seen.add(name);
    out.push({ name, transport, url, token, tokenIn });
  }
  return out;
}

/** Remove credentials from status/log strings. */
function createRedactor(entries = []) {
  const secrets = new Set();
  for (const entry of entries) {
    if (typeof entry.token === 'string' && entry.token.length >= 4) secrets.add(entry.token);
    if (isPlainObject(entry.env)) {
      for (const [key, value] of Object.entries(entry.env)) {
        if (typeof value === 'string' && value.length >= 4 && SECRET_KEY_PATTERN.test(key)) secrets.add(value);
      }
    }
  }
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  return function redact(value) {
    let text = String(value ?? '');
    for (const secret of ordered) {
      if (text.includes(secret)) text = text.split(secret).join('<redacted>');
    }
    return text.replace(/([?&]token=)[^&\s"'<>]+/gi, '$1<redacted>');
  };
}

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), Math.max(1, ms));
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function pickSearchTool(tools) {
  if (!Array.isArray(tools)) return null;
  const patterns = [/^search$/i, /search/i, /find/i, /query/i, /jira_search/i, /issues/i];
  for (const pattern of patterns) {
    const hit = tools.find((tool) => tool && typeof tool.name === 'string' && pattern.test(tool.name));
    if (hit) return hit;
  }
  return null;
}

function searchArgumentName(tool) {
  const props = tool?.inputSchema?.properties;
  if (!props || typeof props !== 'object') return 'query';
  if (Object.hasOwn(props, 'jql')) return 'jql';
  if (Object.hasOwn(props, 'query')) return 'query';
  if (Object.hasOwn(props, 'q')) return 'q';
  if (Object.hasOwn(props, 'text')) return 'text';
  if (Object.hasOwn(props, 'search')) return 'search';
  return 'query';
}

function buildSearchArguments(tool, query, limit) {
  const argName = searchArgumentName(tool);
  let val = query;
  if (argName === 'jql' && query && !query.includes('=') && !query.includes('~')) {
    val = `text ~ "${query.replace(/"/g, '\\"')}"`;
  }
  const args = { [argName]: val };
  const props = tool?.inputSchema?.properties;
  if (props && typeof props === 'object') {
    if (Object.hasOwn(props, 'limit')) args.limit = limit;
    if (Object.hasOwn(props, 'maxResults')) args.maxResults = limit;
  }
  return args;
}

function resultText(result) {
  if (!result || typeof result !== 'object') return '';
  if (Array.isArray(result.content)) {
    const text = result.content
      .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n');
    if (text) return text;
  }
  if (result.structuredContent !== undefined) {
    try {
      return JSON.stringify(result.structuredContent);
    } catch {
      return '';
    }
  }
  return '';
}

function extractItems(text) {
  if (typeof text !== 'string') return [];
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* plain text */
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.results)
      ? parsed.results
      : Array.isArray(parsed?.notes)
        ? parsed.notes
        : Array.isArray(parsed?.items)
          ? parsed.items
          : Array.isArray(parsed?.issues)
            ? parsed.issues
            : null;
  if (!list) {
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 240);
    return snippet ? [{ title: '', snippet }] : [];
  }
  return list
    .filter((item) => isPlainObject(item))
    .map((item) => {
      const key = typeof item.key === 'string' ? item.key : '';
      const fields = isPlainObject(item.fields) ? item.fields : {};
      const rawTitle = item.title ?? item.name ?? item.path ?? fields.summary ?? key ?? '';
      const title = key && rawTitle !== key ? `[${key}] ${rawTitle}` : String(rawTitle);

      const statusStr = fields.status?.name ? `(${fields.status.name}) ` : '';
      const rawSnippet = item.snippet ?? item.excerpt ?? item.body ?? item.content ?? item.text ?? fields.description ?? '';
      const snippet = (statusStr + String(rawSnippet))
        .replace(/\s+/g, ' ')
        .slice(0, 240);

      const id = item.id ? String(item.id) : (key || undefined);
      const url = item.url || item.link || item.self || undefined;

      return {
        title,
        snippet,
        ...(id ? { id } : {}),
        ...(url ? { url: String(url) } : {})
      };
    });
}

function createMcpClient(options = {}) {
  const {
    configStore,
    log = console,
    backoff: backoffOptions,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    listTimeoutMs = DEFAULT_LIST_TIMEOUT_MS,
    callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
    searchBudgetMs = DEFAULT_SEARCH_BUDGET_MS,
    onStatus = null
  } = options;
  if (!configStore) throw new TypeError('createMcpClient requires a config store');

  const backoff = { ...DEFAULT_BACKOFF, ...(backoffOptions || {}) };
  const clientInfo = { name: 'aurapet-daemon', version: packageVersion() };
  const records = [];
  let stopped = false;
  let redact = createRedactor();
  let sdk = null;

  function entrySignature(entry) {
    return JSON.stringify(entry);
  }

  function loadEntries() {
    const entries = normalizeUpstreams(configStore.get('mcpUpstreams'));
    redact = createRedactor(entries);
    return entries;
  }

  function serverStatus(record) {
    return {
      name: record.entry.name,
      transport: record.entry.transport,
      state: record.state,
      toolCount: record.tools.length,
      ...(record.error ? { error: record.error } : {})
    };
  }

  function getServers() {
    return records.map(serverStatus);
  }

  function emitStatus() {
    if (typeof onStatus !== 'function') return;
    try {
      onStatus(getServers());
    } catch (error) {
      log.warn(`mcp-client: status listener failed: ${redact(error.message)}`);
    }
  }

  function getTools() {
    const out = [];
    for (const record of records) {
      if (record.state !== 'ready') continue;
      for (const tool of record.tools) {
        out.push({
          name: `${record.entry.name}.${tool.name}`,
          server: record.entry.name,
          description: tool.description || '',
          inputSchema: tool.inputSchema || { type: 'object' }
        });
      }
    }
    return out;
  }

  async function loadSdk() {
    if (sdk) return sdk;
    const [clientModule, httpModule, stdioModule] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js')
    ]);
    sdk = {
      Client: clientModule.Client,
      StreamableHTTPClientTransport: httpModule.StreamableHTTPClientTransport,
      StdioClientTransport: stdioModule.StdioClientTransport
    };
    return sdk;
  }

  async function createTransport(entry) {
    const mods = await loadSdk();
    if (entry.transport === 'stdio') {
      return new mods.StdioClientTransport({
        command: entry.command,
        args: entry.args,
        env: entry.env,
        // Never inherit upstream stderr into our logs: it may contain secrets.
        stderr: 'ignore'
      });
    }
    let url = entry.url;
    const headers = {};
    if (entry.token) {
      if (entry.tokenIn === 'query') {
        const parsed = new URL(url);
        parsed.searchParams.set('token', entry.token);
        url = parsed.toString();
      } else {
        headers.Authorization = `Bearer ${entry.token}`;
      }
    }
    return new mods.StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers }
    });
  }

  function clearTimer(record) {
    if (record.timer) {
      clearTimeout(record.timer);
      record.timer = null;
    }
  }

  function backoffDelay(record) {
    const delay = Math.min(backoff.max, backoff.initial * Math.pow(backoff.factor, record.attempt));
    record.attempt += 1;
    return Math.max(backoff.initial, delay);
  }

  function scheduleReconnect(record) {
    if (stopped || record.closing || record.timer) return;
    const delay = backoffDelay(record);
    record.timer = setTimeout(() => {
      record.timer = null;
      connect(record);
    }, delay);
    if (typeof record.timer.unref === 'function') record.timer.unref();
  }

  async function closeRecord(record) {
    record.closing = true;
    clearTimer(record);
    const client = record.client;
    record.client = null;
    record.tools = [];
    if (client) {
      try {
        await client.close();
      } catch {
        /* already closed */
      }
    }
    record.closing = false;
  }

  function connect(record) {
    if (stopped) return Promise.resolve();
    if (record.connectPromise) return record.connectPromise;
    if (record.state === 'ready') return Promise.resolve();

    record.state = 'connecting';
    record.error = '';
    emitStatus();

    const generation = record.generation;
    let pendingClient = null;
    const attempt = (async () => {
      const mods = await loadSdk();
      const transport = await createTransport(record.entry);
      const client = new mods.Client(clientInfo, { capabilities: {} });
      pendingClient = client;
      await withTimeout(client.connect(transport), connectTimeoutMs, 'connect timed out');
      const listed = await withTimeout(
        client.listTools(undefined, { timeout: listTimeoutMs }),
        listTimeoutMs,
        'tools/list timed out'
      );
      if (stopped || record.closing || record.generation !== generation) {
        try {
          await client.close();
        } catch {
          /* shutting down or superseded by reload */
        }
        pendingClient = null;
        return;
      }
      record.client = client;
      record.transport = transport;
      pendingClient = null;
      record.tools = (listed.tools || [])
        .filter((tool) => tool && typeof tool.name === 'string')
        .map((tool) => ({
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : '',
          inputSchema: isPlainObject(tool.inputSchema) ? tool.inputSchema : { type: 'object' }
        }));
      record.state = 'ready';
      record.error = '';
      record.attempt = 0;
      log.info(`mcp-client: ${record.entry.name} ready (${record.tools.length} tools)`);

      client.onclose = () => {
        if (stopped || record.closing || record.client !== client) return;
        record.client = null;
        record.tools = [];
        record.state = 'error';
        record.error = 'connection closed';
        emitStatus();
        scheduleReconnect(record);
      };
      client.onerror = (error) => {
        if (stopped || record.closing) return;
        log.warn(`mcp-client: ${record.entry.name}: ${redact(error?.message || error)}`);
      };
      emitStatus();
    })().catch(async (error) => {
      const superseded = record.generation !== generation;
      if (pendingClient) {
        try {
          await pendingClient.close();
        } catch {
          /* already closed */
        }
        pendingClient = null;
      }
      if (superseded) return;
      record.tools = [];
      record.state = 'error';
      record.error = redact(error?.message || error).slice(0, 240);
      if (record.client) await closeRecord(record);
      log.warn(`mcp-client: ${record.entry.name} unavailable: ${record.error}`);
      emitStatus();
      scheduleReconnect(record);
    }).finally(() => {
      record.connectPromise = null;
      if (!stopped && record.state === 'ready') {
        // A healthy connection needs no timer.
        clearTimer(record);
      }
    });

    record.connectPromise = attempt;
    return attempt;
  }

  function start() {
    stopped = false;
    const entries = loadEntries();
    for (const record of records) closeRecord(record);
    records.length = 0;
    for (const entry of entries) {
      const record = {
        entry,
        signature: entrySignature(entry),
        state: 'configured',
        tools: [],
        error: '',
        attempt: 0,
        timer: null,
        client: null,
        transport: null,
        connectPromise: null,
        closing: false,
        generation: 0
      };
      records.push(record);
      connect(record);
    }
    emitStatus();
    return Promise.resolve(getServers());
  }

  async function reload() {
    const entries = loadEntries();
    const wanted = new Map(entries.map((entry) => [entry.name, entry]));
    const next = [];
    for (const record of records) {
      const entry = wanted.get(record.entry.name);
      if (!entry) {
        record.generation += 1;
        await closeRecord(record);
        record.state = 'stopped';
        continue;
      }
      if (entrySignature(entry) !== record.signature) {
        record.generation += 1;
        await closeRecord(record);
        record.entry = entry;
        record.signature = entrySignature(entry);
        record.state = 'configured';
        record.error = '';
        record.attempt = 0;
        next.push(record);
        connect(record);
        continue;
      }
      next.push(record);
    }
    const known = new Set(next.map((record) => record.entry.name));
    for (const entry of entries) {
      if (known.has(entry.name)) continue;
      const record = {
        entry,
        signature: entrySignature(entry),
        state: 'configured',
        tools: [],
        error: '',
        attempt: 0,
        timer: null,
        client: null,
        transport: null,
        connectPromise: null,
        closing: false,
        generation: 0
      };
      next.push(record);
      connect(record);
    }
    records.length = 0;
    records.push(...next);
    emitStatus();
    return getServers();
  }

  async function callTool(name, args = {}) {
    const dot = typeof name === 'string' ? name.indexOf('.') : -1;
    if (dot <= 0 || dot === name.length - 1) throw new Error(`tool name must be <server>.<tool>: ${name}`);
    const server = name.slice(0, dot);
    const tool = name.slice(dot + 1);
    const record = records.find((entry) => entry.entry.name === server);
    if (!record) throw new Error(`unknown upstream server: ${server}`);
    if (record.state !== 'ready' || !record.client) throw new Error(`upstream server ${server} is ${record.state}`);
    try {
      return await record.client.callTool(
        { name: tool, arguments: isPlainObject(args) ? args : {} },
        undefined,
        { timeout: callTimeoutMs }
      );
    } catch (error) {
      throw new Error(redact(error?.message || error));
    }
  }

  async function searchOne(record, query, limit, deadline) {
    const remaining = () => Math.max(250, deadline - Date.now());
    if (record.state !== 'ready') {
      if (deadline - Date.now() <= 0) return { name: record.entry.name, state: 'timeout', error: 'deadline exceeded' };
      await withTimeout(connect(record), remaining(), 'connect timed out').catch(() => null);
    }
    if (record.state !== 'ready' || !record.client) {
      return { name: record.entry.name, state: record.state, error: record.error || 'not connected' };
    }
    const tool = pickSearchTool(record.tools);
    if (!tool) return { name: record.entry.name, state: 'error', error: 'no search-like tool' };
    try {
      const result = await withTimeout(
        record.client.callTool(
          { name: tool.name, arguments: buildSearchArguments(tool, query, limit) },
          undefined,
          { timeout: remaining() }
        ),
        remaining(),
        'tools/call timed out'
      );
      return {
        name: record.entry.name,
        state: 'ok',
        tool: tool.name,
        items: extractItems(resultText(result))
      };
    } catch (error) {
      return {
        name: record.entry.name,
        state: 'error',
        tool: tool.name,
        error: redact(error?.message || error)
      };
    }
  }

  async function search(query, searchOptions = {}) {
    const { limit: requestedLimit, sources: sourceFilter = null, budgetMs = searchBudgetMs } = searchOptions;
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(MAX_SEARCH_RESULTS, Math.max(1, requestedLimit))
      : 10;
    const wanted = Array.isArray(sourceFilter)
      ? new Set(sourceFilter.filter((name) => typeof name === 'string'))
      : null;
    const targets = records
      .filter((record) => !wanted || wanted.has(record.entry.name))
      .slice(0, 10);

    if (targets.length === 0) {
      return {
        query,
        results: [],
        sources: [],
        note: 'no upstream MCP servers configured (settings key mcpUpstreams)'
      };
    }

    const deadline = Date.now() + Math.max(500, budgetMs);
    const settled = await Promise.all(targets.map((record) => searchOne(record, query, limit, deadline)));
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
        results.push({ source: entry.name, ...item });
      }
    }
    return { query, results, sources };
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    for (const record of records) {
      clearTimer(record);
      await closeRecord(record);
      record.state = 'stopped';
    }
    emitStatus();
  }

  return {
    start,
    stop,
    reload,
    getServers,
    getTools,
    callTool,
    search,
    redact(value) {
      return redact(value);
    }
  };
}

module.exports = {
  DEFAULT_BACKOFF,
  DEFAULT_SEARCH_BUDGET_MS,
  UPSTREAM_STATES,
  createMcpClient,
  createRedactor,
  normalizeUpstreams,
  pickSearchTool,
  extractItems
};
