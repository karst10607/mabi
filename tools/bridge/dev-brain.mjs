#!/usr/bin/env node
// Headless brain for Godot body development: starts the same ws bridge server
// main.js uses, without opening the Electron window.
//
//   node tools/bridge/dev-brain.mjs [--port=47821] [--config-dir=DIR]
//
// The body reads the token from <config-dir>/app-settings.json (default
// ~/.config/aurapet-desktop). Stop the Electron app first if you want the
// default port.
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createConfigStore } = require('../../daemon/config-store.js');
const { createBridgeServer } = require('../../daemon/bridge-server.js');
const { createUiServer, DEFAULT_UI_PORT } = require('../../daemon/ui-server.js');
const { createMcpServer, DEFAULT_MCP_PORT } = require('../../daemon/mcp-server.js');

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const dir = readArg('config-dir',
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'aurapet-desktop'));
const port = Number(readArg('port', '47821'));

const store = createConfigStore({ dir });
const bridge = createBridgeServer({ configStore: store, port, brainVersion: 'dev' });
const uiPort = Number(readArg('ui-port', String(DEFAULT_UI_PORT)));

const mcpPort = Number(readArg('mcp-port', String(DEFAULT_MCP_PORT)));
let ui = null;
let mcp = null;

bridge.start().then(() => {
  console.log(`dev-brain: ws://127.0.0.1:${bridge.port} config=${dir}`);
  ui = createUiServer({ configStore: store, token: bridge.token, bridgePort: bridge.port, port: uiPort });
  ui.start().catch((err) => console.error(`dev-brain: ui failed: ${err.message}`));
  console.log(`dev-brain: ui http://127.0.0.1:${uiPort}/ (open with ?token=<bridgeToken>)`);
  mcp = createMcpServer({ configStore: store, bridge, port: mcpPort });
  mcp.start()
    .then(() => console.log(`dev-brain: mcp http://127.0.0.1:${mcp.port()}${mcp.path} (token=mcpToken in ${dir}/app-settings.json)`))
    .catch((err) => console.error(`dev-brain: mcp failed: ${err.message}`));
  console.log('dev-brain: Ctrl-C to stop');
}).catch((err) => {
  console.error(`dev-brain: failed to start: ${err.message}`);
  process.exit(1);
});

const stop = () => {
  if (mcp) mcp.stop();
  bridge.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
