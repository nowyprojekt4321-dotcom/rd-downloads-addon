import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const app = express();

const PORT = process.env.PORT || 3001;
const RD_TOKEN = process.env.RD_TOKEN;

if (!RD_TOKEN) {
  console.error("❌ RD_TOKEN is not set (check .env: RD_TOKEN=...)");
  process.exit(1);
}

/* =========================
   CORS
========================= */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* =========================
   HELPERS
========================= */

// convert leetspeak -> letters (basic)
function deLeet(s) {
  return String(s || "")
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/2/g, "z")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/6/g, "g")
    .replace(/7/g, "t")
    .replace(/8/g, "b")
    .replace(/9/g, "g");
}

function normalizeForTokens(s) {
  return deLeet(String(s || "").toLowerCase())
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set([
  "the","a","an","and","or","of","to","in","on","for","with","from","at","by",
  "season","s","episode","ep","e","part","vol","volume",
  "multi","1080p","720p","2160p","web","webdl","webrip","bluray","brrip",
  "h264","h265","x264","x265","hevc","aac","ddp","atmos","dts","hdr","sdr",
  "proper","repack","remux","dv","dolby","vision","imax"
]);

function tokenize(s) {
  const t = normalizeForTokens(s).split(" ").filter(Boolean);
  return t.filter(w => !STOP.has(w));
}

// token overlap score: 0..1
function tokenScore(needles, haystackTokens) {
  if (!needles.length) return 0;
  const hay = new Set(haystackTokens);
  let hit = 0;
  for (const n of needles) if (hay.has(n)) hit++;
  return hit / needles.length;
}

// Stremio series IDs usually: ttXXXX:season:episode
// but we defensively handle: ttXXXX or even ttXXXX:1:1:extra
function parseSeasonEpisode(stremioId) {
  const parts = String(stremioId || "").split(":").filter(Boolean);
  const baseId = parts[0] || "";
  const season = parts.length >= 2 ? String(parts[1]) : null;
  const episode = parts.length >= 3 ? String(parts[2]) : null;
  return {
    baseId,
    season: season ? season.padStart(2, "0") : null,
    episode: episode ? episode.padStart(2, "0") : null
  };
}

function matchesEpisode(filename, season, episode) {
  if (!season || !episode) return false;

  const raw = String(filename || "");
  const norm = normalizeForTokens(filename);

  const sNum = String(Number(season));
  const eNum = String(Number(episode));
  const eNum2 = String(Number(episode)).padStart(2, "0");

  // normalized patterns
  const reSxE = new RegExp(`\\bs\\s*0*${sNum}\\s*e\\s*0*${eNum}\\b`, "i");
  const reX = new RegExp(`\\b0*${sNum}\\s*x\\s*0*${eNum}\\b`, "i");

  // raw dot style S01E01
  const reDot = new RegExp(`S0*${sNum}E0*${eNum}`, "i");
  const reDot2 = new RegExp(`S0*${sNum}E${eNum2}`, "i");
  const reXraw = new RegExp(`${sNum}x0*${eNum}`, "i");

  return (
    reSxE.test(norm) ||
    reX.test(norm) ||
    reDot.test(raw) ||
    reDot2.test(raw) ||
    reXraw.test(raw)
  );
}

function newestFirst(arr) {
  return arr.slice().sort((a, b) => {
    const da = Date.parse(a.generated || 0) || 0;
    const db = Date.parse(b.generated || 0) || 0;
    return db - da;
  });
}

async function getCinemetaTitle(type, baseId) {
  // Cinemeta expects type: movie|series and id: tt....
  const url = `https://v3-cinemeta.stremio.com/meta/${type}/${baseId}.json`;
  const r = await fetch(url).catch(() => null);
  if (!r || !r.ok) return null;
  const j = await r.json().catch(() => null);
  const name = j?.meta?.name;
  return typeof name === "string" ? name : null;
}

async function getRdDownloads() {
  const url = "https://api.real-debrid.com/rest/1.0/downloads?limit=200";
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${RD_TOKEN}` }
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    console.error("❌ RD API error:", r.status, txt.slice(0, 200));
    return [];
  }

  const data = await r.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

// ✅ hosters only (exclude RD cache/torrent-like)
function hostersOnly(downloads) {
  return downloads.filter(d => {
    if (d?.streamable !== 1) return false;
    if (!d?.download || !d?.filename) return false;

    const link = String(d.link || "").toLowerCase();

    // RD cache / torrent-ish entries
    if (link.startsWith("https://real-debrid.com/d/") || link.startsWith("http://real-debrid.com/d/")) {
      return false;
    }

    // prefer video mimetypes when present
    const mime = String(d.mimeType || "").toLowerCase();
    if (mime && !mime.startsWith("video/")) return false;

    return true;
  });
}

/**
 * Pick best candidate by score, with threshold + margin.
 * Returns null if not confident.
 */
function pickBestByScore(candidates, titleTokens, { minScore = 0.55, minHits = 1, margin = 0.08 } = {}) {
  if (!candidates.length) return null;
  if (!titleTokens.length) return null;

  const scored = candidates.map(d => {
    const ft = tokenize(d.filename);
    const score = tokenScore(titleTokens, ft);
    // hit count (more robust for short titles)
    const hay = new Set(ft);
    let hits = 0;
    for (const t of titleTokens) if (hay.has(t)) hits++;
    return { d, score, hits };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];

  if (!best) return null;
  if (best.score < minScore) return null;
  if (best.hits < minHits) return null;

  // If second exists and is too close → ambiguous
  if (second && (best.score - second.score) < margin) return null;

  return best.d;
}

/* =========================
   MANIFEST
========================= */
app.get("/manifest.json", (req, res) => {
  res.json({
    id: "community.rd.downloads.hosters.fuzzy.v4", // keep same id so Stremio updates without disappearing
    version: "0.4.1",
    name: "RD Downloads (Hosters • Fuzzy)",
    description: "Streams ONLY RD direct downloads from hosters. Strict matching (no wrong fallbacks) + fuzzy title + episode matching.",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [],
    logo: "https://www.stremio.com/website/stremio-logo-small.png",
    background: "https://www.stremio.com/website/stremio-logo-small.png"
  });
});

/* =========================
   DEBUG
========================= */
app.get("/debug/hosters", async (req, res) => {
  const all = await getRdDownloads();
  const hosters = hostersOnly(all);
  res.json({
    total_downloads: all.length,
    hosters_only: hosters.length,
    sample_links_first_10: hosters.slice(0, 10).map(x => x.link),
    sample_files_first_10: hosters.slice(0, 10).map(x => x.filename)
  });
});

app.get("/debug/pick/:type/:id", async (req, res) => {
  const { type, id } = req.params;
  const { baseId, season, episode } = parseSeasonEpisode(id);

  const title = await getCinemetaTitle(type, baseId);
  const titleTokens = title ? tokenize(title) : [];

  const all = await getRdDownloads();
  const hosters = newestFirst(hostersOnly(all));

  // Candidate pool
  let pool = hosters;
  if (type === "series" && season && episode) {
    pool = hosters.filter(d => matchesEpisode(d.filename, season, episode));
  }

  const scored = pool.map(d => {
    const ft = tokenize(d.filename);
    const score = titleTokens.length ? tokenScore(titleTokens, ft) : 0;
    return { score, filename: d.filename, link: d.link, download: d.download };
  }).sort((a, b) => b.score - a.score).slice(0, 50);

  res.json({ type, id, baseId, title, season, episode, candidates: pool.length, top50: scored });
});

/* =========================
   STREAM
========================= */
app.get("/stream/:type/:id.json", async (req, res) => {
  try {
    const { type, id } = req.params;
    const { baseId, season, episode } = parseSeasonEpisode(id);

    console.log("➡️ stream request:", type, id, "=> baseId:", baseId, "S/E:", season, episode);

    const all = await getRdDownloads();
    const hosters = newestFirst(hostersOnly(all));

    // ===== SERIES =====
    if (type === "series") {
      // Stremio normally asks with season/episode. If not provided, we return nothing (avoid wrong mappings).
      if (!season || !episode) {
        return res.json({ streams: [] });
      }

      const title = await getCinemetaTitle("series", baseId);
      if (!title) {
        console.error("⚠️ Cinemeta title not found for:", "series", baseId, "(returning empty to avoid wrong matches)");
        return res.json({ streams: [] });
      }

      const titleTokens = tokenize(title);

      // Filter to episode-only pool first
      const episodePool = hosters.filter(d => matchesEpisode(d.filename, season, episode));
      if (!episodePool.length) return res.json({ streams: [] });

      // Pick best by fuzzy score (strict)
      const match = pickBestByScore(episodePool, titleTokens, {
        minScore: 0.55,
        minHits: Math.min(2, titleTokens.length), // require 2 hits if possible
        margin: 0.08
      });

      if (!match) return res.json({ streams: [] });

      return res.json({
        streams: [
          {
            name: "Real-Debrid Downloads",
            title: match.filename,
            url: match.download
          }
        ]
      });
    }

    // ===== MOVIE =====
    if (type === "movie") {
      const title = await getCinemetaTitle("movie", baseId);
      if (!title) {
        console.error("⚠️ Cinemeta title not found for:", "movie", baseId, "(returning empty to avoid wrong matches)");
        return res.json({ streams: [] });
      }

      const titleTokens = tokenize(title);

      const match = pickBestByScore(hosters, titleTokens, {
        minScore: 0.55,
        minHits: Math.min(2, titleTokens.length),
        margin: 0.08
      });

      if (!match) return res.json({ streams: [] });

      return res.json({
        streams: [
          {
            name: "Real-Debrid Downloads",
            title: match.filename,
            url: match.download
          }
        ]
      });
    }

    // unknown type
    return res.json({ streams: [] });
  } catch (err) {
    console.error("❌ Stream error:", err);
    return res.json({ streams: [] });
  }
});

/* =========================
   START
========================= */
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ RD Downloads (Hosters • Fuzzy) addon running");
  console.log(`👉 http://127.0.0.1:${PORT}/manifest.json`);
  console.log(`👉 http://127.0.0.1:${PORT}/debug/hosters`);
});
