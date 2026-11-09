#!/usr/bin/env node
// End-to-end smoke test for the MCP server face (issue #14).
//
// Starts the real bridge + MCP server on ephemeral loopback ports, connects a
// fake body (WS) and a fake ui (WS), then drives MCP over Streamable HTTP:
// initialize, tools/list, pet.say (bubble reaches body), pet.mood.get,
// pet.ask ticket, notes.search aggregation against a fake upstream, plus
// token / origin / host rejection.
//
//   node tools/mcp/smoke-test.mjs
//
// Zero external services: the upstream note server and the body are stubs.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';

const require = createRequire(import.meta.url);
const { createConfigStore } = require('../../daemon/config-store.js');
const { createBridgeServer } = require('../../daemon/bridge-server.js');
const { createMcpServer, TOOL_NAMES } = require('../../daemon/mcp-server.js');
const { createMcpClient } = require('../../daemon/mcp-client.js');
const { createHonokaEventClient, toBubble, normalizeHonokaEvents } = require('../../daemon/honoka-events.js');

const quiet = { info() {}, warn() {} };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurapet-mcp-smoke-'));
const store = createConfigStore({ dir: root });

let pass = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`ok - ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failures.push(name);
    console.log(`not ok - ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function assertEqual(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitFor(predicate, timeoutMs = 4000, stepMs = 50) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

function wsClient(port, hello) {
  const events = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const ready = new Promise((resolve, reject) => {
    socket.on('open', () => socket.send(JSON.stringify({ v: 1, id: 1, t: 'hello', ...hello })));
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      events.push(message);
      if (message.t === 'state.sync') resolve();
    });
    socket.on('error', reject);
  });
  return { socket, events, ready };
}

async function rawRequest({ method = 'POST', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: mcpServer.port(),
      path: mcpServer.path,
      method,
      headers: { 'Content-Length': Buffer.byteLength(body), ...headers }
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

let bridge = null;
let mcpServer = null;
let mcpClient = null;
let upstream = null;
let bodyClient = null;
let uiClient = null;
let honokaEventClient = null;
let honokaEventsServer = null;
const mcpLogs = [];

async function rpc(payload, { token = mcpServer.token, origin, session } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream'
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  if (session) headers['Mcp-Session-Id'] = session;
  const res = await fetch(`http://127.0.0.1:${mcpServer.port()}${mcpServer.path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non JSON error page */
  }
  return { status: res.status, json, text, session: res.headers.get('mcp-session-id') };
}

function startFakeUpstream() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        if (req.method !== 'POST') {
          res.writeHead(405).end();
          return;
        }
        const message = JSON.parse(raw);
        if (message.method === 'initialize') {
          const body = JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'fake-notes', version: '0.0.0' }
            }
          });
          res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'up-session-1' });
          res.end(body);
          return;
        }
        if (message.method === 'notifications/initialized') {
          res.writeHead(202).end();
          return;
        }
        if (message.method === 'tools/list') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: [{
                name: 'search_notes',
                description: 'fake notes search',
                inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
              }]
            }
          }));
          return;
        }
        if (message.method === 'tools/call') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify([
                  { title: 'Cat notes', snippet: `hit for ${message.params.arguments.query}`, url: 'http://notes/cat' }
                ])
              }]
            }
          }));
          return;
        }
        res.writeHead(404).end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function writeFakeStdioServer() {
  const script = path.join(root, 'fake-stdio-server.cjs');
  fs.writeFileSync(script, `'use strict';
const readline = require('readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const hasId = Object.hasOwn(message, 'id');
  switch (message.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-stdio', version: '0.0.0' }
      } });
      return;
    case 'notifications/initialized':
      return;
    case 'tools/list':
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [{
        name: 'search_notes',
        description: 'stdio notes search',
        inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] }
      }] } });
      return;
    case 'tools/call':
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{
        type: 'text',
        text: JSON.stringify([{ title: 'Stdio note', snippet: 'hit ' + (message.params.arguments.query || '') }])
      }] } });
      return;
    default:
      if (hasId) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
  }
});
process.stdin.on('end', () => process.exit(0));
`);
  return script;
}

function writeFakeJiraServer() {
  const script = path.join(root, 'fake-jira-server.cjs');
  fs.writeFileSync(script, `'use strict';
