# Verification record (2026-10-02)

Working directory for baseline and modified commands:
`/Users/geek/Desktop/devops/private-cloud/private-gitlab/ai-life/wxpush-hardened`.
The local baseline and modified checks used sample values only. The live
checks below used Cloudflare Worker Secrets and a protected local client
credential file; no credential value or bearer-by-link detail URL is recorded.

## Pinned baseline

Upstream commit: `52e2051a93e6042bc7155065cc12dd3c64d0d70f`.
Original `src/index.js` SHA-256:
`795aba8d9fcb72d7f379118850dc300257ed37650a529393c07c03876e20a4fe`.

Command (run before modification):

```sh
node --input-type=module -e "import w from './src/index.js'; const r=await w.fetch(new Request('https://push-api.matrixsku.com/wxsend'), {API_TOKEN:'SAMPLE'}, {}); console.log(r.status, await r.text())"
```

Literal output; exit `0`:

```text
400 {"msg":"Missing required parameters: content, title, token"}
```

Command (run before modification):

```sh
node --input-type=module -e "import w from './src/index.js'; const r=await w.fetch(new Request('https://push-api.matrixsku.com/SAMPLE'), {API_TOKEN:'SAMPLE'}, {}); const body=await r.text(); console.log(r.status, body.includes('当前 token (来自路径)'), body.includes('<strong>SAMPLE</strong>'))"
```

Literal output; exit `0`:

```text
200 true true
```

## Hardened behavior

Command:

```sh
node --input-type=module -e "import w from './src/api.js'; const e={API_HOST:'push-api.matrixsku.com',API_TOKEN:'SAMPLE',WX_APPID:'a',WX_SECRET:'s',WX_USERID:'u',WX_TEMPLATE_ID:'t',VIEW_ORIGIN:'https://push.matrixsku.com',DB:{}}; const a=await w.fetch(new Request('https://push-api.matrixsku.com/wxsend'),e); const b=await w.fetch(new Request('https://push-api.matrixsku.com/SAMPLE'),e); console.log(a.status,await a.text()); console.log(b.status,await b.text())"
```

Literal output; exit `0`:

```text
405 {"error":"method_not_allowed"}
404 {"error":"not_found"}
```

Command: `npm test`. Literal TAP summary; exit `0`:

```text
1..5
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Commands (each exit `0`):

```sh
npx wrangler deploy --dry-run --config wrangler.api.jsonc
npx wrangler deploy --dry-run --config wrangler.view.jsonc
```

Literal terminal conclusion from each:

```text
--dry-run: exiting now.
```

The dry runs validated bundling and config syntax only. The production
provisioning and smoke test are recorded below.

## Rollback exercise

Command:

```sh
./rollback.sh /tmp/wxpush-rollback-check-20261002-001
```

Literal output; exit `0`:

```text
Restored upstream 52e2051a93e6042bc7155065cc12dd3c64d0d70f into /tmp/wxpush-rollback-check-20261002-001
Verified src/index.js SHA-256: 795aba8d9fcb72d7f379118850dc300257ed37650a529393c07c03876e20a4fe
```

Command:

```sh
node --input-type=module -e "import w from '/tmp/wxpush-rollback-check-20261002-001/src/index.js'; const r=await w.fetch(new Request('https://push-api.matrixsku.com/SAMPLE'),{API_TOKEN:'SAMPLE'},{}); console.log(r.status,(await r.text()).includes('<strong>SAMPLE</strong>'))"
```

Literal output; exit `0`:

```text
200 true
```

## Live deployment and smoke test

Account: the Cloudflare account controlling `matrixsku.com`. Wrangler 4.146.0
OAuth used `account:read`, `user:read`, `workers_scripts:write`,
`workers_routes:write`, `d1:write`, and `zone:read`, with credentials encrypted
using the macOS Keychain. No existing Worker or D1 database was changed.

Commands and observed results (all exit `0` unless noted):

```sh
./node_modules/.bin/wrangler d1 create wxpush-messages --location apac
# Successfully created DB 'wxpush-messages' in region APAC
# database_id: e8dc4070-ae3d-4ffd-8da8-a05b9935b0a1

