/**
 * AuraPet daemon - headless entry for the packaged app (issue #15).
 *
 * Same brain modules the Electron main process wires up, without Electron:
 * bridge (body WS), on-demand UI page and MCP server face. The launcher starts
 * this binary, then the exported Godot body; both talk over loopback only.
 */
'use strict';

const os = require('os');
const path = require('path');
const { createConfigStore } = require('./config-store');
const { createBridgeServer } = require('./bridge-server');
const { createUiServer, DEFAULT_UI_PORT } = require('./ui-server');
const { createMcpServer, DEFAULT_MCP_PORT } = require('./mcp-server');

function packageVersion() {
  try {
    return require('../package.json').version;
  } catch {
    return '0.0.0';
  }
}

const configDir = process.env.AURAPET_CONFIG_DIR ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'aurapet-desktop');
const appDir = process.env.AURAPET_APP_DIR || path.join(__dirname, '..');
const bridgePort = Number(process.env.AURAPET_BRIDGE_PORT) || 47821;
const uiPort = Number(process.env.AURAPET_UI_PORT) || DEFAULT_UI_PORT;
const mcpPort = Number(process.env.AURAPET_MCP_PORT) || DEFAULT_MCP_PORT;

let bridge = null;
let ui = null;
let mcp = null;

function shutdown(code = 0) {
  if (mcp) mcp.stop();
  if (ui) ui.stop();
  if (bridge) bridge.stop();
  process.exit(code);
}

async function main() {
  const store = createConfigStore({ dir: configDir });
  bridge = createBridgeServer({ configStore: store, port: bridgePort, brainVersion: packageVersion() });
  await bridge.start();

  ui = createUiServer({ configStore: store, token: bridge.token, bridgePort: bridge.port, port: uiPort, root: appDir });
  await ui.start().catch((error) => console.warn(`aurapet-daemon: ui server unavailable: ${error.message}`));

  mcp = createMcpServer({ configStore: store, bridge, port: mcpPort });
  await mcp.start().catch((error) => console.warn(`aurapet-daemon: mcp server unavailable: ${error.message}`));

  console.log(`aurapet-daemon: ws=${bridge.port} ui=${uiPort} mcp=${mcpPort} config=${configDir}`);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (error) => {
  console.error(`aurapet-daemon: ${error.stack || error}`);
  shutdown(1);
});

main().catch((error) => {
  console.error(`aurapet-daemon: failed to start: ${error.message}`);
  shutdown(1);
});