const readline = require('readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const hasId = Object.hasOwn(message, 'id');
  switch (message.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'jira-mock', version: '1.0.0' }
      } });
      return;
    case 'notifications/initialized':
      return;
    case 'tools/list':
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [
        {
          name: 'jira_search',
          description: 'Search Jira issues using JQL or text query',
          inputSchema: { type: 'object', properties: { jql: { type: 'string' }, maxResults: { type: 'integer' } }, required: ['jql'] }
        },
        {
          name: 'get_issue',
          description: 'Retrieve a Jira issue by key or id',
          inputSchema: { type: 'object', properties: { issueIdOrKey: { type: 'string' } }, required: ['issueIdOrKey'] }
        }
      ] } });
      return;
    case 'tools/call':
      if (message.params?.name === 'jira_search') {
        send({ jsonrpc: '2.0', id: message.id, result: { content: [{
          type: 'text',
          text: JSON.stringify({
            issues: [
              {
                id: '2001',
                key: 'PROJ-99',
                self: 'https://jira.example.com/browse/PROJ-99',
                fields: {
                  summary: 'Sprint item for cat pet',
                  status: { name: 'In Progress' },
                  description: 'Implement Jira integration'
                }
              }
            ]
          })
        }] } });
        return;
      }
      if (message.params?.name === 'get_issue') {
        send({ jsonrpc: '2.0', id: message.id, result: { content: [{
          type: 'text',
          text: JSON.stringify({
            id: '2001',
            key: message.params?.arguments?.issueIdOrKey || 'PROJ-99',
            fields: { summary: 'Issue detail' }
          })
        }] } });
        return;
      }
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'tool not found' } });
      return;
    default:
      if (hasId) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
  }
});
process.stdin.on('end', () => process.exit(0));
`);
  return script;
}

function writeFakeHonokaServer() {
  const script = path.join(root, 'fake-honoka-server.cjs');
  fs.writeFileSync(script, `'use strict';
const readline = require('readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const hasId = Object.hasOwn(message, 'id');
  switch (message.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'honoka-publish', version: '1.11.5' }
      } });
      return;
    case 'notifications/initialized':
      return;
    case 'tools/list':
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [
        { name: 'save_url', description: 'Ingest a URL into Joplin', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
        { name: 'download_video', description: 'Download a video URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
        { name: 'search_notes', description: 'Search Joplin notes', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
        { name: 'list_inbox', description: 'List queued inbox files', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
        { name: 'get_job_status', description: 'Poll an ingestion ticket', inputSchema: { type: 'object', properties: { ticketId: { type: 'string' } }, required: ['ticketId'] } }
      ] } });
      return;
    case 'tools/call': {
      const name = message.params && message.params.name;
      const args = (message.params && message.params.arguments) || {};
      let payload;
      if (name === 'search_notes') {
        payload = { ok: true, count: 1, items: [{ id: 'joplin_note_1', title: 'Honoka Joplin note', parent_id: 'nb_honoka', updated_time: 1730000000000 }], hasMore: false };
      } else if (name === 'save_url') {
        payload = { ok: true, ticketId: 'job_mock_1', status: 'running', type: 'save_url', url: args.url };
      } else if (name === 'get_job_status') {
        payload = { ok: true, ticketId: args.ticketId, status: 'done', result: { ok: true, noteId: 'joplin_note_2' } };
      } else if (name === 'list_inbox') {
        payload = { ok: true, count: 0, items: [] };
      } else {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'tool not found' } });
        return;
      }
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
      return;
    }
    default:
      if (hasId) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
  }
});
process.stdin.on('end', () => process.exit(0));
`);
  return script;
}

function startFakeHonokaEvents(expectedToken) {
  const state = { connections: 0, lastEventIds: [], push: null, closeActive: null };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/events') {
      res.writeHead(404).end();
      return;
    }
    if (url.searchParams.get('token') !== expectedToken) {
      res.writeHead(401).end();
      return;
    }
    state.connections += 1;
    state.lastEventIds.push(req.headers['last-event-id'] || '');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('retry: 200\n\n');
    let seq = 0;
    state.push = (event) => {
      seq += 1;
      const id = String(1000 + seq);
      res.write(`id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify({ id, ...event })}\n\n`);
      return id;
    };
    state.closeActive = () => res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/events`,
        state,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

