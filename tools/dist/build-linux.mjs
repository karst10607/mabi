#!/usr/bin/env node
// Linux packaging: Godot export + Node SEA daemon + launcher → AppImage & deb.
// Replaces the electron-builder path (Epic #7 / issue #15).
//
//   npm run dist:linux
//
// Environment:
//   GODOT_BIN          Godot 4.7.2 editor binary (defaults to a local probe build)
//   APPIMAGE_RUNTIME   type-2 runtime ELF (downloaded when absent)
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
const out = path.join(root, 'dist', 'linux');
const ESBUILD = 'esbuild@0.25.0';
const POSTJECT = 'postject@1.0.0-alpha.6';
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const RUNTIME_URL = 'https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64';

const log = (message) => console.log(`dist:linux: ${message}`);
const run = (command, args, options = {}) => {
  log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit', cwd: root, ...options });
};
const exists = (file) => fs.existsSync(file);

function findGodot() {
  if (process.env.GODOT_BIN) return process.env.GODOT_BIN;
  const candidates = [
    path.join(os.homedir(), '桌面', 'godot-pet-probe', 'Godot_v4.7.2-stable_linux.x86_64'),
    path.join(os.homedir(), 'Desktop', 'godot-pet-probe', 'Godot_v4.7.2-stable_linux.x86_64'),
    '/usr/local/bin/godot',
    '/usr/bin/godot'
  ];
  const hit = candidates.find(exists);
  if (hit) return hit;
  try {
    return execFileSync('sh', ['-c', 'command -v godot'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('Godot 4.7.2 binary not found; set GODOT_BIN');
  }
}

function findMksquashfs() {
  if (process.env.MKSQUASHFS) return process.env.MKSQUASHFS;
  try {
    return execFileSync('sh', ['-c', 'command -v mksquashfs'], { encoding: 'utf8' }).trim();
  } catch {
    const cached = path.join(os.homedir(), '.cache', 'electron-builder', 'appimage', 'appimage-12.0.1', 'linux-x64', 'mksquashfs');
    if (exists(cached)) return cached;
    throw new Error('mksquashfs not found; install squashfs-tools or set MKSQUASHFS');
  }
}

async function ensureRuntime(dest) {
  if (process.env.APPIMAGE_RUNTIME) return process.env.APPIMAGE_RUNTIME;
  const cached = path.join(os.homedir(), '.cache', 'electron-builder', 'appimage', 'appimage-12.0.1', 'runtime-x64');
  if (exists(cached)) return cached;
  if (exists(dest)) return dest;
  log(`downloading AppImage runtime from ${RUNTIME_URL}`);
  const response = await fetch(RUNTIME_URL);
  if (!response.ok) throw new Error(`runtime download failed: HTTP ${response.status}`);
  fs.writeFileSync(dest, Buffer.from(await response.arrayBuffer()), { mode: 0o755 });
  return dest;
}

function copy(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

function writeFile(target, contents, mode = 0o644) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, { mode });
  fs.chmodSync(target, mode);
}

async function main() {
  const godot = findGodot();
  const mksquashfs = findMksquashfs();
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  log(`version ${version}; godot ${godot}`);
  run(godot, ['--headless', '--path', 'godot', '--import']);
  const body = path.join(out, 'AuraPet');
  run(godot, ['--headless', '--path', 'godot', '--export-release', 'Linux', body]);

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
  const daemonBin = path.join(daemonDir, 'aurapet-daemon');
  fs.copyFileSync(process.execPath, daemonBin);
  fs.chmodSync(daemonBin, 0o755);
  run('npx', [
    '--yes', POSTJECT, daemonBin, 'NODE_SEA_BLOB', blob,
    '--sentinel-fuse', SEA_FUSE
  ]);

  // --- AppDir ----------------------------------------------------------
  const appDir = path.join(out, 'AppDir');
  const appLib = path.join(appDir, 'usr', 'lib', 'aurapet');
  copy(body, path.join(appLib, 'aurapet-body'));
  copy(daemonBin, path.join(appLib, 'aurapet-daemon'));
  copy(path.join(root, 'packaging', 'aurapet'), path.join(appDir, 'usr', 'bin', 'aurapet'));
  copy(path.join(root, 'godot', 'tray_helper.py'), path.join(appLib, 'tray_helper.py'));
  copy(path.join(root, 'godot', 'icon.png'), path.join(appLib, 'icon.png'));
  copy(path.join(root, 'build', 'icon.png'), path.join(appLib, 'build', 'icon.png'));
  copy(path.join(root, 'renderer'), path.join(appLib, 'renderer'));
  copy(path.join(root, 'ui', 'ui-bridge.js'), path.join(appLib, 'ui', 'ui-bridge.js'));
  copy(path.join(root, 'daemon', 'pet-state.js'), path.join(appLib, 'daemon', 'pet-state.js'));
  copy(path.join(root, 'packaging', 'aurapet.desktop'), path.join(appDir, 'aurapet.desktop'));
  copy(path.join(root, 'build', 'icon.png'), path.join(appDir, 'aurapet.png'));
  copy(path.join(root, 'packaging', 'aurapet.desktop'), path.join(appDir, 'usr', 'share', 'applications', 'aurapet.desktop'));
  copy(path.join(root, 'build', 'icon.png'), path.join(appDir, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps', 'aurapet.png'));
  fs.symlinkSync('usr/bin/aurapet', path.join(appDir, 'AppRun'));
  fs.chmodSync(path.join(appDir, 'usr', 'bin', 'aurapet'), 0o755);

  // --- AppImage: runtime ELF + squashfs --------------------------------
  const squashfs = path.join(out, 'aurapet.squashfs');
  run(mksquashfs, [appDir, squashfs, '-root-owned', '-noappend', '-comp', 'gzip', '-no-progress']);
  const runtime = await ensureRuntime(path.join(out, 'runtime-x86_64'));
  const appImage = path.join(out, `AuraPet-${version}-x86_64.AppImage`);
  const fd = fs.openSync(appImage, 'w', 0o755);
  try {
    fs.writeSync(fd, fs.readFileSync(runtime));
    fs.writeSync(fd, fs.readFileSync(squashfs));
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(appImage, 0o755);
  fs.rmSync(squashfs, { force: true });

  // --- deb --------------------------------------------------------------
  const debRoot = path.join(out, 'deb-root');
  copy(path.join(appDir, 'usr'), path.join(debRoot, 'usr'));
  copy(path.join(appDir, 'aurapet.desktop'), path.join(debRoot, 'usr', 'share', 'applications', 'aurapet.desktop'));
  copy(path.join(appDir, 'aurapet.png'), path.join(debRoot, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps', 'aurapet.png'));
  const du = execFileSync('du', ['-sk', path.join(debRoot, 'usr')], { encoding: 'utf8' });
  const installedKb = Number(du.trim().split(/\s+/)[0]);
  writeFile(path.join(debRoot, 'DEBIAN', 'control'), [
    'Package: aurapet',
    `Version: ${version}`,
    'Section: utils',
    'Priority: optional',
    'Architecture: amd64',
    'Maintainer: Howl <karst10607@gmail.com>',
    `Installed-Size: ${installedKb}`,
    'Depends: libc6, libstdc++6, libx11-6, libgl1',
    'Description: AuraPet AI desktop pet',
    ' Godot body (transparent window) + headless Node daemon (AI, MCP).',
    ''
  ].join('\n'));
  const deb = path.join(out, `aurapet_${version}_amd64.deb`);
  run('dpkg-deb', ['--build', '--root-owner-group', debRoot, deb]);

  for (const artifact of [appImage, deb]) {
    const { size } = fs.statSync(artifact);
    log(`${path.basename(artifact)} ${(size / 1024 / 1024).toFixed(1)} MB`);
  }
}

main().catch((error) => {
  console.error(`dist:linux: ${error.stack || error.message}`);
  process.exitCode = 1;
});
