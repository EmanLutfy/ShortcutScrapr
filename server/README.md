# scrapr-shortcut server

A small HTTP API on top of scrapr, for an iPhone Shortcut: share a link, get back direct media URLs, and the phone downloads the file itself.

No extra dependencies (Node `http` only). Chromium-based scrapers are never called.

## Run

```bash
cp .env.example .env    # set TOKENS
docker compose up -d --build
```

With HTTPS (Caddy, free certificate): set `DOMAIN` in `.env`, point its DNS A record at the server, then

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --build
```

Without Docker: `npm install --omit=optional && TOKENS=me=<token> node server/index.js`

## API

`GET /health` returns `{ "ok": true }`.

`POST /resolve`, header `X-Token: <token>`, body `{ "url": "<link or shared text>", "mode": "auto" | "audio" }`

```json
{
  "ok": true,
  "platform": "tiktok",
  "scraper": "tikdownloader",
  "title": "...",
  "kind": "video",
  "count": 1,
  "files": [{ "url": "https://...", "kind": "video", "ext": "mp4", "name": "tiktok_1795199110647.mp4" }]
}
```

On failure: `{ "ok": false, "error": "Link tak disokong", "code": "unsupported" }` with status 400/401/422/429/502/503.

## Platforms and fallback order

| Platform | Scrapers tried, in order |
|---|---|
| TikTok | tikdownloader, tiktokio, snaptik, ssstik |
| Instagram | indown, direct, snapsave |
| Facebook | snapsave |
| X / Twitter | direct, tvd, savetwt, tweeload |
| YouTube | ytmp3, ytmp3gg (`mode: "audio"`: ytmp3gg) |

Each link is checked (first byte fetched) before it is returned, so dead or HTML links fall through to the next scraper.

## Config (.env)

| Var | Default | |
|---|---|---|
| `TOKENS` | (required) | `name=token,name2=token2`, each token 16+ chars |
| `RATE_LIMIT` / `RATE_WINDOW_MS` | 30 / 600000 | per token |
| `MAX_CONCURRENT` | 4 | resolves at once |
| `TRUST_PROXY` | off | `1` behind Caddy/nginx |
| `BIND` / `HOST_PORT` | 127.0.0.1 / 3010 | docker port binding |
