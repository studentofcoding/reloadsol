# gmgn-web-proxy

Authenticated Cloudflare Worker that lets **flowey-vps** (Tencent Singapore) call gmgn.ai public web multi APIs.

## Why

`POST https://gmgn.ai/mrwapi/v1/multi_token_full_info` from the VPS (and from a Worker colocated in **SIN**) returns Cloudflare **403** HTML (`Attention Required`). The same call from a US colo (e.g. PDX/LAX) returns **200** JSON.

This Worker accepts requests with `X-Gmgn-Proxy-Secret`, then forwards via a **Durable Object** created with `locationHint: "wnam"` so the upstream fetch egresses from Western North America.

Live URL: `https://gmgn-web-proxy.yonathanevanchristy.workers.dev`

## App env (reloadsol-web)

```bash
GMGN_TOKEN_INFO_SOURCE=web
GMGN_WEB_HOST=https://gmgn-web-proxy.yonathanevanchristy.workers.dev
GMGN_WEB_PROXY_SECRET=<same value as Worker PROXY_SECRET>
```

## Deploy

```bash
cd workers/gmgn-web-proxy
npx wrangler deploy
echo -n "$SECRET" | npx wrangler secret put PROXY_SECRET
```

Allowed path prefixes: `/mrwapi/`, `/api/v1/`, `/vas/api/`.
