import test from 'node:test';
import assert from 'node:assert/strict';
import api from '../src/api.js';
import view from '../src/view.js';

const API_URL = 'https://push-api.matrixsku.com/wxsend';
const NOW = 1_800_000_000;

function database() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      let params;
      return {
        bind(...values) { params = values; return this; },
        async run() {
          if (sql.startsWith('INSERT')) {
            const [id, title, content, created_at, expires_at] = params;
            rows.set(id, { title, content, created_at, expires_at });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith('DELETE')) {
            let changes = 0;
            for (const [id, value] of rows) {
              if (value.expires_at <= params[0]) { rows.delete(id); changes++; }
            }
            return { meta: { changes } };
          }
          throw new Error('unexpected SQL');
        },
        async first() {
          if (!sql.startsWith('SELECT')) throw new Error('unexpected SQL');
          return rows.get(params[0]) || null;
        },
      };
    },
  };
}

function env(db = database()) {
  return {
    DB: db,
    API_HOST: 'push-api.matrixsku.com',
    VIEW_HOST: 'push.matrixsku.com',
    VIEW_ORIGIN: 'https://push.matrixsku.com',
    API_TOKEN: 'sample-bearer-token',
    WX_APPID: 'sample-appid',
    WX_SECRET: 'sample-secret',
    WX_USERID: 'allowed-a|allowed-b',
    WX_TEMPLATE_ID: 'sample-template',
  };
}

function request(body, options = {}) {
  return new Request(options.url || API_URL, {
    method: options.method || 'POST',
    headers: {
      Authorization: options.authorization ?? 'Bearer sample-bearer-token',
      'Content-Type': options.contentType || 'application/json',
    },
    body: options.method === 'GET' ? undefined : JSON.stringify(body),
  });
}

function mockWechat(t) {
  const sends = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const payload = JSON.parse(options.body);
    if (url.endsWith('/stable_token')) {
      assert.equal(payload.secret, 'sample-secret');
      return Response.json({ access_token: 'sample-wechat-token' });
    }
    assert.match(url, /message\/template\/send/);
    sends.push(payload);
    return Response.json({ errcode: 0, errmsg: 'ok' });
  });
  return sends;
}

test('method, host, and bearer are enforced before body parsing', async () => {
  const config = env();
  assert.equal((await api.fetch(new Request(API_URL), config)).status, 405);
  assert.equal((await api.fetch(request({ title: 'a', content: 'b' }, {
    url: 'https://push.matrixsku.com/wxsend',
  }), config)).status, 404);
  assert.equal((await api.fetch(request({ title: 'a', content: 'b' }, {
    authorization: 'wrong',
  }), config)).status, 401);
  assert.equal((await api.fetch(new Request('https://push-api.matrixsku.com/sample-bearer-token'), config)).status, 404);
});

test('query/body credentials, recipient overrides, malformed and oversize messages are rejected', async () => {
  const config = env();
  const cases = [
    request({ title: 'a', content: 'b' }, { url: `${API_URL}?token=sample-bearer-token` }),
    request({ title: 'a', content: 'b', token: 'sample-bearer-token' }),
    request({ title: 'a', content: 'b', appid: 'override' }),
    request({ title: 'a', content: 'b', recipients: ['not-allowed'] }),
    request({ title: 'a', content: 'b', recipients: ['allowed-a', 'allowed-a'] }),
    request({ title: '', content: 'b' }),
    request({ title: 'a'.repeat(81), content: 'b' }),
    request({ title: 'a', content: 'b'.repeat(8001) }),
  ];
  for (const item of cases) assert.equal((await api.fetch(item, config)).status, 400);
  assert.equal((await api.fetch(request({ title: 'a', content: 'b'.repeat(17000) }), config)).status, 413);
  assert.equal(config.DB.rows.size, 0);
});

test('send stores full content only in D1; public detail escapes HTML and expires at 3 days', async t => {
  const config = env();
  const sends = mockWechat(t);
  t.mock.method(Date, 'now', () => NOW * 1000);
  t.mock.method(console, 'log', () => {});
  const response = await api.fetch(request({
    title: '<Alert>',
    content: '<script>alert(1)</script>\n' + 'detail '.repeat(40),
    recipients: ['allowed-a'],
  }), config);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);
  assert.match(result.detail_url, /^https:\/\/push\.matrixsku\.com\/m\/[A-Za-z0-9_-]{32}$/);
  assert.equal(result.expires_at, NOW + 259200);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].touser, 'allowed-a');
  assert.equal(sends[0].url, result.detail_url);
  assert.equal(sends[0].data.title.value, '<Alert>');
  assert.ok(sends[0].data.content.value.length <= 180);
  assert.ok(!sends[0].url.includes('script'));
  assert.equal(config.DB.rows.size, 1);

  const detail = await view.fetch(new Request(result.detail_url), config);
  assert.equal(detail.status, 200);
  assert.equal(detail.headers.get('Cache-Control'), 'no-store, private');
  assert.equal(detail.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(detail.headers.get('Content-Security-Policy'), /default-src 'none'/);
  const html = await detail.text();
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.equal((await view.fetch(new Request(result.detail_url, { method: 'HEAD' }), config)).status, 200);
  assert.equal((await view.fetch(new Request(result.detail_url + '?content=leak'), config)).status, 404);
  assert.equal((await view.fetch(new Request(result.detail_url.replace('push.matrixsku.com', 'push-api.matrixsku.com')), config)).status, 404);

  t.mock.restoreAll();
  const expiredNow = (NOW + 259200) * 1000;
  const originalNow = Date.now;
  Date.now = () => expiredNow;
  try { assert.equal((await view.fetch(new Request(result.detail_url), config)).status, 410); }
  finally { Date.now = originalNow; }
});

test('weekly keepalive sends and hourly cleanup removes expired records', async t => {
  const config = env();
  const sends = mockWechat(t);
  t.mock.method(Date, 'now', () => NOW * 1000);
  t.mock.method(console, 'log', () => {});
  await api.scheduled({ cron: '0 2 * * MON' }, config);
  assert.equal(sends.length, 2);
  assert.equal(config.DB.rows.size, 1);
  t.mock.restoreAll();
  const originalNow = Date.now;
  const originalLog = console.log;
  Date.now = () => (NOW + 259201) * 1000;
  console.log = () => {};
  try {
    await api.scheduled({ cron: '0 * * * *' }, config);
    assert.equal(config.DB.rows.size, 0);
  } finally {
    Date.now = originalNow;
    console.log = originalLog;
  }
});

test('partial WeChat failure returns counts without leaking message data', async t => {
  const config = env();
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/stable_token')) return Response.json({ access_token: 'sample-wechat-token' });
    const payload = JSON.parse(options.body);
    return Response.json({ errcode: payload.touser === 'allowed-a' ? 0 : 40003 });
  });
  const response = await api.fetch(request({ title: 'alert', content: 'sensitive detail' }), config);
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.match(body, /"sent":1,"failed":1/);
  assert.ok(!body.includes('sensitive detail'));
  assert.ok(!body.includes('sample-wechat-token'));
});
