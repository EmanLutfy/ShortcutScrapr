const axios = require("axios");
const scrapr = require("../index.js");

const SCRAPER_TIMEOUT_MS = Number(process.env.SCRAPER_TIMEOUT_MS || 30000);
const TOTAL_TIMEOUT_MS = Number(process.env.TOTAL_TIMEOUT_MS || 55000);
const VERIFY_TIMEOUT_MS = 10000;

// Order = try first to last. Chromium-based scrapers (tiktok.savetik,
// instagram.snapinsta, facebook.fdown) are left out on purpose.
const CHAINS = {
  tiktok: ["tikdownloader", "tiktokio", "snaptik", "ssstik"],
  instagram: ["indown", "direct", "snapsave"],
  facebook: ["snapsave"],
  twitter: ["direct", "tvd", "savetwt", "tweeload"],
  youtube: ["ytmp3", "ytmp3gg"],
};
const AUDIO_CHAINS = {
  youtube: ["ytmp3gg"],
};

const HOSTS = [
  [/(^|\.)tiktok\.com$/, "tiktok"],
  [/(^|\.)(instagram\.com|instagr\.am)$/, "instagram"],
  [/(^|\.)(facebook\.com|fb\.watch|fb\.com)$/, "facebook"],
  [/(^|\.)(x\.com|twitter\.com)$/, "twitter"],
  [/(^|\.)(youtube\.com|youtu\.be)$/, "youtube"],
];

