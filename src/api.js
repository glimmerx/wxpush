import { DETAIL_TTL_SECONDS, configuredRecipients, jsonResponse, randomId } from './common.js';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_TITLE_CHARS = 80;
const MAX_CONTENT_CHARS = 8000;
const WEEKLY_CRON = '0 2 * * MON';
const CLEANUP_CRON = '0 * * * *';

async function constantTimeEquals(left, right) {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let mismatch = 0;
  for (let i = 0; i < av.length; i++) mismatch |= av[i] ^ bv[i];
  return mismatch === 0;
}

async function authorized(request, env) {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.get('Authorization') || '');
  return Boolean(env.API_TOKEN && match && await constantTimeEquals(match[1], env.API_TOKEN));
}

async function readLimitedText(body, limit) {
  if (!body) return '';
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error('body_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function parseMessage(text, allowedRecipients) {
  const body = JSON.parse(text);
  if (!body || Array.isArray(body) || typeof body !== 'object' ||
      Object.keys(body).some(key => !['title', 'content', 'recipients'].includes(key))) {
    throw new Error('invalid_body');
  }
  const { title, content } = body;
  if (typeof title !== 'string' || typeof content !== 'string' ||
      !title.trim() || !content.trim() ||
      [...title].length > MAX_TITLE_CHARS || [...content].length > MAX_CONTENT_CHARS) {
    throw new Error('invalid_message');
  }
  let recipients = allowedRecipients;
  if (body.recipients !== undefined) {
    if (!Array.isArray(body.recipients) || body.recipients.length < 1 ||
        body.recipients.length > allowedRecipients.length ||
        body.recipients.some(value => typeof value !== 'string' || !allowedRecipients.includes(value)) ||
        new Set(body.recipients).size !== body.recipients.length) {
      throw new Error('invalid_recipients');
    }
    recipients = body.recipients;
  }
  return { title: title.trim(), content: content.trim(), recipients };
}

async function wechatJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error('wechat_http_error');
  return JSON.parse(await readLimitedText(response.body, 16 * 1024));
}

async function wechatToken(env) {
  const data = await wechatJson('https://api.weixin.qq.com/cgi-bin/stable_token', {
    grant_type: 'client_credential',
    appid: env.WX_APPID,
    secret: env.WX_SECRET,
    force_refresh: false,
  });
  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error(`wechat_token_${Number(data.errcode) || 'unknown'}`);
  }
  return data.access_token;
}

async function sendMessage(env, token, recipient, title, summary, detailUrl) {
  const data = await wechatJson(
    `https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${encodeURIComponent(token)}`,
    {
      touser: recipient,
      template_id: env.WX_TEMPLATE_ID,
      url: detailUrl,
      data: { title: { value: title }, content: { value: summary } },
    },
  );
  return { ok: data.errcode === 0, code: Number(data.errcode) || 0 };
}

function origin(env) {
  const url = new URL(env.VIEW_ORIGIN);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash ||
      url.hostname !== 'push.matrixsku.com') {
    throw new Error('invalid_view_origin');
  }
  return url.origin;
}

function ready(env) {
  return Boolean(env.DB && env.API_TOKEN && env.WX_APPID && env.WX_SECRET &&
    env.WX_USERID && env.WX_TEMPLATE_ID && env.VIEW_ORIGIN && env.API_HOST);
}

async function deliver(env, message, now) {
  const detailOrigin = origin(env);
  const id = randomId();
  const expiresAt = now + DETAIL_TTL_SECONDS;
  await env.DB.prepare(
    'INSERT INTO messages (id, title, content, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(id, message.title, message.content, now, expiresAt).run();

  const token = await wechatToken(env);
  const detailUrl = `${detailOrigin}/m/${id}`;
  const summary = [...message.content.replace(/\s+/g, ' ')].slice(0, 180).join('');
  const results = await Promise.allSettled(message.recipients.map(recipient =>
    sendMessage(env, token, recipient, message.title, summary, detailUrl)));
  const succeeded = results.filter(result => result.status === 'fulfilled' && result.value.ok).length;
  const failed = results.length - succeeded;
  console.log(JSON.stringify({ event: 'wechat_delivery', succeeded, failed }));
  return { id, expiresAt, succeeded, failed };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== env.API_HOST || url.protocol !== 'https:') {
      return jsonResponse(404, { error: 'not_found' });
    }
    if (url.pathname !== '/wxsend') return jsonResponse(404, { error: 'not_found' });
    if (request.method !== 'POST') {
      return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    }
    if (!ready(env)) return jsonResponse(503, { error: 'service_unavailable' });
    if (!await authorized(request, env)) return jsonResponse(401, { error: 'unauthorized' });
    if (url.search || request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return jsonResponse(400, { error: 'invalid_request' });
    }
    const declaredLength = Number(request.headers.get('Content-Length'));
    if (declaredLength > MAX_BODY_BYTES) return jsonResponse(413, { error: 'body_too_large' });

    let message;
    try {
      message = parseMessage(await readLimitedText(request.body, MAX_BODY_BYTES), configuredRecipients(env));
    } catch (error) {
      if (error.message === 'body_too_large') return jsonResponse(413, { error: 'body_too_large' });
      if (error.message === 'invalid_recipient_configuration') return jsonResponse(503, { error: 'service_unavailable' });
      return jsonResponse(400, { error: 'invalid_message' });
    }

    try {
      const result = await deliver(env, message, Math.floor(Date.now() / 1000));
      return jsonResponse(result.failed ? 502 : 200, {
        id: result.id,
        detail_url: `${origin(env)}/m/${result.id}`,
        expires_at: result.expiresAt,
        sent: result.succeeded,
        failed: result.failed,
      });
    } catch (error) {
      const type = error.message.startsWith('wechat_token_') ? error.message : 'internal';
      console.error(JSON.stringify({ event: 'wechat_delivery_error', type }));
      return jsonResponse(502, { error: 'delivery_failed' });
    }
  },

  async scheduled(event, env) {
    const now = Math.floor(Date.now() / 1000);
    if (event.cron === CLEANUP_CRON) {
      const result = await env.DB.prepare('DELETE FROM messages WHERE expires_at <= ?').bind(now).run();
      console.log(JSON.stringify({ event: 'detail_cleanup', deleted: result.meta?.changes ?? 0 }));
      return;
    }
    if (event.cron !== WEEKLY_CRON) throw new Error('unexpected_cron');
    if (!ready(env)) throw new Error('service_unavailable');
    const message = {
      title: 'WXPush 保活',
      content: '每周保活消息',
      recipients: configuredRecipients(env),
    };
    const result = await deliver(env, message, now);
    if (result.failed) throw new Error('keepalive_delivery_failed');
  },
};
