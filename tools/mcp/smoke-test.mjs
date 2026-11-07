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
let upstream = null;
let bodyClient = null;
let uiClient = null;

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

async function main() {
  bridge = createBridgeServer({ configStore: store, port: 0, brainVersion: 'smoke', log: quiet });
  await bridge.start();
  mcpServer = createMcpServer({ configStore: store, bridge, port: 0, log: quiet });
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
  store.patch({ mcpUpstreams: [{ name: 'fake-notes', url: upstreamUrl, transport: 'streamable-http' }] });
  const search = await rpc({
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: { name: 'notes.search', arguments: { query: 'cat', limit: 5 } }
  }, { session });
  const searchPayload = search.json?.result?.structuredContent;
  check('notes.search aggregates upstream results', searchPayload?.results?.length === 1 && searchPayload.results[0].source === 'fake-notes', `hits=${searchPayload?.results?.length}`);
  check('notes.search reports upstream health', searchPayload?.sources?.[0]?.state === 'ok', `tool=${searchPayload?.sources?.[0]?.tool}`);

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
}

main()
  .catch((error) => {
    failures.push(error.message);
    console.error(`not ok - ${error.stack || error.message}`);
  })
  .finally(async () => {
    if (bodyClient) bodyClient.socket.close();
    if (uiClient) uiClient.socket.close();
    if (upstream) upstream.close();
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
