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

bridge.start().then(() => {
  console.log(`dev-brain: ws://127.0.0.1:${port} config=${dir}`);
  console.log('dev-brain: Ctrl-C to stop');
}).catch((err) => {
  console.error(`dev-brain: failed to start: ${err.message}`);
  process.exit(1);
});

const stop = () => {
  bridge.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
