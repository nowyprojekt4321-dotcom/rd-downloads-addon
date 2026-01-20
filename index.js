import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const app = express();

// Polecam 3001, bo Windows czasem trzyma 3000 w TIME_WAIT
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

// convert leetspeak -> letters
function deLeet(s) {
  return s
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
  "h264","h265","x264","x265","hevc","aac","ddp","atmos","dts","hdr","sdr"
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

// parse Stremio ID: ttXXXX:season:episode
function parseSeasonEpisode(stremioId) {
  const parts = stremioId.split(":");
  if (parts.length === 3) {
    return {
      baseId: parts[0],
      season: parts[1].padStart(2, "0"),
      episode: parts[2].padStart(2, "0")
    };
  }
  return { baseId: parts[0], season: null, episode: null };
}

function matchesEpisode(filename, season, episode) {
  if (!season || !episode) return false;
  const f = normalizeForTokens(filename);

  // S01E01
  const re1 = new RegExp(`\\bs${Number(season)}\\s*e${Number(episode)}\\b`, "i");
  // 1x01
  const re2 = new RegExp(`\\b${Number(season)}\\s*x\\s*${Number(episode)}\\b`, "i");
  // E01 / EP01 / Episode 01 (when season implied; we still keep season check by requiring "s01" nearby if present)
  const re3 = new RegExp(`\\b(ep|e|episode)\\s*0*${Number(episode)}\\b`, "i");

  // direct check on raw filename too (for dot-separated)
  const raw = String(filename || "");

  const sNum = String(Number(season));
  const eNum = String(Number(episode)).padStart(2, "0");

  const dotStyle = new RegExp(`S0*${sNum}E0*${Number(episode)}`, "i").test(raw);
  const xStyle = new RegExp(`${sNum}x0*${Number(episode)}`, "i").test(raw);

  return re1.test(f) || re2.test(f) || dotStyle || xStyle || re3.test(f);
}

async function getCinemetaTitle(type, baseId) {
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

// ✅ 100% pewne “hosters only”: wyrzucamy RD cache/torrenty po polu link
function hostersOnly(downloads) {
  return downloads.filter(d => {
    if (d?.streamable !== 1) return false;
    if (!d?.download || !d?.filename) return false;

    const link = String(d.link || "").toLowerCase();

    // RD cache / torrent-ish entries typically look like https://real-debrid.com/d/XXXX
    if (link.startsWith("https://real-debrid.com/d/") || link.startsWith("http://real-debrid.com/d/")) {
      return false;
    }

    // prefer video mimetypes when present
    const mime = String(d.mimeType || "").toLowerCase();
    if (mime && !mime.startsWith("video/")) return false;

    return true;
  });
}

function newestFirst(arr) {
  return arr.slice().sort((a, b) => {
    const da = Date.parse(a.generated || 0) || 0;
    const db = Date.parse(b.generated || 0) || 0;
    return db - da;
  });
}

/* =========================
   MANIFEST (NEW ID)
========================= */
app.get("/manifest.json", (req, res) => {
  res.json({
    id: "community.rd.downloads.hosters.fuzzy.v4",
    version: "0.4.0",
    name: "RD Downloads (Hosters • Fuzzy)",
    description: "Streams ONLY RD direct downloads from hosters. Fuzzy title match (handles Dar3devil etc.) + episode matching.",
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

  // score candidates
  const scored = hosters.map(d => {
    const ft = tokenize(d.filename);
    const score = tokenScore(titleTokens, ft);
    const epOk = type === "series" && season && episode ? matchesEpisode(d.filename, season, episode) : null;
    return { score, epOk, filename: d.filename, link: d.link, download: d.download };
  }).slice(0, 50);

  res.json({ type, id, baseId, title, season, episode, top50: scored });
});

/* =========================
   STREAM
========================= */
app.get("/stream/:type/:id.json", async (req, res) => {
  try {
    console.log("➡️ stream request:", req.params.type, req.params.id);
    const { type, id } = req.params;
    const { baseId, season, episode } = parseSeasonEpisode(id);

    const title = await getCinemetaTitle(type, baseId);
    const titleTokens = title ? tokenize(title) : [];

    if (!title) {
      console.error("⚠️ Cinemeta title not found for:", type, baseId, "(fallback mode)");
    }

    const all = await getRdDownloads();
    const hosters = newestFirst(hostersOnly(all));

    let match = null;

    // --- SERIES ---
    if (type === "series" && season && episode) {
      // 1) strict episode + fuzzy title (best)
      if (titleTokens.length) {
        match = hosters.find(d => {
          if (!matchesEpisode(d.filename, season, episode)) return false;
          const ft = tokenize(d.filename);
          const score = tokenScore(titleTokens, ft);
          // threshold: need at least ~0.55 match; with 2-3 words it still works
          return score >= 0.55;
        });
      }

      // 2) episode-only fallback (if Cinemeta missing)
      if (!match) {
        match = hosters.find(d => matchesEpisode(d.filename, season, episode));
      }
    }

    // --- MOVIE or ultimate fallback ---
    if (!match) {
      if (titleTokens.length) {
        match = hosters.find(d => tokenScore(titleTokens, tokenize(d.filename)) >= 0.55);
      }
      if (!match) match = hosters[0] || null;
    }

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
