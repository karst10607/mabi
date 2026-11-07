#!/usr/bin/env node
// Windows packaging: Godot export + Node SEA daemon + launcher → zip & dir.
// (Epic #7 / issue #26)
//
//   npm run dist:win
//
// Environment:
//   GODOT_BIN          Godot 4.7.2 editor binary (defaults to local desktop or path)
//   NODE_BIN           Node binary to inject SEA into (defaults to process.execPath)
//   AURAPET_VERSION    override package.json version
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
const ESBUILD = 'esbuild@0.25.0';
const POSTJECT = 'postject@1.0.0-alpha.6';
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const log = (message) => console.log(`dist:win: ${message}`);
const run = (command, args, options = {}) => {
  log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit', cwd: root, ...options });
};
const exists = (file) => fs.existsSync(file);

function findGodot() {
  if (process.env.GODOT_BIN) return process.env.GODOT_BIN;
  const candidates = [
    path.join(os.homedir(), 'Desktop', 'Godot_v4.7.2-stable_win64.exe'),
    path.join(os.homedir(), '桌面', 'Godot_v4.7.2-stable_win64.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'aurapet-godot', 'Godot_v4.7.2-stable_win64.exe'),
    'C:\\Program Files\\Godot\\Godot_v4.7.2-stable_win64.exe'
  ];
  const hit = candidates.find(exists);
  if (hit) return hit;
  try {
    const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
    const hit = execFileSync(cmd, ['godot'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    if (hit && exists(hit)) return hit;
  } catch {}
  throw new Error('Godot 4.7.2 binary not found; set GODOT_BIN');
}

function copy(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

function writeFile(target, contents, mode = 0o644) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, { mode });
  try {
    fs.chmodSync(target, mode);
  } catch {}
}

function makeZip(sourceDir, zipFile) {
  log(`creating zip archive ${zipFile}`);
  if (exists(zipFile)) fs.rmSync(zipFile, { force: true });
  const parent = path.dirname(sourceDir);
  const base = path.basename(sourceDir);
  try {
    run('tar', ['-a', '-c', '-f', zipFile, '-C', parent, base]);
    return;
  } catch {}
  if (process.platform === 'win32') {
    run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${sourceDir}\\*' -DestinationPath '${zipFile}' -Force`]);
  } else {
    run('zip', ['-r', '-q', zipFile, base], { cwd: parent });
  }
}

async function main() {
  const godot = findGodot();
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const appDir = path.join(out, 'AuraPet');
  fs.mkdirSync(appDir, { recursive: true });

  log(`version ${version}; godot ${godot}`);
  run(godot, ['--headless', '--path', 'godot', '--import']);
  const body = path.join(appDir, 'AuraPet.exe');
  run(godot, ['--headless', '--path', 'godot', '--export-release', 'Windows Desktop', body]);

  // --- daemon: esbuild bundle → Node SEA → postject -------------------
  const daemonDir = path.join(out, 'daemon');
  fs.mkdirSync(daemonDir, { recursive: true });
  const bundle = path.join(daemonDir, 'aurapet.cjs');
  run('npx', [
    '--yes', ESBUILD, 'daemon/standalone.js',
    '--bundle', '--platform=node', '--format=cjs', '--target=node24',
    '--external:bufferutil', '--external:utf-8-validate',
    `--outfile=${bundle}`
  ]);
  const seaConfig = path.join(daemonDir, 'sea-config.json');
  const blob = path.join(daemonDir, 'aurapet.blob');
  writeFile(seaConfig, JSON.stringify({
    main: path.relative(root, bundle),
    output: path.relative(root, blob),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false
  }));
  run('node', ['--experimental-sea-config', seaConfig]);

  const daemonSource = process.env.NODE_BIN || process.execPath;
  const daemonBin = path.join(appDir, 'aurapet-daemon.exe');
  fs.copyFileSync(daemonSource, daemonBin);
  try {
    fs.chmodSync(daemonBin, 0o755);
  } catch {}
  run('npx', [
    '--yes', POSTJECT, daemonBin, 'NODE_SEA_BLOB', blob,
    '--sentinel-fuse', SEA_FUSE
  ]);

  // --- App bundle layout -----------------------------------------------
  copy(path.join(root, 'packaging', 'aurapet.cmd'), path.join(appDir, 'aurapet.cmd'));
  copy(path.join(root, 'godot', 'icon.png'), path.join(appDir, 'icon.png'));
  copy(path.join(root, 'build', 'icon.png'), path.join(appDir, 'build', 'icon.png'));
  copy(path.join(root, 'renderer'), path.join(appDir, 'renderer'));
  copy(path.join(root, 'ui', 'ui-bridge.js'), path.join(appDir, 'ui', 'ui-bridge.js'));
  copy(path.join(root, 'daemon', 'pet-state.js'), path.join(appDir, 'daemon', 'pet-state.js'));

  // Also expose top-level binaries/launcher in dist/windows for direct execution
  copy(body, path.join(out, 'AuraPet.exe'));
  copy(daemonBin, path.join(out, 'aurapet-daemon.exe'));
  copy(path.join(root, 'packaging', 'aurapet.cmd'), path.join(out, 'aurapet.cmd'));

  // --- Zip archive -----------------------------------------------------
  const zipFile = path.join(out, `AuraPet-${version}-windows-x86_64.zip`);
  makeZip(appDir, zipFile);

  const { size } = fs.statSync(zipFile);
  log(`${path.basename(zipFile)} ${(size / 1024 / 1024).toFixed(1)} MB`);
}

main().catch((error) => {
  console.error(`dist:win: ${error.stack || error.message}`);
  process.exitCode = 1;
});
