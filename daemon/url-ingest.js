/**
 * AuraPet daemon - Built-in pure-JS URL ingestion & note archiving bridge (ADR 0002 / Issue #62).
 *
 * Replaces the heavy Playwright / external honoka-bridge daemon requirement for text articles:
 * - 100% pure JavaScript + built-in Node `fetch` (zero Playwright / JSDOM / native deps).
 * - Bundles cleanly into the cross-platform `aurapet-daemon` Node SEA single executable.
 * - Converts web articles (HTML -> Markdown), saves to Joplin Clipper REST API when configured,
 *   and falls back to a local Markdown Inbox directory so nothing is ever lost.
 * - Delegates video URLs (YT / FB / IG / X) to the on-demand `yt-dlp-mcp.mjs` upstream when mounted.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const VIDEO_HOSTS = [
  'youtube.com', 'youtu.be', 'bilibili.com', 'b23.tv',
  'twitter.com', 'x.com', 'vimeo.com', 'tiktok.com',
  'dailymotion.com', 'facebook.com', 'fb.watch', 'instagram.com', 'twitch.tv'
];

const FETCH_TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

function safeHost(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function classifyUrl(rawUrl) {
  const host = safeHost(rawUrl);
  const isVideo = VIDEO_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
  return { kind: isVideo ? 'video' : 'article', host };
}

function redactUrl(text) {
  return String(text || '').replace(/([?&]token=)[^&\s"'<>]+/gi, '$1<redacted>');
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function extractMeta(html, attr, name) {
  const re1 = new RegExp(`<meta\\s+[^>]*${attr}=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta\\s+[^>]*content=["']([^"']*)["'][^>]*${attr}=["']${name}["']`, 'i');
  const match = html.match(re1) || html.match(re2);
  return match ? decodeEntities(match[1]).trim() : '';
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * Lightweight, zero-dependency HTML-to-Markdown converter tailored for articles.
 */
function htmlToMarkdown(html, sourceUrl = '') {
  const raw = String(html || '');
  const ogTitle = extractMeta(raw, 'property', 'og:title') || extractMeta(raw, 'name', 'twitter:title');
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const tagTitle = titleMatch ? stripTags(titleMatch[1]) : '';
  const description = extractMeta(raw, 'property', 'og:description') || extractMeta(raw, 'name', 'description');
  const title = (ogTitle || tagTitle || sourceUrl || 'Untitled').trim();

  // Remove noisy non-content blocks first.
  let cleaned = raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|iframe|canvas|nav|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  const articleMatch = cleaned.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)
    || cleaned.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)
    || cleaned.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  let body = articleMatch ? articleMatch[1] : cleaned;

  // Convert fenced code blocks <pre><code>...</code></pre>
  body = body.replace(/<pre\b[^>]*>\s*(?:<code\b[^>]*>)?([\s\S]*?)(?:<\/code>)?\s*<\/pre>/gi, (_, code) => {
    const text = decodeEntities(code.replace(/<[^>]+>/g, '')).trim();
    return `\n\n\`\`\`\n${text}\n\`\`\`\n\n`;
  });

  // Headings h1..h6
  body = body.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, inner) => {
    const text = stripTags(inner);
    return text ? `\n\n${'#'.repeat(Number(level))} ${text}\n\n` : '';
  });

  // Blockquotes
  body = body.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => {
    const text = stripTags(inner);
    return text ? `\n\n> ${text}\n\n` : '';
  });

  // Links <a href="...">text</a>
  body = body.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
    const text = stripTags(inner);
    if (!text) return '';
    let resolved = href.trim();
    if (sourceUrl && /^\/[^/]/.test(resolved)) {
      try { resolved = new URL(resolved, sourceUrl).href; } catch { /* ignore */ }
    }
    return `[${text}](${resolved})`;
  });

  // Inline formatting
  body = body
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, inner) => `**${stripTags(inner)}**`)
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, inner) => `*${stripTags(inner)}*`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) => `\`${stripTags(inner)}\``);

  // List items & paragraphs
  body = body
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => {
      const text = stripTags(inner);
      return text ? `\n- ${text}` : '';
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|tr|ul|ol)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');

  const normalized = decodeEntities(body)
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const markdown = normalized || (description ? description : `Source: ${sourceUrl}`);
  return { title, description, markdown };
}

