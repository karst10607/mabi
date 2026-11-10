#!/usr/bin/env node
// Standalone on-demand stdio MCP server for video downloading via yt-dlp (ADR 0002 / Issue #61).
//
// Supports YouTube, Facebook (facebook.com / fb.watch), Instagram (Reels / Posts),
// X / Twitter (x.com / twitter.com), Bilibili, TikTok, Vimeo, Twitch, etc.
//
// Zero idle footprint: spawned on demand over stdio by MCP clients (mabi mcpUpstreams,
// Antigravity, Cursor, Qoder) and exits when stdin closes.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'yt-dlp-mcp', version: '1.0.0' };
const DEFAULT_MAX_SIZE_MB = 500;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export const SUPPORTED_PLATFORMS = [
  { id: 'youtube', domains: ['youtube.com', 'youtu.be'] },
  { id: 'facebook', domains: ['facebook.com', 'fb.watch', 'fb.gg'] },
  { id: 'instagram', domains: ['instagram.com', 'instagr.am'] },
  { id: 'x', domains: ['x.com', 'twitter.com', 't.co'] },
  { id: 'bilibili', domains: ['bilibili.com', 'b23.tv'] },
  { id: 'tiktok', domains: ['tiktok.com'] },
  { id: 'vimeo', domains: ['vimeo.com'] },
  { id: 'twitch', domains: ['twitch.tv'] }
];

export function detectPlatform(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
    for (const item of SUPPORTED_PLATFORMS) {
      if (item.domains.some((d) => host === d || host.endsWith(`.${d}`))) {
        return item.id;
      }
    }
    return host || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function resolveYtDlpBinary(env = process.env) {
  if (env.YTDLP_BIN && env.YTDLP_BIN.trim()) {
    return env.YTDLP_BIN.trim();
  }
  const isWin = process.platform === 'win32';
  const binName = isWin ? 'yt-dlp.exe' : 'yt-dlp';
  const configDir = env.AURAPET_CONFIG_DIR || path.join(os.homedir(), '.config', 'aurapet-desktop');
  const candidates = [
    path.join(configDir, 'bin', binName),
    path.join(os.homedir(), '.local', 'bin', binName),
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp'
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return binName;
}

export function checkYtDlpStatus(env = process.env) {
  const binaryPath = resolveYtDlpBinary(env);
  try {
    const version = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    return {
      ok: true,
      available: true,
      binaryPath,
      version,
      supportedPlatforms: SUPPORTED_PLATFORMS.map((p) => p.id)
    };
  } catch (error) {
    return {
      ok: false,
      available: false,
      binaryPath,
      error: error.message,
      supportedPlatforms: SUPPORTED_PLATFORMS.map((p) => p.id),
      installHint: process.platform === 'win32'
        ? 'winget install yt-dlp.yt-dlp'
        : 'pipx install yt-dlp  OR  curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ~/.local/bin/yt-dlp && chmod a+rx ~/.local/bin/yt-dlp'
    };
  }
}

export function buildYtDlpArgs({
  url,
  outputPattern,
  format = 'mp4',
  cookiesFromBrowser,
  maxHeight
}) {
  const args = ['--no-playlist', '--newline'];
  const cookieBrowser = cookiesFromBrowser || process.env.YTDLP_COOKIES_BROWSER || '';
  if (cookieBrowser) {
    args.push('--cookies-from-browser', String(cookieBrowser).trim());
  }
  if (format === 'mp3') {
    args.push('-x', '--audio-format', 'mp3');
  } else {
    if (Number.isInteger(maxHeight) && maxHeight > 0) {
      args.push('-f', `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/best`);
    }
    args.push('--merge-output-format', 'mp4');
  }
  if (outputPattern) {
    args.push('-o', outputPattern);
  }
  args.push(url);
  return args;
}

export function fetchVideoInfo(url, { cookiesFromBrowser, env = process.env, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      reject(new Error('Valid http(s) URL is required'));
      return;
    }
    const binaryPath = resolveYtDlpBinary(env);
    const args = ['--dump-single-json', '--no-playlist'];
    const cookieBrowser = cookiesFromBrowser || env.YTDLP_COOKIES_BROWSER || '';
    if (cookieBrowser) {
      args.push('--cookies-from-browser', String(cookieBrowser).trim());
    }
    args.push(url);

    const proc = spawn(binaryPath, args, { env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`yt-dlp info timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start yt-dlp (${binaryPath}): ${err.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`yt-dlp exited with code ${code}: ${stderr.trim().slice(0, 300)}`));
        return;
      }
      try {
        const info = JSON.parse(stdout.trim());
        resolve({
          ok: true,
          platform: detectPlatform(url),
          id: info.id || null,
          title: info.title || info.fulltitle || url,
          uploader: info.uploader || info.channel || null,
          duration: info.duration ?? null,
          webpageUrl: info.webpage_url || url,
          thumbnail: info.thumbnail || null,
          extractor: info.extractor || null
        });
      } catch (err) {
        reject(new Error(`Failed to parse yt-dlp JSON output: ${err.message}`));
      }
    });
  });
}

export function downloadVideo(url, {
  outputDir,
  format = 'mp4',
  cookiesFromBrowser,
  maxHeight,
  maxSizeMB = DEFAULT_MAX_SIZE_MB,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onProgress
} = {}) {
  return new Promise((resolve, reject) => {
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      reject(new Error('Valid http(s) URL is required'));
      return;
    }
    const targetDir = outputDir || env.YTDLP_OUTPUT_DIR || path.join(os.homedir(), 'Downloads', 'Videos');
    fs.mkdirSync(targetDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const prefix = `video-${timestamp}-`;
    const outputPattern = path.join(targetDir, `${prefix}%(title).80s.%(ext)s`);
    const binaryPath = resolveYtDlpBinary(env);
    const cookieBrowser = cookiesFromBrowser || env.YTDLP_COOKIES_BROWSER || '';
    const args = buildYtDlpArgs({
      url,
      outputPattern,
      format,
      cookiesFromBrowser: cookieBrowser,
      maxHeight
    });

    const proc = spawn(binaryPath, args, { env });
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`yt-dlp download timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const match = text.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
      if (match && typeof onProgress === 'function') {
        onProgress(Number(match[1]));
      }
    });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start yt-dlp (${binaryPath}): ${err.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`yt-dlp exited with code ${code}: ${stderr.trim().slice(0, 300)}`));
        return;
      }
      const files = fs.readdirSync(targetDir);
      const filename = files.find((f) => f.startsWith(prefix));
      if (!filename) {
        reject(new Error('yt-dlp exited 0 but output file was not found'));
        return;
      }
      const filePath = path.join(targetDir, filename);
      const sizeBytes = fs.statSync(filePath).size;
      const limitBytes = (Number(maxSizeMB) > 0 ? Number(maxSizeMB) : DEFAULT_MAX_SIZE_MB) * 1024 * 1024;
      if (sizeBytes > limitBytes) {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
        reject(new Error(`Downloaded file exceeds size limit (${(sizeBytes / 1048576).toFixed(1)} MB > ${maxSizeMB} MB)`));
        return;
      }
      resolve({
        ok: true,
        platform: detectPlatform(url),
        url,
        filename,
        filePath,
        format,
        sizeBytes,
        sizeMB: Number((sizeBytes / 1048576).toFixed(2)),
        cookiesUsed: Boolean(cookieBrowser)
      });
    });
  });
}

