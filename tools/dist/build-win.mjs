#!/usr/bin/env node
// Windows packaging: Godot export + Node SEA daemon + cmd launcher → zip.
// Completes the #15 pipeline for the second platform (issue #26).
//
//   npm run dist:win
//
// Works on Windows (CI) and on Linux/macOS, where a win-x64 node.exe is
// downloaded so the SEA daemon can be cross-built.
//
// Environment:
//   GODOT_BIN        Godot 4.7.2 editor binary (defaults to a local probe build)
//   NODE_WIN_EXE     pre-downloaded node.exe (skips the download)
//   AURAPET_VERSION  override package.json version
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = process.env.AURAPET_VERSION || pkg.version;
const out = path.join(root, 'dist', 'windows');
const packageName = 'AuraPet-win64';
const packageDir = path.join(out, packageName);
const zipPath = path.join(out, `AuraPet-${version}-win64.zip`);
const ESBUILD = 'esbuild@0.25.0';
const POSTJECT = 'postject@1.0.0-alpha.6';
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const log = (message) => console.log(`dist:win: ${message}`);
const run = (command, args, options = {}) => {
  log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit', cwd: root, ...options });
};
const exists = (file) => fs.existsSync(file);

// npx is a .cmd shim on Windows, which CreateProcess cannot launch directly.
const runNpx = (args) => {
  if (process.platform === 'win32') run('cmd.exe', ['/d', '/s', '/c', 'npx', ...args]);
  else run('npx', args);
};

function findGodot() {
  if (process.env.GODOT_BIN) return process.env.GODOT_BIN;
  const windows = process.platform === 'win32';
  const candidates = windows
    ? [
        path.join(os.homedir(), 'godot-pet-probe', 'Godot_v4.7.2-stable_win64.exe'),
        path.join(os.homedir(), 'Desktop', 'godot-pet-probe', 'Godot_v4.7.2-stable_win64.exe'),
        'C:/aurapet-godot/Godot_v4.7.2-stable_win64.exe'
      ]
    : [
        path.join(os.homedir(), '桌面', 'godot-pet-probe', 'Godot_v4.7.2-stable_linux.x86_64'),
        path.join(os.homedir(), 'Desktop', 'godot-pet-probe', 'Godot_v4.7.2-stable_linux.x86_64'),
        '/usr/local/bin/godot',
        '/usr/bin/godot'
      ];
  const hit = candidates.find(exists);
  if (hit) return hit;
  try {
    return execFileSync(windows ? 'where' : 'sh', windows ? ['godot'] : ['-c', 'command -v godot'], {
      encoding: 'utf8'
    }).trim().split(/\r?\n/)[0];
  } catch {
    throw new Error('Godot 4.7.2 binary not found; set GODOT_BIN');
  }
}

async function ensureNodeExe(cacheDir) {
  if (process.platform === 'win32') return process.execPath;
  if (process.env.NODE_WIN_EXE) return process.env.NODE_WIN_EXE;
  const cached = path.join(cacheDir, `node-v${process.versions.node}-win-x64.exe`);
  if (exists(cached)) return cached;
  const url = `https://nodejs.org/dist/v${process.versions.node}/win-x64/node.exe`;
  log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`node.exe download failed: HTTP ${response.status}`);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cached, Buffer.from(await response.arrayBuffer()));
  return cached;
}

function copy(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

function writeFile(target, contents, mode = 0o644) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, { mode });
}

function makeZip(dir, target) {
  fs.rmSync(target, { force: true });
  try {
    run('zip', ['-qr', target, path.basename(dir)], { cwd: path.dirname(dir), stdio: 'pipe' });
    return true;
  } catch (error) {
    if (process.platform !== 'win32') {
      log(`zip unavailable (${error.message}); keeping the directory only`);
      return false;
    }
  }
  run('powershell', [
    '-NoProfile', '-Command',
    `Compress-Archive -Path '${dir}\\*' -DestinationPath '${target}' -Force`
  ]);
  return true;
}

async function main() {
  const godot = findGodot();
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(packageDir, { recursive: true });

  log(`version ${version}; godot ${godot}`);
  run(godot, ['--headless', '--path', 'godot', '--import']);
  const body = path.join(packageDir, 'AuraPet.exe');
  run(godot, ['--headless', '--path', 'godot', '--export-release', 'Windows Desktop', body]);
  if (!exists(body)) throw new Error(`Godot export produced no ${body}`);

  // --- daemon: esbuild bundle → Node SEA → postject -------------------
  const buildDir = path.join(out, 'build');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundle = path.join(buildDir, 'aurapet.cjs');
  runNpx([
    '--yes', ESBUILD, 'daemon/standalone.js',
    '--bundle', '--platform=node', '--format=cjs', '--target=node24',
    '--external:bufferutil', '--external:utf-8-validate',
    `--outfile=${bundle}`
  ]);
  const seaConfig = path.join(buildDir, 'sea-config.json');
  const blob = path.join(buildDir, 'aurapet.blob');
  writeFile(seaConfig, JSON.stringify({
    main: path.relative(root, bundle),
    output: path.relative(root, blob),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false
  }));
  run('node', ['--experimental-sea-config', seaConfig]);
  const nodeExe = await ensureNodeExe(path.join(root, 'dist', '.cache'));
  const daemonBin = path.join(buildDir, 'aurapet-daemon.exe');
  fs.copyFileSync(nodeExe, daemonBin);
  runNpx([
    '--yes', POSTJECT, daemonBin, 'NODE_SEA_BLOB', blob,
    '--sentinel-fuse', SEA_FUSE
  ]);

  // --- package layout --------------------------------------------------
  copy(daemonBin, path.join(packageDir, 'aurapet-daemon.exe'));
  copy(path.join(root, 'packaging', 'aurapet.cmd'), path.join(packageDir, 'aurapet.cmd'));
  copy(path.join(root, 'renderer'), path.join(packageDir, 'renderer'));
  copy(path.join(root, 'ui', 'ui-bridge.js'), path.join(packageDir, 'ui', 'ui-bridge.js'));
  copy(path.join(root, 'daemon', 'pet-state.js'), path.join(packageDir, 'daemon', 'pet-state.js'));
  copy(path.join(root, 'build', 'icon.png'), path.join(packageDir, 'build', 'icon.png'));

  const zipped = makeZip(packageDir, zipPath);
  for (const artifact of [path.join(packageDir, 'AuraPet.exe'), path.join(packageDir, 'aurapet-daemon.exe')]) {
    const { size } = fs.statSync(artifact);
    log(`${path.basename(artifact)} ${(size / 1024 / 1024).toFixed(1)} MB`);
  }
  if (zipped) {
    const { size } = fs.statSync(zipPath);
    log(`${path.basename(zipPath)} ${(size / 1024 / 1024).toFixed(1)} MB`);
  }
}

main().catch((error) => {
  console.error(`dist:win: ${error.stack || error.message}`);
  process.exitCode = 1;
});