async function fetchArticleHtml(url, { fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AuraPetDaemon/1.0)' }
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching URL`);
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_HTML_BYTES) {
      throw new Error('Article HTML exceeds 2 MB limit');
    }
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_HTML_BYTES) {
      await reader.cancel();
      throw new Error('Article HTML exceeds 2 MB limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function slugify(text) {
  const clean = String(text || '')
    .toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5\u3040-\u30ff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return clean || 'note';
}

function writeInboxNote({ title, markdown, sourceUrl, kind = 'article', error = '' }, inboxDir) {
  fs.mkdirSync(inboxDir, { recursive: true });
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const filename = `${stamp}-${slugify(title || sourceUrl)}.md`;
  const filePath = path.join(inboxDir, filename);
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(title || sourceUrl)}`,
    `source_url: ${JSON.stringify(sourceUrl || '')}`,
    `kind: ${JSON.stringify(kind)}`,
    `saved_at: ${JSON.stringify(now.toISOString())}`,
    ...(error ? [`note_error: ${JSON.stringify(redactUrl(error))}`] : []),
    '---',
    '',
    `# ${title || sourceUrl}`,
    '',
    sourceUrl ? `> Source: ${sourceUrl}` : '',
    '',
    markdown || '',
    ''
  ].join('\n');
  fs.writeFileSync(filePath, frontmatter, 'utf8');
  return filePath;
}

/**
 * Resolve Joplin Clipper REST config from explicit settings or mcpUpstreams joplin entry.
 */