async function main() {
  bridge = createBridgeServer({ configStore: store, port: 0, brainVersion: 'smoke', log: quiet });
  await bridge.start();
  mcpClient = createMcpClient({
    configStore: store,
    log: { info: (m) => mcpLogs.push(String(m)), warn: (m) => mcpLogs.push(String(m)) },
    backoff: { initial: 100, max: 1000, factor: 2 },
    connectTimeoutMs: 4000,
    listTimeoutMs: 4000,
    callTimeoutMs: 4000,
    onStatus: (servers) => bridge.setUpstreamStatus(servers)
  });
  bridge.attachMcpClient(mcpClient);
  await mcpClient.start();
  mcpServer = createMcpServer({ configStore: store, bridge, mcpClient, port: 0, log: quiet });
  await mcpServer.start();
  console.log(`# bridge ws://127.0.0.1:${bridge.port} · mcp http://127.0.0.1:${mcpServer.port()}${mcpServer.path}`);

  bodyClient = wsClient(bridge.port, {
    role: 'body', name: 'smoke-body', version: '0.0.0', protocol: 1, token: bridge.token
  });
  await bodyClient.ready;
  check('body handshake completes', bridge.isBodyConnected());

  uiClient = wsClient(bridge.port, {
    role: 'ui', name: 'smoke-ui', version: '0.0.0', protocol: 1, token: bridge.token
  });
  await uiClient.ready;
  await waitFor(() => uiClient.events.some((message) => message.t === 'mcp.server.status'));
  const serverStatus = uiClient.events.find((message) => message.t === 'mcp.server.status');
  check('ui receives mcp.server.status', Boolean(serverStatus && serverStatus.enabled), `port=${serverStatus?.port}`);

  // --- auth / origin / host -------------------------------------------
  const noToken = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { token: '' });
  check('missing bearer token rejected', noToken.status === 401, `HTTP ${noToken.status}`);
  const badToken = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { token: 'f'.repeat(64) });
  check('wrong bearer token rejected', badToken.status === 401, `HTTP ${badToken.status}`);

  const evilOrigin = await rpc(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { origin: 'http://evil.example' }
  );
  check('non-loopback Origin rejected', evilOrigin.status === 403, `HTTP ${evilOrigin.status}`);

  const evilHost = await rawRequest({
    headers: { Host: 'evil.example', Authorization: `Bearer ${mcpServer.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  });
  check('non-loopback Host rejected', evilHost.status === 403, `HTTP ${evilHost.status}`);

  // --- initialize / tools/list ---------------------------------------
  const init = await rpc(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke-client', version: '0.0.0' }
      }
    },
    { origin: 'http://localhost:6274' }
  );
  check('initialize accepted with loopback Origin', init.status === 200 && init.json?.result?.protocolVersion === '2025-06-18', `HTTP ${init.status}`);
  check('Mcp-Session-Id issued', typeof init.session === 'string' && init.session.length >= 16);
  assertEqual('capabilities declare tools only', Object.keys(init.json?.result?.capabilities ?? {}), ['tools']);
  const session = init.session;

  const unknownSession = await rpc(
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { session: 'does-not-exist' }
  );
  check('unknown session rejected', unknownSession.status === 404, `HTTP ${unknownSession.status}`);

  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { session });
  assertEqual('tools/list returns the declared tools', list.json?.result?.tools?.map((tool) => tool.name), TOOL_NAMES);
  check('every tool has an input schema', (list.json?.result?.tools ?? []).every((tool) => tool.inputSchema?.type === 'object'));

  const getMethod = await rawRequest({
    method: 'GET',
    headers: { Authorization: `Bearer ${mcpServer.token}` }
  });
  check('GET without SSE support returns 405', getMethod.status === 405, `HTTP ${getMethod.status}`);

  // --- pet.say --------------------------------------------------------
  const say = await rpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'pet.say', arguments: { text: '喵～ MCP 測試', emotion: 'happy', ttlMs: 3000 } }
  }, { session });
  check('pet.say reports delivered', say.json?.result?.structuredContent?.delivered === true);
  await waitFor(() => bodyClient.events.some((message) => message.t === 'say'));
  const bubble = bodyClient.events.find((message) => message.t === 'say');
  check('body receives the say bubble', bubble?.text === '喵～ MCP 測試', `text=${JSON.stringify(bubble?.text)}`);

  // --- pet.mood.get ---------------------------------------------------
  const mood = await rpc({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'pet.mood.get', arguments: {} }
  }, { session });
  const moodState = mood.json?.result?.structuredContent;
  check('pet.mood.get returns brain state', moodState?.mode === 'pet' && moodState?.bodyConnected === true, `mode=${moodState?.mode}`);

  // --- system.htop_summary --------------------------------------------
  const htop = await rpc({
    jsonrpc: '2.0',
    id: 41,
    method: 'tools/call',
    params: { name: 'system.htop_summary', arguments: { topCount: 5 } }
  }, { session });
  const htopData = htop.json?.result?.structuredContent;
  check('system.htop_summary returns system stats', typeof htopData?.cpu?.overall === 'number' && typeof htopData?.memory?.percent === 'number' && Array.isArray(htopData?.processes), `cpu=${htopData?.cpu?.overall}% mem=${htopData?.memory?.percent}%`);

  // --- pet.ask ticket -------------------------------------------------
  const asked = await rpc({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'pet.ask', arguments: { text: '你好' } }
  }, { session });
  const ticket = asked.json?.result?.structuredContent?.ticket;
  const askState = asked.json?.result?.structuredContent?.state;
  check('pet.ask returns a pending ticket immediately', askState === 'pending' && typeof ticket === 'string', `ticket=${ticket}`);

  let polled = null;
  for (let i = 0; i < 40; i += 1) {
    const poll = await rpc({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'pet.ask.result', arguments: { ticket } }
    }, { session });
    polled = poll.json?.result?.structuredContent;
    if (polled && polled.state !== 'pending') break;
    await sleep(200);
  }
  check('pet.ask ticket resolves to an answer', polled?.state === 'done' && polled.answer.length > 0, `state=${polled?.state} answer=${polled?.answer?.length ?? 0} chars`);

  // --- notes.search: no upstream, then aggregation --------------------
  const emptySearch = await rpc({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'notes.search', arguments: { query: 'cat' } }
  }, { session });
  const emptyPayload = emptySearch.json?.result?.structuredContent;
  check('notes.search without upstreams is explicit', emptyPayload?.results?.length === 0 && /no upstream/i.test(emptyPayload?.note || ''));

  upstream = await startFakeUpstream();
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/mcp`;
  const stdioScript = writeFakeStdioServer();
  const jiraScript = writeFakeJiraServer();
  const honokaScript = writeFakeHonokaServer();
  const upstreamToken = 'smoke-upstream-token-value';
  const jiraSecretToken = 'super-secret-jira-token-9999';
  const honokaSecretToken = 'honoka-joplin-token-secret-777';
  store.patch({
    mcpUpstreams: [
      { name: 'fake-notes', url: upstreamUrl, transport: 'streamable-http', token: upstreamToken },
      { name: 'stdio-notes', transport: 'stdio', command: process.execPath, args: [stdioScript] },
      {
        name: 'jira',
        transport: 'stdio',
        command: process.execPath,
        args: [jiraScript],
        env: {
          JIRA_URL: 'https://test.atlassian.net',
          JIRA_EMAIL: 'user@test.com',
          JIRA_API_TOKEN: jiraSecretToken
        }
      },
      {
        name: 'honoka',
        transport: 'stdio',
        command: process.execPath,
        args: [honokaScript],
        env: {
          HONOKA_DIR: path.join(root, 'honoka-docs'),
          HONOKA_JOPLIN_TOKEN: honokaSecretToken
        }
      }
    ]
  });
  await mcpClient.reload();
  await waitFor(() => mcpClient.getServers().every((server) => server.state === 'ready'), 8000);
  const upstreamStatus = mcpClient.getServers();
  check('http upstream reaches ready', upstreamStatus.find((s) => s.name === 'fake-notes')?.state === 'ready');
  check('stdio upstream reaches ready', upstreamStatus.find((s) => s.name === 'stdio-notes')?.state === 'ready');
  check('jira upstream reaches ready', upstreamStatus.find((s) => s.name === 'jira')?.state === 'ready');
  check('status reports real tool counts', upstreamStatus.find((s) => s.name === 'jira')?.toolCount === 2, JSON.stringify(upstreamStatus.map((s) => ({ name: s.name, tools: s.toolCount }))));
  check('honoka upstream reaches ready with its tools', upstreamStatus.find((s) => s.name === 'honoka')?.state === 'ready' && upstreamStatus.find((s) => s.name === 'honoka')?.toolCount === 5);

  const namespaced = mcpClient.getTools().map((tool) => tool.name);
  check('tools are namespaced <server>.<tool>', namespaced.includes('fake-notes.search_notes') && namespaced.includes('stdio-notes.search_notes') && namespaced.includes('jira.jira_search') && namespaced.includes('jira.get_issue'), namespaced.join(', '));
  check('honoka tools are namespaced too', namespaced.includes('honoka.search_notes') && namespaced.includes('honoka.save_url') && namespaced.includes('honoka.get_job_status'));
  const directCall = await mcpClient.callTool('fake-notes.search_notes', { query: 'cat' });
  check('namespaced tools/call succeeds', directCall?.content?.[0]?.type === 'text');
  const directJiraCall = await mcpClient.callTool('jira.jira_search', { jql: 'project = PROJ' });
  check('namespaced jira tools/call succeeds', directJiraCall?.content?.[0]?.type === 'text');
  const honokaTicket = await mcpClient.callTool('honoka.save_url', { url: 'https://example.com/honoka' });
  check('honoka save_url returns a job ticket', honokaTicket?.content?.[0]?.text?.includes('job_mock_1'));
  const honokaJob = await mcpClient.callTool('honoka.get_job_status', { ticketId: 'job_mock_1' });
  check('honoka get_job_status reaches done', honokaJob?.content?.[0]?.text?.includes('"done"'));

  await waitFor(() => uiClient.events.some((message) => message.t === 'mcp.status' &&
    (message.servers || []).some((server) => server.name === 'fake-notes' && server.state === 'ready')));
  const liveStatus = uiClient.events.filter((message) => message.t === 'mcp.status').pop();
  check('ui receives live mcp.status', Boolean(liveStatus?.servers?.find((s) => s.name === 'stdio-notes' && s.state === 'ready')));
  check('mcp.status carries toolCount', liveStatus?.servers?.every((server) => Number.isInteger(server.toolCount)));

  uiClient.socket.send(JSON.stringify({ v: 1, id: 99, t: 'settings.get' }));
  await waitFor(() => uiClient.events.some((message) => message.id === 99 && 'ok' in message));
  const settingsReply = uiClient.events.find((message) => message.id === 99 && 'ok' in message);
  check('settings.get redacts upstream tokens', !JSON.stringify(settingsReply).includes(upstreamToken));
  check('settings.get redacts jira secret tokens', !JSON.stringify(settingsReply).includes(jiraSecretToken));
  check('settings.get redacts honoka env secrets', !JSON.stringify(settingsReply).includes(honokaSecretToken));
  check('settings.get keeps an auth marker', settingsReply?.patch?.mcpUpstreams?.[0]?.auth === 'configured');
  check('status and logs contain no token', !JSON.stringify(upstreamStatus).includes(upstreamToken) && !JSON.stringify(upstreamStatus).includes(jiraSecretToken) && !JSON.stringify(upstreamStatus).includes(honokaSecretToken) && !mcpLogs.join('\n').includes(upstreamToken) && !mcpLogs.join('\n').includes(jiraSecretToken) && !mcpLogs.join('\n').includes(honokaSecretToken));

  const search = await rpc({
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: { name: 'notes.search', arguments: { query: 'cat', limit: 5 } }
  }, { session });
  const searchPayload = search.json?.result?.structuredContent;
  check('notes.search aggregates upstream results', searchPayload?.results?.length === 4, `hits=${searchPayload?.results?.length}`);
  check('notes.search extracted jira issue correctly', searchPayload?.results?.some((r) => r.source === 'jira' && r.title.includes('PROJ-99') && r.snippet.includes('In Progress')));
  check('notes.search reports all 4 upstreams healthy', (searchPayload?.sources ?? []).filter((s) => s.state === 'ok').length === 4, JSON.stringify(searchPayload?.sources));
  check('notes.search surfaces honoka notes', searchPayload?.results?.some((r) => r.source === 'honoka' && r.title === 'Honoka Joplin note' && r.id === 'joplin_note_1'));

  const honokaOnly = await rpc({
    jsonrpc: '2.0',
    id: 81,
    method: 'tools/call',
    params: { name: 'notes.search', arguments: { query: '貓', sources: ['honoka'], limit: 5 } }
  }, { session });
  const honokaOnlyPayload = honokaOnly.json?.result?.structuredContent;
  check('notes.search source filter targets honoka', honokaOnlyPayload?.results?.length === 1 && honokaOnlyPayload.results[0].source === 'honoka', JSON.stringify(honokaOnlyPayload?.results));

  // --- pet AI note question routes through honoka search ---------------
  const askedNotes = await rpc({
    jsonrpc: '2.0',
    id: 82,
    method: 'tools/call',
    params: { name: 'pet.ask', arguments: { text: '我存過哪些筆記？' } }
  }, { session });
  const notesTicket = askedNotes.json?.result?.structuredContent?.ticket;
  check('pet.ask note question returns a ticket', typeof notesTicket === 'string');
  let notesPolled = null;
  for (let i = 0; i < 40; i += 1) {
    const poll = await rpc({
      jsonrpc: '2.0',
      id: 83,
      method: 'tools/call',
      params: { name: 'pet.ask.result', arguments: { ticket: notesTicket } }
    }, { session });
    notesPolled = poll.json?.result?.structuredContent;
    if (notesPolled && notesPolled.state !== 'pending') break;
    await sleep(200);
  }
  check('pet AI answers the notes question', notesPolled?.state === 'done' && notesPolled.answer.length > 0, `state=${notesPolled?.state}`);
  check('pet AI note search includes honoka hits', (notesPolled?.context?.hits ?? 0) >= 1 && (notesPolled?.context?.sources ?? []).includes('honoka'), JSON.stringify(notesPolled?.context));

  // --- honoka events SSE → body bubbles (issue #53) ----------------
  check('honokaEvents config rejects non-loopback http', normalizeHonokaEvents({ url: 'http://example.com/events' }) === null);
  check('honokaEvents config accepts loopback http', normalizeHonokaEvents({ url: 'http://127.0.0.1:44124/events', token: 'abc' })?.token === 'abc');
  const honokaEventsToken = 'honoka-sse-token-secret-4242';
  honokaEventsServer = await startFakeHonokaEvents(honokaEventsToken);
  store.patch({ honokaEvents: { url: honokaEventsServer.url, token: honokaEventsToken } });
  const progressState = new Map();
  honokaEventClient = createHonokaEventClient({
    configStore: store,
    log: { info: (m) => mcpLogs.push(String(m)), warn: (m) => mcpLogs.push(String(m)) },
    backoff: { initial: 100, max: 500, factor: 2 },
    onEvent: (event) => {
      const bubble = toBubble(event, progressState);
      if (bubble) bridge.say(bubble);
    }
  });
  await honokaEventClient.start();
  await waitFor(() => honokaEventsServer.state.push, 4000);
  check('honoka events client streams after start', honokaEventsServer.state.connections >= 1);

  honokaEventsServer.state.push({ type: 'url_received', url: 'https://youtu.be/e2e', title: 'E2E Clip' });
  await waitFor(() => bodyClient.events.some((m) => m.t === 'say' && String(m.text).includes('收到連結') && String(m.text).includes('E2E Clip')), 4000);
  check('url_received event becomes a body bubble', true);

  honokaEventsServer.state.push({ type: 'download_progress', url: 'https://youtu.be/e2e', progress: 10 });
  await sleep(300);
  check('early download progress is suppressed', !bodyClient.events.some((m) => m.t === 'say' && String(m.text).includes('下載中')));
  honokaEventsServer.state.push({ type: 'download_progress', url: 'https://youtu.be/e2e', progress: 30 });
  await waitFor(() => bodyClient.events.some((m) => String(m.text || '').includes('下載中 25%')), 4000);
  check('progress milestone 25% bubbles once', bodyClient.events.filter((m) => String(m.text || '').includes('下載中 25%')).length === 1);
  honokaEventsServer.state.push({ type: 'download_progress', url: 'https://youtu.be/e2e', progress: 30 });
  await sleep(300);
  check('duplicate progress bucket is suppressed', bodyClient.events.filter((m) => String(m.text || '').includes('下載中 25%')).length === 1);
  honokaEventsServer.state.push({ type: 'download_progress', url: 'https://youtu.be/e2e', progress: 100 });
  await waitFor(() => bodyClient.events.some((m) => String(m.text || '').includes('下載中 100%')), 4000);
  check('progress milestone 100% bubbles', true);

  const noteEventId = honokaEventsServer.state.push({ type: 'note_saved', url: 'https://youtu.be/e2e', title: 'E2E Clip', noteId: 'note_x' });
  await waitFor(() => bodyClient.events.some((m) => String(m.text || '').includes('已存入筆記') && String(m.text).includes('E2E Clip')), 4000);
  check('note_saved event becomes a body bubble', true);

  honokaEventsServer.state.closeActive();
  await waitFor(() => honokaEventsServer.state.connections >= 2, 6000);
  check('reconnect sends Last-Event-ID', honokaEventsServer.state.lastEventIds[1] === noteEventId, `ids=${JSON.stringify(honokaEventsServer.state.lastEventIds)}`);
  honokaEventsServer.state.push({ type: 'error', url: 'https://youtu.be/e2e', error: 'yt-dlp exited 1' });
  await waitFor(() => bodyClient.events.some((m) => String(m.text || '').includes('連結處理失敗')), 4000);
  check('error event becomes a body bubble', true);

  uiClient.socket.send(JSON.stringify({ v: 1, id: 100, t: 'settings.get' }));
  await waitFor(() => uiClient.events.some((m) => m.id === 100 && 'ok' in m));
  const honokaConfigReply = uiClient.events.find((m) => m.id === 100 && 'ok' in m);
  check('settings.get redacts honokaEvents token', !JSON.stringify(honokaConfigReply).includes(honokaEventsToken));
  check('settings.get keeps honokaEvents auth marker', honokaConfigReply?.patch?.honokaEvents?.auth === 'configured');
  check('honoka event logs contain no token', !mcpLogs.join('\n').includes(honokaEventsToken));

  // --- unknown tool ---------------------------------------------------
  const unknown = await rpc({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: 'nope', arguments: {} }
  }, { session });
  check('unknown tool is a JSON-RPC error', unknown.json?.error?.code === -32602, `code=${unknown.json?.error?.code}`);

  // --- session cleanup -------------------------------------------------
  const del = await rawRequest({
    method: 'DELETE',
    headers: { Authorization: `Bearer ${mcpServer.token}`, 'Mcp-Session-Id': session }
  });
  check('DELETE terminates the session', del.status === 204, `HTTP ${del.status}`);

  await mcpClient.stop();
  check('stop marks every upstream stopped', mcpClient.getServers().every((server) => server.state === 'stopped'));
}

main()
  .catch((error) => {
    failures.push(error.message);
    console.error(`not ok - ${error.stack || error.message}`);
  })
  .finally(async () => {
    if (honokaEventClient) honokaEventClient.stop();
    if (bodyClient) bodyClient.socket.close();
    if (uiClient) uiClient.socket.close();
    if (honokaEventsServer) await honokaEventsServer.close();
    if (upstream) upstream.close();
    if (mcpClient) await mcpClient.stop();
    if (mcpServer) mcpServer.stop();
    if (bridge) bridge.stop();
    await sleep(100);
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length > 0) process.exitCode = 1;
  });
