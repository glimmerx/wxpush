import { escapeHtml } from './common.js';

const PUBLIC_HEADERS = {
  'Cache-Control': 'no-store, private',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function errorResponse(status) {
  return new Response(status === 410 ? '消息已过期' : '未找到消息', {
    status,
    headers: { ...PUBLIC_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function render(message) {
  const title = escapeHtml(message.title);
  const content = escapeHtml(message.content);
  const date = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(message.created_at * 1000));
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f4f7f8; color: #172b30; }
    main { max-width: 760px; margin: 0 auto; padding: 32px 20px 56px; }
    header { border-bottom: 1px solid #cbd6d9; padding-bottom: 20px; margin-bottom: 24px; }
    h1 { font-size: 24px; line-height: 1.35; margin: 0 0 12px; overflow-wrap: anywhere; }
    time { color: #596b70; font-size: 14px; }
    article { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.75; font-size: 16px; }
  </style>
</head>
<body><main><header><h1>${title}</h1><time>${date} (北京时间)</time></header><article>${content}</article></main></body>
</html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol !== 'https:' || url.hostname !== env.VIEW_HOST || url.search) {
      return errorResponse(404);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { ...PUBLIC_HEADERS, Allow: 'GET, HEAD' },
      });
    }
    const match = /^\/m\/([A-Za-z0-9_-]{32})$/.exec(url.pathname);
    if (!match) return errorResponse(404);
    if (!env.DB) return new Response('Service Unavailable', { status: 503, headers: PUBLIC_HEADERS });

    try {
      const message = await env.DB.prepare(
        'SELECT title, content, created_at, expires_at FROM messages WHERE id = ?',
      ).bind(match[1]).first();
      if (!message) return errorResponse(404);
      if (message.expires_at <= Math.floor(Date.now() / 1000)) return errorResponse(410);
      return new Response(request.method === 'HEAD' ? null : render(message), {
        headers: { ...PUBLIC_HEADERS, 'Content-Type': 'text/html; charset=utf-8' },
      });
    } catch {
      return new Response('Service Unavailable', { status: 503, headers: PUBLIC_HEADERS });
    }
  },
};