class ResolveError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Share Sheet sometimes sends "caption text https://..." instead of a bare URL.
function extractUrl(input) {
  if (typeof input !== "string") return null;
  const m = input.match(/https?:\/\/[^\s<>"']+/i);
  if (!m) return null;
  try {
    return new URL(m[0]);
  } catch {
    return null;
  }
}

function detectPlatform(url) {
  const host = url.hostname.toLowerCase();
  for (const [re, name] of HOSTS) if (re.test(host)) return name;
  return null;
}

function withTimeout(promise, ms, label) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

const IMAGE_EXT = /\.(jpe?g|png|webp|heic|gif)(\?|$)/i;

function classify(d) {
  const type = String(d.type || "").toLowerCase();
  const hint = `${d.quality || ""} ${d.url}`.toLowerCase();
  const path = (() => {
    try {
      return new URL(d.url).pathname;
    } catch {
      return "";
    }
  })();
  if (/audio|music|mp3/.test(type)) return "audio";
  if (/image|photo/.test(type)) return "image";
  if (/video|mp4/.test(type)) return IMAGE_EXT.test(path) ? "image" : "video";
  if (IMAGE_EXT.test(path) || /\/image\b/.test(hint)) return "image";
  if (/mp3|audio|music|\.m4a/.test(hint)) return "audio";
  return "video";
}

function score(quality) {
  const q = String(quality || "");
  const n = q.match(/(\d{3,4})p?/);
  if (n) return Number(n[1]);
  if (/hd/i.test(q)) return 720;
  if (/normal|sd/i.test(q)) return 360;
  return 500;
}

function extFor(kind, contentType) {
  const ct = String(contentType || "").toLowerCase();
  if (kind === "image") {
    if (ct.includes("png")) return "png";
    if (ct.includes("webp")) return "webp";
    if (ct.includes("gif")) return "gif";
    return "jpg";
  }
  if (kind === "audio") return ct.includes("mp4") || ct.includes("m4a") ? "m4a" : "mp3";
  return "mp4";
}

// Fetch the first byte: proves the link is alive and is media, not an error page.
async function verify(url) {
  try {
    const res = await axios.get(url, {
      headers: { Range: "bytes=0-0", "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" },
      responseType: "stream",
      timeout: VERIFY_TIMEOUT_MS,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    res.data.destroy();
    const ct = String(res.headers["content-type"] || "");
    const ok = (res.status === 200 || res.status === 206) && !/text\/html|application\/json/i.test(ct);
    return ok ? { ok, contentType: ct } : { ok: false };
  } catch {
    return { ok: false };
  }
}

// Some scrapers wrap the real CDN link in a JWT (dl.snapcdn.app/get?token=...). The iPhone
// Shortcuts app gets "An error has occurred" from that wrapper for Instagram, while the
// Instagram/Facebook CDN link inside it works anywhere. Only unwrap those CDNs: TikTok CDN
// links are often tied to the IP that fetched them.
const UNWRAP_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;

function unwrap(url) {
  try {
    const token = new URL(url).searchParams.get("token");
    const parts = token ? token.split(".") : [];
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const inner = new URL(payload.url);
    return /^https?:$/.test(inner.protocol) && UNWRAP_HOSTS.test(inner.hostname) ? inner.href : null;
  } catch {
    return null;
  }
}

// Prefer the unwrapped CDN link when it works, else the link as given.
async function verifyBest(url) {
  const direct = unwrap(url);
  if (direct) {
    const v = await verify(direct);
    if (v.ok) return { ...v, url: direct };
  }
  const v = await verify(url);
  return v.ok ? { ...v, url } : v;
}

// Turn a scraper result into the files the iPhone should save, or null if unusable.
async function pickFiles(platform, result, mode) {
  const all = (result.downloads || [])
    .filter((d) => d && typeof d.url === "string" && /^https?:/.test(d.url.replace(/\\\//g, "/")))
    .map((d) => {
      const url = d.url.replace(/\\\//g, "/");
      return { url, quality: d.quality, kind: classify({ ...d, url }) };
    });

  const by = (k) => all.filter((d) => d.kind === k);
  const videos = by("video");
  const images = by("image");
  const audios = by("audio");

  let candidates;
  let single;
  if (mode === "audio") {
    candidates = audios;
    single = true;
  } else if (videos.length) {
    // IG/X carousels list several videos with no quality label; keep them all.
    // Otherwise the list is quality variants of one video; keep the best working one.
    const carousel =
      (platform === "instagram" || platform === "twitter") &&
      videos.length > 1 &&
      videos.every((v) => !v.quality);
    candidates = videos;
    single = !carousel;
  } else if (result.type === "video") {
    // Scraper claims video but only gave images (e.g. a thumbnail): treat as failure.
    return null;
  } else {
    candidates = images.length ? images : audios;
    single = !images.length;
  }
  if (!candidates.length) return null;

  if (single) {
    const sorted = [...candidates].sort((a, b) => score(b.quality) - score(a.quality));
    for (const c of sorted) {
      const v = await verifyBest(c.url);
      if (v.ok) return [{ ...c, url: v.url, ext: extFor(c.kind, v.contentType) }];
    }
    return null;
  }

  const checks = await Promise.all(candidates.map((c) => verifyBest(c.url)));
  const files = candidates
    .map((c, i) => (checks[i].ok ? { ...c, url: checks[i].url, ext: extFor(c.kind, checks[i].contentType) } : null))
    .filter(Boolean);
  return files.length ? files : null;
}

const PLATFORM_NAMES = {
  tiktok: "TikTok",
  instagram: "Instagram",
  facebook: "Facebook",
  twitter: "X",
  youtube: "YouTube",
};

// Placeholder titles some scrapers return when the post has no caption.
const GENERIC_TITLES = /^(instagram|facebook|tiktok|twitter|x|youtube)?\s*(media|video|post|photo|image|reel)?$/i;

// Caption without hashtags, links, divider lines and line breaks, cut to fit a notification.
function cleanCaption(title) {
  const s = String(title || "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/#[^\s#@]+/g, "")
    .replace(/[-–—_=~*.•]{3,}/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—|/:.,]+|[\s\-–—|/:,]+$/g, "")
    .trim();
  if (s.length < 3 || GENERIC_TITLES.test(s)) return "";
  return s.length > 80 ? `${s.slice(0, 79).trimEnd()}…` : s;
}

// Text for the phone's "saved" notification. Built here so it can change without reinstalling the Shortcut.
function notification(platform, kind, count, title) {
  const from = PLATFORM_NAMES[platform] || platform;
  let notifyTitle;
  let fallback;
  if (kind === "audio") {
    notifyTitle = `🎧 Audio from ${from} saved`;
    fallback = "It's waiting in your Files.";
  } else if (kind === "image") {
    notifyTitle = count > 1 ? `📸 ${count} photos from ${from} saved` : `📸 Photo from ${from} saved`;
    fallback = "Open Photos to see it.";
  } else {
    notifyTitle = count > 1 ? `🎬 ${count} videos from ${from} saved` : `🎬 ${from} video saved`;
    fallback = "Ready to watch in Photos.";
  }
  const caption = cleanCaption(title);
  return { notifyTitle, notifyBody: caption ? `“${caption}”` : fallback };
}

async function resolve(input, { mode = "auto" } = {}) {
  const url = extractUrl(input);
  if (!url) throw new ResolveError("bad_url", "No link found", 400);
  const platform = detectPlatform(url);
  if (!platform) throw new ResolveError("unsupported", "Link not supported", 422);
  if (mode === "audio" && !AUDIO_CHAINS[platform]) {
    throw new ResolveError("unsupported", "Audio-only is not supported for this platform yet", 422);
  }

  const chain = (mode === "audio" ? AUDIO_CHAINS : CHAINS)[platform];
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const tried = [];

  for (const name of chain) {
    const left = deadline - Date.now();
    if (left < 2000) break;
    const fn = scrapr[platform][name];
    const t0 = Date.now();
    try {
      const res = await withTimeout(fn(url.href), Math.min(SCRAPER_TIMEOUT_MS, left), name);
      if (!res || !res.status || !res.result) throw new Error(res?.message || "no result");
      const files = await pickFiles(platform, res.result, mode);
      if (!files) throw new Error("no usable download");
      tried.push({ scraper: name, ok: true, ms: Date.now() - t0 });
      const kind = files[0].kind;
      const stamp = Date.now();
      const title = String(res.result.title || "").slice(0, 200);
      return {
        ok: true,
        platform,
        scraper: name,
        title,
        kind,
        count: files.length,
        ...notification(platform, kind, files.length, title),
        files: files.map((f, i) => ({
          url: f.url,
          kind: f.kind,
          ext: f.ext,
          name: `${platform}_${stamp}${files.length > 1 ? `_${i + 1}` : ""}.${f.ext}`,
          // Only present for audio, so the Shortcut can test "has any value"
          // instead of comparing text (text compare in If breaks across iOS versions).
          ...(f.kind === "audio" ? { saveToFiles: true } : {}),
        })),
        tried,
      };
    } catch (e) {
      tried.push({ scraper: name, ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 120) });
    }
  }

  const err = new ResolveError("all_failed", "Couldn't get the media. Try again later.", 502);
  err.platform = platform;
  err.tried = tried;
  throw err;
}

module.exports = { resolve, ResolveError, extractUrl, detectPlatform, classify, CHAINS };
