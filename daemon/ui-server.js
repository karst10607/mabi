/**
 * AuraPet daemon - on-demand UI server (issue #12).
 *
 * Serves the existing renderer DOM at http://127.0.0.1:<port>/ behind the bridge
 * token. The page talks to the brain over the same WS protocol as a `ui` client;
 * this server only ships HTML/JS/assets and injects the token + a snapshot of
 * the config so the browser localStorage shim can start synchronously.
 *
 * Loopback only, no dependencies.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const DEFAULT_UI_PORT = 47830;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function escapeForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function createUiServer(options = {}) {
  const { configStore, token, port = DEFAULT_UI_PORT, bridgePort = 47821, root = path.join(__dirname, '..'), log = console } = options;
  if (!configStore) throw new TypeError('createUiServer requires a config store');
  if (typeof token !== 'string' || token.length < 32) throw new TypeError('createUiServer requires the bridge token');

  const rendererDir = path.join(root, 'renderer');
  const daemonDir = path.join(root, 'daemon');
  const uiDir = path.join(root, 'ui');
  let server = null;

  const tokenMatches = (given) => {
    if (typeof given !== 'string') return false;
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  function settingsForUi() {
    const all = configStore.getAll();
    const out = {};
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith('aurapet_')) continue;
      out[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
    return out;
  }

  function indexHtml() {
    const source = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
    const boot = {
      token,
      uiPort: port,
      wsPort: bridgePort,
      settings: settingsForUi()
    };
    const inject = `<script>window.__AURAPET__=${escapeForScript(boot)};</script>\n  ` +
      '<script src="/ui-bridge.js"></script>';
    return source
      .replace('href="styles.css"', 'href="/styles.css"')
      .replace('src="../daemon/pet-state.js"', 'src="/daemon/pet-state.js"')
      .replace('src="pet.js"', 'src="/pet.js"')
      .replace('<script src="../daemon/ai-service.js"></script>', inject)
      .replace('src="app.js"', 'src="/app.js"');
  }

  const STATIC = {
    '/styles.css': path.join(rendererDir, 'styles.css'),
    '/pet.js': path.join(rendererDir, 'pet.js'),
    '/app.js': path.join(rendererDir, 'app.js'),
    '/rig2d.js': path.join(rendererDir, 'rig2d.js'),
    '/daemon/pet-state.js': path.join(daemonDir, 'pet-state.js'),
    '/ui-bridge.js': path.join(uiDir, 'ui-bridge.js'),
    '/favicon.ico': path.join(root, 'build', 'icon.png')
  };

  function resolveStatic(pathname) {
    if (Object.hasOwn(STATIC, pathname)) return STATIC[pathname];
    let base = null;
    let rel = '';
    if (pathname.startsWith('/models/')) {
      base = path.join(rendererDir, 'models');
      rel = pathname.slice('/models/'.length);
    } else {
      return null;
    }
    const resolved = path.resolve(base, rel);
    if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
    return resolved;
  }

  function serveFile(res, filePath) {
    let data;
    try {
      data = fs.readFileSync(filePath);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  }

  function onRequest(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end();
      return;
    }
    let url;
    try {
      url = new URL(req.url, `http://127.0.0.1:${port}`);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const cookieToken = parseCookies(req.headers.cookie).aurapet_ui;
    const queryToken = url.searchParams.get('token');
    const goodCookie = tokenMatches(cookieToken);

    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (!tokenMatches(queryToken) && !goodCookie) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('forbidden');
        return;
      }
      const headers = { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' };
      if (tokenMatches(queryToken)) {
        headers['Set-Cookie'] = `aurapet_ui=${token}; Path=/; HttpOnly; SameSite=Strict`;
      }
      res.writeHead(200, headers);
      res.end(indexHtml());
      return;
    }

    if (!goodCookie) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
      return;
    }

    const filePath = resolveStatic(url.pathname);
    if (!filePath) {
      res.writeHead(404);
      res.end();
      return;
    }
    serveFile(res, filePath);
  }

  return {
    port,
    start() {
      return new Promise((resolve, reject) => {
        server = http.createServer(onRequest);
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          log.info(`ui: listening on http://127.0.0.1:${port} (token required)`);
          resolve({ port });
        });
      });
    },
    stop() {
      if (!server) return;
      server.close();
      server = null;
    }
  };
}

module.exports = {
  DEFAULT_UI_PORT,
  createUiServer
};
