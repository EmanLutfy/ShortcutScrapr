const http = require("http");
const crypto = require("crypto");
const axios = require("axios");
const { resolve, ResolveError } = require("./resolve");

axios.defaults.timeout = 25000;

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 30); // requests per token per window
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 10 * 60 * 1000);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 4);
const MAX_BODY = 10 * 1024;

// TOKENS="aiman=longrandom,ali=otherrandom". The name only shows in logs.
function loadTokens() {
  const raw = process.env.TOKENS || "";
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf("=");
      return i > 0 ? { name: pair.slice(0, i), token: pair.slice(i + 1) } : null;
    })
    .filter((t) => t && t.token.length >= 16);
  if (!list.length) {
    console.error("TOKENS is empty or every token is shorter than 16 chars. Refusing to start.");
    process.exit(1);
  }
  return list;
}
const TOKENS = loadTokens();

function hash(s) {
  return crypto.createHash("sha256").update(s).digest();
}
const TOKEN_HASHES = TOKENS.map((t) => ({ name: t.name, h: hash(t.token) }));

function whoIs(token) {
  if (typeof token !== "string" || !token) return null;
  const h = hash(token);
  let found = null;
  for (const t of TOKEN_HASHES) if (crypto.timingSafeEqual(h, t.h)) found = t.name;
  return found;
}

// Fixed-window counters, keyed by token name or by IP for failed logins.
const buckets = new Map();
function hit(key, limit) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > RATE_WINDOW_MS) {
    b = { start: now, n: 0 };
    buckets.set(key, b);
  }
  b.n += 1;
  return b.n <= limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now - b.start > RATE_WINDOW_MS) buckets.delete(k);
}, 60 * 1000).unref();

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers["x-forwarded-for"];
    if (xf) return String(xf).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "?";
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new ResolveError("too_large", "Request terlalu besar", 413));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        ok(text ? JSON.parse(text) : {});
      } catch {
        // Also accept a plain-text body holding just the link.
        ok({ url: text });
      }
    });
    req.on("error", fail);
  });
}

let active = 0;

async function handleResolve(req, res) {
  const ip = clientIp(req);
  const user = whoIs(req.headers["x-token"]);
  if (!user) {
    if (!hit(`ip:${ip}`, 10)) return send(res, 429, { ok: false, error: "Terlalu banyak cubaan" });
    return send(res, 401, { ok: false, error: "Token salah atau tiada" });
  }
  if (!hit(`user:${user}`, RATE_LIMIT)) {
    return send(res, 429, { ok: false, error: "Had penggunaan dicapai. Cuba lagi sekejap lagi." });
  }
  if (active >= MAX_CONCURRENT) return send(res, 503, { ok: false, error: "Server sibuk. Cuba lagi." });

  active += 1;
  const t0 = Date.now();
  let platform = "-";
  try {
    const body = await readJson(req);
    const mode = body.mode === "audio" ? "audio" : "auto";
    const out = await resolve(body.url, { mode });
    platform = out.platform;
    console.log(`${new Date().toISOString()} ${user} ${platform} ok ${out.scraper} ${out.count} ${Date.now() - t0}ms`);
    send(res, 200, out);
  } catch (e) {
    const status = e instanceof ResolveError ? e.status : 500;
    platform = e.platform || platform;
    const tried = e.tried ? e.tried.map((t) => `${t.scraper}:${t.error}`).join(" | ") : e.message;
    console.log(`${new Date().toISOString()} ${user} ${platform} fail ${status} ${Date.now() - t0}ms ${tried}`);
    send(res, status, {
      ok: false,
      error: e instanceof ResolveError ? e.message : "Ralat server",
      code: e.code || "server_error",
      tried: e.tried,
    });
  } finally {
    active -= 1;
  }
}

const server = http.createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];
  if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });
  if (req.method === "POST" && path === "/resolve") return handleResolve(req, res);
  send(res, 404, { ok: false, error: "Not found" });
});

server.requestTimeout = 90 * 1000;
server.listen(PORT, HOST, () => {
  console.log(`scrapr-shortcut listening on ${HOST}:${PORT} (${TOKENS.length} token(s))`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