export const TOOLS = [
  {
    name: 'video.download',
    description: 'Download video or audio from YouTube, Facebook, Instagram (Reels/Posts), X (Twitter), Bilibili, TikTok, etc. via yt-dlp.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: {
          type: 'string',
          description: 'Video URL (YouTube, Facebook, Instagram, X/Twitter, Bilibili, TikTok, etc.)'
        },
        outputDir: {
          type: 'string',
          description: 'Destination directory (default: ~/Downloads/Videos or YTDLP_OUTPUT_DIR)'
        },
        cookiesFromBrowser: {
          type: 'string',
          description: 'Browser name to read cookies from (e.g. "chrome", "firefox", "edge", "brave") for FB/IG/X login-wall videos'
        },
        format: {
          type: 'string',
          enum: ['mp4', 'mp3'],
          description: 'Output format: "mp4" (video, default) or "mp3" (audio only)'
        },
        maxHeight: {
          type: 'integer',
          description: 'Optional maximum video height resolution (e.g. 1080, 720)'
        },
        maxSizeMB: {
          type: 'number',
          description: 'Maximum file size in MB (default: 500)'
        }
      }
    }
  },
  {
    name: 'video.info',
    description: 'Fetch metadata (title, uploader, duration, platform, thumbnail) for a video URL without downloading the file.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: {
          type: 'string',
          description: 'Video URL to inspect'
        },
        cookiesFromBrowser: {
          type: 'string',
          description: 'Optional browser name to read cookies from (e.g. "chrome", "firefox")'
        }
      }
    }
  },
  {
    name: 'video.status',
    description: 'Check local yt-dlp binary availability, version, and supported platforms.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function formatToolResult(payload, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {})
  };
}

async function handleRequest(message) {
  if (!message || message.jsonrpc !== '2.0' || !message.method) return;
  const hasId = Object.hasOwn(message, 'id');

  switch (message.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO
        }
      });
      return;

    case 'notifications/initialized':
      return;

    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: TOOLS }
      });
      return;

    case 'resources/list':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { resources: [] }
      });
      return;

    case 'tools/call': {
      const name = message.params?.name;
      const args = message.params?.arguments || {};
      try {
        if (name === 'video.status') {
          const status = checkYtDlpStatus();
          send({ jsonrpc: '2.0', id: message.id, result: formatToolResult(status, !status.ok) });
          return;
        }
        if (name === 'video.info') {
          const info = await fetchVideoInfo(args.url, {
            cookiesFromBrowser: args.cookiesFromBrowser
          });
          send({ jsonrpc: '2.0', id: message.id, result: formatToolResult(info) });
          return;
        }
        if (name === 'video.download' || name === 'download_video') {
          const downloaded = await downloadVideo(args.url, {
            outputDir: args.outputDir,
            format: args.format || 'mp4',
            cookiesFromBrowser: args.cookiesFromBrowser,
            maxHeight: args.maxHeight,
            maxSizeMB: args.maxSizeMB
          });
          send({ jsonrpc: '2.0', id: message.id, result: formatToolResult(downloaded) });
          return;
        }
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32602, message: `Unknown tool: ${name}` }
        });
      } catch (error) {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: formatToolResult({ ok: false, error: error.message }, true)
        });
      }
      return;
    }

    default:
      if (hasId) {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` }
        });
      }
  }
}

export function startStdioServer() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    handleRequest(message).catch((error) => {
      if (Object.hasOwn(message, 'id')) {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: error.message }
        });
      }
    });
  });
  process.stdin.on('end', () => process.exit(0));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  startStdioServer();
}
