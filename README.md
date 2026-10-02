# WXPush hardened Cloudflare fork

Based on [frankiejun/wxpush](https://github.com/frankiejun/wxpush) at commit
`52e2051a93e6042bc7155065cc12dd3c64d0d70f`. The original MIT license is
retained in `LICENSE`. This fork targets Cloudflare Workers only. The original
single Worker, Docker image, `GET /wxsend`, token-in-URL test page, and request
credential overrides are intentionally removed.

## Architecture

| Component | Address | Access | Purpose |
| --- | --- | --- | --- |
| API Worker | `https://push-api.matrixsku.com/wxsend` | Cloudflare Access Service Token **and** application Bearer | Receives agent requests, stores details, sends WeChat template messages |
| View Worker | `https://push.matrixsku.com/m/<random-id>` | Public bearer-by-link | Displays escaped text until exactly 3 days after creation |
| D1 | `wxpush-messages` | Worker bindings only | Stores full title/content and expiry; hourly cleanup |

The `matrixsku.com` deployment was created on 2026-10-02. Its D1 database ID
is `e8dc4070-ae3d-4ffd-8da8-a05b9935b0a1` (APAC); the API and View Worker
names are `wxpush-api` and `wxpush-view`. The API Worker has Worker-level
Cloudflare Access on **all traffic**, with the reusable
`wxpush-codex-service-auth` policy limited to the `wxpush-codex-agent` Service
Token. The current live verification is recorded in `verification.md`.

The WeChat template receives the title, a 180-character plaintext preview, and
the opaque detail URL. It does **not** receive the full message in the URL.
Anyone with a detail URL can read it during its 3-day lifetime. Treat the link
as shareable, not private. Do not send secrets or highly sensitive content.

Cron is UTC: `0 2 * * MON` = Monday `10:00` Asia/Shanghai sends the weekly
keepalive; `0 * * * *` cleans expired D1 rows hourly. The View Worker checks
expiry on every request, so a row is unreadable at 72 hours even before
physical cleanup (normally within the following hour). Logs contain counts
and error categories, never content,
OpenIDs, API tokens, or WeChat access tokens.

## Prerequisites

- A Cloudflare account controlling `matrixsku.com`, with Workers, D1, and
  Cloudflare Access enabled.
- A WeChat test account or compatible official account with `WX_APPID`,
  `WX_SECRET`, at least one follower's OpenID, and `WX_TEMPLATE_ID`.
- Template body with the exact fields `{{title.DATA}}` and `{{content.DATA}}`.
- Node.js 22+ and `npm install` for local validation and Wrangler.

Never put `WX_SECRET`, `API_TOKEN`, OpenIDs, or Cloudflare Access client secret
in the repository, the JSONC configs, shell history, or chat. Enter Worker
secrets interactively through Wrangler or the Cloudflare dashboard. `WX_USERID`
is treated as a secret because it identifies recipients.

## Provision

1. Run `npm install`, then `npm test` and both dry runs:

   ```sh
   npx wrangler deploy --dry-run --config wrangler.api.jsonc
   npx wrangler deploy --dry-run --config wrangler.view.jsonc
   ```

2. Create an independent D1 database:

   ```sh
   npx wrangler d1 create wxpush-messages
   ```

   This checkout already contains the database ID for `matrixsku.com`. For a
   different Cloudflare account, replace that ID in **both** JSONC files with
   the new database ID. Apply the schema before sending:

   ```sh
   npx wrangler d1 migrations apply wxpush-messages --remote --config wrangler.api.jsonc
   ```

3. Deploy the API Worker **without secrets**; it returns 503 to send requests
   until all required secrets are present. In Zero Trust, create a dedicated
   Service Token and a reusable **Service Auth** policy whose Include rule is
   that specific token (not "Any Access Service Token"). In Workers & Pages,
   open `wxpush-api` > Access > Protect this Worker behind Access, select
   **All traffic**, and attach that policy. This protects production and
   preview routes. Confirm a request without Access headers receives 403
   before setting the WeChat secrets. Do not protect `wxpush-view` this way:
   its random detail links must open in WeChat without an Access login.

   ```sh
   npx wrangler deploy --config wrangler.api.jsonc
   ```

4. Enter the API secrets, then deploy the View Worker:

   ```sh
   npx wrangler secret put API_TOKEN --config wrangler.api.jsonc
   npx wrangler secret put WX_APPID --config wrangler.api.jsonc
   npx wrangler secret put WX_SECRET --config wrangler.api.jsonc
   npx wrangler secret put WX_USERID --config wrangler.api.jsonc
   npx wrangler secret put WX_TEMPLATE_ID --config wrangler.api.jsonc
   npx wrangler deploy --config wrangler.view.jsonc
   ```

   `API_TOKEN` should be a newly generated random value of at least 32 bytes.
   `WX_USERID` is one or more allowlisted OpenIDs separated by `|`, at most 10.
   Both Workers bind the same D1 database. Workers.dev is disabled in both
   configs; preview URLs are also disabled. The API and View hosts are separate
   Custom Domains, and each Worker checks its expected hostname. Ensure no
   extra route bypasses Access. Cloudflare Access enforcement must be verified
   separately after the application policy is configured.

5. Add a Cloudflare WAF rate limit for the API hostname/path (start with a low
   per-minute limit suited to the agent) and an alert for failed Cron/Worker
   requests. Test Access rejection, Bearer rejection, a real test message,
   detail rendering, expiry behavior, and the weekly Cron in a non-production
   environment before depending on it. Access is enforced by Cloudflare's
   edge policy; the Worker independently checks the Bearer token.

## Codex agent request

Give Codex only the endpoint and the names of the three credentials it must
retrieve from its secret environment. Do not paste values into prompts or logs.
On this machine, the three Codex caller credentials are in
`$HOME/.config/wxpush-codex/credentials.env` (directory `0700`, file `0600`).
The included caller reads them from the environment rather than putting their
values in shell arguments/history:

```sh
node --env-file="$HOME/.config/wxpush-codex/credentials.env" scripts/send.mjs < message.json
```

`message.json` contains e.g. `{"title":"任务完成","content":"构建已完成。"}`.
The caller sends all three headers. Equivalent cURL for diagnostics (be aware
the expanded header values can appear in the process list):

```sh
curl --fail-with-body -sS https://push-api.matrixsku.com/wxsend \
  -H "CF-Access-Client-Id: $WX_CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $WX_CF_ACCESS_CLIENT_SECRET" \
  -H "Authorization: Bearer $WX_API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"title":"任务完成","content":"构建已完成。"}'
```

Only `title` (1-80 Unicode characters), `content` (1-8000 Unicode characters),
and optional `recipients` (array containing only configured OpenIDs) are
accepted. Maximum request body size is 16 KiB. Omit `recipients` to send to all
configured users. GET, query parameters, form data, body tokens, per-request
WeChat credentials, and arbitrary recipients are rejected.

Successful response: HTTP 200 with `id`, `detail_url`, `expires_at` (Unix
seconds), `sent`, and `failed`. A partial/total WeChat failure returns HTTP 502
with the counts; validation returns 4xx. Do not retry a 502 blindly: some
recipients may already have received a message. The API currently has no
idempotency key.

## Verify and rollback

Run `npm test` and both Wrangler dry runs before each deployment. The
`verification.md` file records the exact baseline and modified checks for this
fork. `changes.patch` is the patch against the pinned upstream commit.
`rollback.sh` restores the upstream source/configuration into an **explicit
destination directory**, never the live checkout or Cloudflare deployment.
For a deployed rollback, use Cloudflare Workers version rollback for each
Worker, while retaining D1 until all detail links have expired; restore the
Access policy before exposing an older API version because upstream accepts
token-in-URL requests.