./node_modules/.bin/wrangler d1 migrations apply wxpush-messages --remote --config wrangler.api.jsonc
# 0001_messages.sql: success

./node_modules/.bin/wrangler deploy --config wrangler.api.jsonc
# wxpush-api; push-api.matrixsku.com; 0 2 * * MON; 0 * * * *
# initial upload version 13632c14-95b5-486d-b3b1-aeff5eabad98

./node_modules/.bin/wrangler deploy --config wrangler.view.jsonc
# wxpush-view; push.matrixsku.com
# initial upload version 7388797a-acc9-4ae4-ad07-6907c910f195
```

In Cloudflare One, created the one-year `wxpush-codex-agent` Service Token,
the `wxpush-codex-service-auth` Service Auth policy including only that token,
and attached it to the API Worker with **All traffic** scope. The Worker Access
page confirmed production and preview coverage. The local caller credential
file is `$HOME/.config/wxpush-codex/credentials.env` with mode `0600`; the
Cloudflare API Worker lists `API_TOKEN`, `WX_APPID`, `WX_SECRET`, `WX_USERID`,
and `WX_TEMPLATE_ID` as secrets. The View Worker has no WeChat secrets.

```sh
curl --max-time 20 -sS -D - -o /dev/null -X POST https://push-api.matrixsku.com/wxsend \
  -H 'Content-Type: application/json' --data '{"title":"probe","content":"no send"}'
# HTTP/2 403 (Cloudflare Access; exit 0)

printf '%s' '{"title":"wxpush 部署验证","content":"这是一条部署测试消息。点击查看完整详情，链接有效期为 3 天。"}' | \
  node --env-file="$HOME/.config/wxpush-codex/credentials.env" scripts/send.mjs
# HTTP 200, sent=1, failed=0, detail_url and expires_at present (exit 0)
```

With valid Access headers but no or an incorrect Bearer, the API returned
`401 {"error":"unauthorized"}` (exit `0` for the read-only Node probe). Before
the Worker Secrets were set, valid Access headers reached the API and returned
`503 {"error":"service_unavailable"}`. A real WeChat sandbox message titled
`wxpush 部署验证` returned HTTP 200, `sent=1`, `failed=0`, a random detail URL,
and an expiry timestamp. A GET to that URL returned HTTP 200 with the expected
title/body, `Cache-Control: no-store, private`, `Referrer-Policy: no-referrer`,
and a restrictive CSP; the HTML contained no `<script>`. A random unknown ID
returned 404. The remote D1 query returned `message_count=1` and
`min_ttl_seconds=259200`. Account-side `POST /cgi-bin/stable_token` returned
HTTP 200 with an access token present and `expires_in=7200`; no token was
printed. The exact 72-hour cutoff and scheduled handler were also exercised
by the five local tests. Actual receipt and tap-through in WeChat await a
device-side confirmation; the future Monday Cron has not yet fired.

## Patch replay

Commands on a fresh disposable copy (each exit `0`):

```sh
./rollback.sh /tmp/wxpush-patch-replay-20261002-002
git -C /tmp/wxpush-patch-replay-20261002-002 apply --check /Users/geek/Desktop/devops/private-cloud/private-gitlab/ai-life/wxpush-hardened/changes.patch
git -C /tmp/wxpush-patch-replay-20261002-002 apply /Users/geek/Desktop/devops/private-cloud/private-gitlab/ai-life/wxpush-hardened/changes.patch
```

The `git apply --check` and `git apply` commands produced no output. The
restored source hash was the pinned baseline hash above. Running the modified
behavior command from the patch-replay directory produced:

```text
405 {"error":"method_not_allowed"}
404 {"error":"not_found"}
```
