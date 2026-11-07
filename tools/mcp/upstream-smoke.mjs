#!/usr/bin/env node
// Real-upstream smoke test for the MCP client face (issue #13).
//
// Connects the daemon's MCP client to a note server that is already running and
// prints pasteable evidence: tools/list, one tools/call, optional search, and a
// token-leak assertion. Nothing is written to the AuraPet config.
//
//   node tools/mcp/upstream-smoke.mjs --from-joplin
//   node tools/mcp/upstream-smoke.mjs --config ~/.config/aurapet-desktop/app-settings.json
//   node tools/mcp/upstream-smoke.mjs --from-joplin --search 旅行
//
// --from-joplin reads Joplin's own ~/.config/joplin-desktop/settings.json
// (`api.token`) and uses the built-in Streamable HTTP endpoint on 41184. The
// token is never printed, and logs/status are asserted to be token-free.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMcpClient } = require('../../daemon/mcp-client.js');

const args = process.argv.slice(2);
const readArg = (name, fallback = null) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')) return args[index + 1];
  return fallback;
};
const flag = (name) => args.includes(`--${name}`);

const fromJoplin = flag('from-joplin');
const configPath = readArg('config', fromJoplin
  ? null
  : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'aurapet-desktop', 'app-settings.json'));
const joplinUrl = readArg('joplin-url', 'http://127.0.0.1:41184/mcp');
const searchQuery = readArg('search', null);
const explicitCall = readArg('call', null);
const timeoutMs = Number(readArg('timeout', '10000')) || 10000;

const logs = [];
const log = {
  info(message) {
    logs.push(String(message));
    console.log(String(message));
  },
  warn(message) {
    logs.push(String(message));
    console.log(String(message));
  }
};

function loadEntries() {
  if (fromJoplin) {
    const settingsPath = path.join(os.homedir(), '.config', 'joplin-desktop', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const token = settings['api.token'];
    if (typeof token !== 'string' || token.length < 16) throw new Error('Joplin api.token missing');
    return {
      token,
      entries: [{ name: 'joplin', transport: 'streamable-http', url: joplinUrl, token, tokenIn: 'query' }]
    };
  }
  if (!configPath) throw new Error('pass --from-joplin or --config <app-settings.json>');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!Array.isArray(config.mcpUpstreams) || config.mcpUpstreams.length === 0) {
    throw new Error(`${configPath} has no mcpUpstreams`);
  }
  const tokens = config.mcpUpstreams.map((entry) => entry?.token).filter((token) => typeof token === 'string');
  return { token: tokens[0] || '', entries: config.mcpUpstreams };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitReady(client, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const servers = client.getServers();
    if (servers.length > 0 && servers.every((server) => server.state === 'ready' || server.state === 'error')) return servers;
    await sleep(100);
  }
  return client.getServers();
}

function summarizeCall(tool, result) {
  const text = (result?.content || [])
    .filter((item) => item && item.type === 'text')
    .map((item) => item.text)
    .join('\n');
  let detail = `${text.length} chars`;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.notebooks)) detail = `${parsed.notebooks.length} notebooks`;
    else if (Array.isArray(parsed?.notes)) detail = `${parsed.notes.length} notes`;
    else if (Array.isArray(parsed)) detail = `${parsed.length} items`;
  } catch {
    /* plain text */
  }
  const failed = result?.isError === true;
  console.log(`# tools/call ${tool} -> ${failed ? 'isError' : 'ok'} (${detail})`);
  return !failed;
}

async function main() {
  const { token, entries } = loadEntries();
  const store = { get: (key) => (key === 'mcpUpstreams' ? entries : undefined), patch() {} };
  const client = createMcpClient({ configStore: store, log, connectTimeoutMs: 8000, listTimeoutMs: 8000 });
  let failures = 0;
  try {
    await client.start();
    const servers = await waitReady(client, timeoutMs);
    console.log('# servers');
    for (const server of servers) {
      console.log(`#   ${server.name} (${server.transport}, ${server.state}${server.error ? `: ${server.error}` : ''}, ${server.toolCount} tools)`);
      if (server.state !== 'ready') failures += 1;
    }

    const tools = client.getTools();
    console.log(`# tools/list (${tools.length}): ${tools.map((tool) => tool.name).join(', ') || '-'}`);
    if (tools.length === 0) failures += 1;

    const preferred = explicitCall || tools.find((tool) => /\.list_notebooks$/.test(tool.name))?.name || tools[0]?.name;
    if (preferred) {
      const result = await client.callTool(preferred, {});
      if (!summarizeCall(preferred, result)) failures += 1;
    } else {
      console.log('# tools/call skipped: no tools');
      failures += 1;
    }

    if (searchQuery) {
      const found = await client.search(searchQuery, { limit: 5 });
      const ok = (found.sources || []).some((source) => source.state === 'ok');
      console.log(`# search "${searchQuery}" -> ${found.results.length} hit(s) via ${(found.sources || []).map((s) => `${s.name}:${s.state}`).join(', ')}`);
      if (!ok) failures += 1;
    }

    const haystack = `${logs.join('\n')}\n${JSON.stringify(client.getServers())}\n${JSON.stringify(tools.map((tool) => tool.name))}`;
    const leaked = token ? haystack.includes(token) : false;
    console.log(`# token redaction: ${leaked ? 'FAILED (token leaked)' : 'ok (0 occurrences in status/logs)'}`);
    if (leaked) failures += 1;
  } finally {
    await client.stop();
  }
  if (failures > 0) {
    console.error(`# upstream smoke failed (${failures} check(s))`);
    process.exitCode = 1;
  } else {
    console.log('# upstream smoke passed');
  }
}

main().catch((error) => {
  console.error(`# upstream smoke failed: ${error.message}`);
  process.exitCode = 1;
});