function resolveJoplinConfig(configStore) {
  if (!configStore) return null;
  const directUrl = configStore.get('joplinApiUrl');
  const directToken = configStore.get('joplinToken');
  const notebookId = configStore.get('joplinNotebookId') || '';
  if (typeof directUrl === 'string' && directUrl.trim() && typeof directToken === 'string' && directToken.trim()) {
    return { apiUrl: directUrl.trim().replace(/\/+$/, ''), token: directToken.trim(), notebookId };
  }
  const upstreams = configStore.get('mcpUpstreams');
  if (Array.isArray(upstreams)) {
    const joplin = upstreams.find((u) => u && u.name === 'joplin' && typeof u.url === 'string' && typeof u.token === 'string' && u.token.trim());
    if (joplin) {
      try {
        const parsed = new URL(joplin.url);
        return {
          apiUrl: `${parsed.protocol}//${parsed.host}`,
          token: joplin.token.trim(),
          notebookId
        };
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function saveToJoplin({ title, markdown, sourceUrl }, joplinConfig, { fetchImpl = globalThis.fetch } = {}) {
  const endpoint = `${joplinConfig.apiUrl}/notes?token=${encodeURIComponent(joplinConfig.token)}`;
  const bodyPayload = {
    title: title || sourceUrl,
    body: `${markdown}\n\n---\nSource: ${sourceUrl}`,
    source_url: sourceUrl,
    ...(joplinConfig.notebookId ? { parent_id: joplinConfig.notebookId } : {})
  };
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyPayload)
  });
  if (!res.ok) {
    throw new Error(`Joplin HTTP ${res.status}`);
  }
  const data = await res.json();
  return { noteId: data.id || 'joplin_note' };
}

/**
 * Ingest a URL end-to-end inside the mabi daemon:
 * - Emits pet speech bubbles (`🔗` -> `📝` or `⚠️`).
 * - Extracts article HTML to Markdown and saves to Joplin (or local Inbox fallback).
 * - If URL is a video and an upstream `*.video.download` MCP tool is available, delegates to it.
 */
async function ingestUrl(rawUrl, options = {}) {
  const {
    title: customTitle,
    cookiesFromBrowser,
    configStore,
    mcpClient,
    onBubble = () => {},
    fetchImpl = globalThis.fetch,
    inboxDir: explicitInboxDir
  } = options;

  const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'url must be a valid http(s) URL' };
  }

  const inboxDir = explicitInboxDir
    || (configStore && configStore.get('inboxDir'))
    || path.join(os.homedir(), '.config', 'aurapet-desktop', 'inbox');
  const { kind, host } = classifyUrl(url);
  const joplinConfig = resolveJoplinConfig(configStore);

  onBubble(`🔗 收到連結：${customTitle || host || url}`);

  try {
    if (kind === 'video' && mcpClient && typeof mcpClient.getTools === 'function') {
      const tools = mcpClient.getTools();
      const dlTool = tools.find((t) => t.name.endsWith('.video.download'))
        || tools.find((t) => t.name.endsWith('.download_video'));
      if (dlTool) {
        const dlRes = await mcpClient.callTool(dlTool.name, {
          url,
          ...(cookiesFromBrowser ? { cookiesFromBrowser } : {})
        });
        const dlPayload = dlRes?.structuredContent || (() => {
          try { return JSON.parse(dlRes?.content?.[0]?.text || '{}'); } catch { return {}; }
        })();
        if (dlPayload && dlPayload.ok && dlPayload.filePath) {
          const videoTitle = customTitle || dlPayload.filename || `Video (${host})`;
          const markdown = `Video downloaded via ${dlTool.name}.\n\n- Platform: ${dlPayload.platform || host}\n- File: \`${dlPayload.filePath}\`\n- Size: ${dlPayload.sizeMB ?? 0} MB`;
          if (joplinConfig) {
            try {
              const { noteId } = await saveToJoplin({ title: videoTitle, markdown, sourceUrl: url }, joplinConfig, { fetchImpl });
              onBubble(`📝 已存入筆記：${videoTitle}`);
              return { ok: true, kind: 'video', storage: 'joplin', noteId, title: videoTitle, filePath: dlPayload.filePath };
            } catch (joplinErr) {
              const inboxPath = writeInboxNote({ title: videoTitle, markdown, sourceUrl: url, kind: 'video', error: joplinErr.message }, inboxDir);
              onBubble(`📝 已存入筆記：${videoTitle}`);
              return { ok: true, kind: 'video', storage: 'inbox', inboxPath, title: videoTitle, filePath: dlPayload.filePath };
            }
          }
          const inboxPath = writeInboxNote({ title: videoTitle, markdown, sourceUrl: url, kind: 'video' }, inboxDir);
          onBubble(`📝 已存入筆記：${videoTitle}`);
          return { ok: true, kind: 'video', storage: 'inbox', inboxPath, title: videoTitle, filePath: dlPayload.filePath };
        }
      }
    }

    const html = await fetchArticleHtml(url, { fetchImpl });
    const extracted = htmlToMarkdown(html, url);
    const finalTitle = (customTitle || extracted.title || url).trim();
    const markdown = extracted.markdown;

    if (joplinConfig) {
      try {
        const { noteId } = await saveToJoplin({ title: finalTitle, markdown, sourceUrl: url }, joplinConfig, { fetchImpl });
        onBubble(`📝 已存入筆記：${finalTitle}`);
        return {
          ok: true,
          kind,
          storage: 'joplin',
          noteId,
          title: finalTitle,
          markdownLength: markdown.length
        };
      } catch (joplinErr) {
        const inboxPath = writeInboxNote({
          title: finalTitle,
          markdown,
          sourceUrl: url,
          kind,
          error: joplinErr.message
        }, inboxDir);
        onBubble(`📝 已存入筆記：${finalTitle}`);
        return {
          ok: true,
          kind,
          storage: 'inbox',
          inboxPath,
          title: finalTitle,
          markdownLength: markdown.length,
          note: `Joplin unreachable (${redactUrl(joplinErr.message)}); saved to local inbox`
        };
      }
    }

    const inboxPath = writeInboxNote({
      title: finalTitle,
      markdown,
      sourceUrl: url,
      kind
    }, inboxDir);
    onBubble(`📝 已存入筆記：${finalTitle}`);
    return {
      ok: true,
      kind,
      storage: 'inbox',
      inboxPath,
      title: finalTitle,
      markdownLength: markdown.length
    };
  } catch (error) {
    const cleanErr = redactUrl(error.message);
    const inboxPath = writeInboxNote({
      title: customTitle || url,
      markdown: `URL ingestion failed (${kind}).\n\nReason: ${cleanErr}`,
      sourceUrl: url,
      kind,
      error: cleanErr
    }, inboxDir);
    onBubble(`⚠️ 連結處理失敗：${cleanErr.slice(0, 60)}`);
    return {
      ok: false,
      kind,
      storage: 'inbox',
      inboxPath,
      error: cleanErr
    };
  }
}

module.exports = {
  VIDEO_HOSTS,
  classifyUrl,
  htmlToMarkdown,
  fetchArticleHtml,
  writeInboxNote,
  resolveJoplinConfig,
  saveToJoplin,
  ingestUrl
};
