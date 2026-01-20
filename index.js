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
   CORS & SETUP
========================= */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* =========================
   CACHE & DATABASE
========================= */
let ALL_DOWNLOADS_CACHE = []; // Surowe pliki z RD
let METADATA_CACHE = {};      // Mapowanie: nazwa pliku -> { id, poster, name }
let isUpdating = false;

/* =========================
   HELPERS (String & Score)
========================= */
function deLeet(s) {
  return String(s || "")
    .replace(/0/g, "o").replace(/1/g, "i").replace(/2/g, "z")
    .replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s")
    .replace(/6/g, "g").replace(/7/g, "t").replace(/8/g, "b");
}

function normalizeForTokens(s) {
  return deLeet(String(s || "").toLowerCase())
    .replace(/&/g, " and ").replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

const STOP = new Set([
  "the","a","an","and","or","of","to","in","on","for","with","from","at","by",
  "season","s","episode","ep","e","part","vol","volume",
  "multi","1080p","720p","2160p","web","webdl","webrip","bluray","brrip",
  "h264","h265","x264","x265","hevc","aac","ddp","atmos","dts","hdr","sdr",
  "proper","repack","remux","dv","dolby","vision","imax","mixio","ralf"
]);

function tokenize(s) {
  return normalizeForTokens(s).split(" ").filter(Boolean).filter(w => !STOP.has(w));
}

// ULEPSZONY SCORE (Znakowy)
function tokenScore(needles, haystackTokens) {
  if (!needles.length) return 0;
  const hay = new Set(haystackTokens);
  let totalLen = 0;
  let hitLen = 0;
  for (const n of needles) {
    totalLen += n.length;
    if (hay.has(n)) hitLen += n.length;
  }
  return totalLen === 0 ? 0 : hitLen / totalLen;
}

function parseSeasonEpisode(stremioId) {
  const parts = String(stremioId || "").split(":").filter(Boolean);
  return {
    baseId: parts[0] || "",
    season: parts.length >= 2 ? String(parts[1]).padStart(2, "0") : null,
    episode: parts.length >= 3 ? String(parts[2]).padStart(2, "0") : null
  };
}

function matchesEpisode(filename, season, episode) {
  if (!season || !episode) return false;
  const norm = normalizeForTokens(filename);
  const raw = String(filename || "");
  const sNum = Number(season);
  const eNum = Number(episode);

  const reSxE = new RegExp(`\\bs\\s*0*${sNum}\\s*?e\\s*0*${eNum}\\b`, "i");
  const reX = new RegExp(`\\b0*${sNum}\\s*x\\s*0*${eNum}\\b`, "i");
  const reRawDot = new RegExp(`S0*${sNum}[. ]?E0*${eNum}`, "i");
  
  let reAbs = null;
  if (sNum < 10) reAbs = new RegExp(`\\b${sNum}0*${eNum}\\b`, "i");

  return reSxE.test(norm) || reX.test(norm) || reRawDot.test(raw) || (reAbs && reAbs.test(norm));
}

/* =========================
   METADATA SEARCH (Szukanie plakatów)
========================= */
// Funkcja szuka plakatu w Cinemeta na podstawie nazwy pliku
async function findMetaForFile(filename) {
  // Próbujemy wyczyścić nazwę (usuwamy S01E01 i śmieci)
  const cleanName = filename
    .replace(/(S\d{1,2}E\d{1,2}|S\d{1,2}).*/i, "") // Ucinamy wszystko od S01...
    .replace(/(1080p|720p|2160p|WEB|BluRay).*/i, "")
    .replace(/\./g, " ")
    .trim();

  const type = filename.match(/S\d{2}/i) ? "series" : "movie";
  
  try {
    // Szukamy w katalogu Cinemeta
    const searchUrl = `https://v3-cinemeta.stremio.com/catalog/${type}/top/search=${encodeURIComponent(cleanName)}.json`;
    const r = await fetch(searchUrl);
    const j = await r.json();
    
    if (j && j.metas && j.metas.length > 0) {
      // Bierzemy pierwszy wynik
      return {
        id: j.metas[0].imdb_id || j.metas[0].id,
        name: j.metas[0].name,
        poster: j.metas[0].poster,
        type: type
      };
    }
  } catch (e) {
    // cicho sza
  }
  
  // Jak nie znajdzie, zwracamy fallback (bez plakatu)
  return {
    id: "rd_" + Math.random().toString(36).substr(2, 9),
    name: cleanName || filename,
    poster: null,
    type: type
  };
}

// Kolejka do uzupełniania plakatów w tle
async function processMetadataQueue() {
  console.log("🎨 [META] Rozpoczynam uzupełnianie plakatów...");
  const queue = ALL_DOWNLOADS_CACHE.filter(d => !METADATA_CACHE[d.id]); // Tylko te bez metadanych
  
  // Limitujemy, żeby nie zamęczyć Cinemety (1 zapytanie na sekundę max)
  for (const item of queue) {
    // Sprawdzamy czy już nie mamy tego w cache
    if (METADATA_CACHE[item.id]) continue;

    const meta = await findMetaForFile(item.filename);
    METADATA_CACHE[item.id] = meta;
    
    // console.log(`   -> Zidentyfikowano: ${item.filename} JAKO ${meta.name}`);
    
    // Pauza 500ms
    await new Promise(r => setTimeout(r, 500));
  }
  console.log("🎨 [META] Zakończono uzupełnianie.");
}

/* =========================
   CORE LOGIC (Sync & Get)
========================= */

function hostersOnly(downloads) {
  return downloads.filter(d => {
    if (d?.streamable !== 1) return false;
    if (!d?.download || !d?.filename) return false;
    const link = String(d.link || "").toLowerCase();
    if (link.startsWith("https://real-debrid.com/d/") || link.startsWith("http://real-debrid.com/d/")) return false;
    const mime = String(d.mimeType || "").toLowerCase();
    if (mime && !mime.startsWith("video/")) return false;
    return true;
  });
}

// Wybieranie najlepszego kandydata (Fuzzy + Length Score)
async function getStreamCandidate(type, id, hosters) {
  const { baseId, season, episode } = parseSeasonEpisode(id);

  // 1. Nazwa z Cinemeta / IMDb Fallback
  let title = null;
  const cUrl = `https://v3-cinemeta.stremio.com/meta/${type}/${baseId}.json`;
  
  try {
    const r = await fetch(cUrl, { headers: { "User-Agent": "Stremio-Addon-Node/1.0" }});
    if (r.ok) {
      const j = await r.json();
      if (j?.meta?.name) title = j.meta.name;
    }
  } catch(e) {}

  if (!title && baseId.startsWith("tt")) {
    // IMDb Fallback
    try {
      const r = await fetch(`https://www.imdb.com/title/${baseId}/`, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en;q=0.9" }
      });
      if (r.ok) {
        const t = await r.text();
        const m = t.match(/<title>(.*?)<\/title>/i);
        if (m && m[1]) title = m[1].replace(" - IMDb", "").replace(/\(TV.*\)/,"").trim();
      }
    } catch(e) {}
  }

  if (!title) return null;

  // 2. Filtrowanie
  let pool = hosters;
  if (type === "series" && season && episode) {
    pool = hosters.filter(d => matchesEpisode(d.filename, season, episode));
  }

  const titleTokens = tokenize(title);
  const scored = pool.map(d => {
    return { d, score: tokenScore(titleTokens, tokenize(d.filename)) };
  }).sort((a,b) => b.score - a.score);

  const best = scored[0];
  // Próg 60%
  if (best && best.score >= 0.6) return best.d;
  
  return null;
}

// SYNC (Pobieranie historii)
async function syncAllDownloads() {
  if (isUpdating) return;
  isUpdating = true;
  console.log("🔄 [SYNC] Pobieranie historii RD...");

  let page = 1;
  let allItems = [];
  let keepFetching = true;

  try {
    while (keepFetching) {
      const r = await fetch(`https://api.real-debrid.com/rest/1.0/downloads?limit=100&page=${page}`, {
        headers: { Authorization: `Bearer ${RD_TOKEN}` }
      });
      if (!r.ok) break;
      const data = await r.json().catch(() => []);
      
      if (!Array.isArray(data) || data.length === 0) {
        keepFetching = false;
      } else {
        allItems = allItems.concat(data);
        if (data.length < 100) keepFetching = false;
        else page++;
        await new Promise(r => setTimeout(r, 200));
      }
    }

    if (allItems.length > 0) {
      ALL_DOWNLOADS_CACHE = allItems;
      console.log(`✅ [SYNC] Pobranao ${allItems.length} plików.`);
      
      // Po pobraniu plików -> uruchom w tle szukanie plakatów
      processMetadataQueue();
    }
  } catch (err) {
    console.error("❌ [SYNC] Błąd:", err.message);
  } finally {
    isUpdating = false;
  }
}

/* =========================
   ROUTES
========================= */

// Manifest
app.get("/manifest.json", (req, res) => {
  res.json({
    id: "community.rd.downloads.pro.v5",
    version: "0.5.0",
    name: "RD Downloads + Catalog",
    description: "Your Real-Debrid files as a Catalog & Stream source.",
    resources: ["stream", "catalog"], // Dodano "catalog"
    types: ["movie", "series"],
    idPrefixes: ["tt", "rd"],
    catalogs: [
      {
        type: "series",
        id: "rd_series",
        name: "Moje Seriale (RD)",
        extra: [{ name: "search", isRequired: false }]
      },
      {
        type: "movie",
        id: "rd_movies",
        name: "Moje Filmy (RD)",
        extra: [{ name: "search", isRequired: false }]
      }
    ]
  });
});

// KATALOG (To wyświetla kafelki)
app.get("/catalog/:type/:id.json", async (req, res) => {
  const { type, id } = req.params;
  
  // Interesują nas tylko nasze ID katalogów
  if (id !== "rd_series" && id !== "rd_movies") return res.json({ metas: [] });

  const hosters = hostersOnly(ALL_DOWNLOADS_CACHE);
  
  // Grupujemy pliki, żeby nie wyświetlać 10 razy tego samego serialu
  // Kluczem jest "Clean Name" lub znalezione ID
  const uniqueItems = new Map();

  for (const file of hosters) {
    // Sprawdzamy czy mamy metadata
    const meta = METADATA_CACHE[file.id];
    
    // Jeśli nie mamy meta, pomijamy albo dajemy brzydki wpis (lepiej pominąć w katalogu póki się nie załaduje)
    // Ale pokażmy fallback
    const displayName = meta ? meta.name : file.filename;
    const poster = meta ? meta.poster : null;
    const detectedType = (meta && meta.type) ? meta.type : (file.filename.match(/S\d{2}/i) ? "series" : "movie");

    // Filtrujemy typ (katalog filmów pokazuje tylko filmy)
    if (detectedType !== type) continue;

    // Klucz do grupowania (żeby wszystkie odcinki serialu zbić w jeden kafelek)
    // Jeśli mamy ID z IMDb, używamy go. Jeśli nie, używamy nazwy.
    const groupKey = (meta && meta.id && meta.id.startsWith("tt")) ? meta.id : displayName;

    if (!uniqueItems.has(groupKey)) {
      uniqueItems.set(groupKey, {
        id: (meta && meta.id.startsWith("tt")) ? meta.id : "rd_" + file.id, // Ważne: ID musi być unikalne
        type: type,
        name: displayName,
        poster: poster,
        description: "Plik na Twoim Real-Debrid"
      });
    }
  }

  // Zamień mapę na tablicę i zwróć (max 100 ostatnich)
  const metas = Array.from(uniqueItems.values()).slice(0, 100);

  res.json({ metas });
});

// STREAM
app.get("/stream/:type/:id.json", async (req, res) => {
  try {
    const { type, id } = req.params;
    console.log(`➡️ Stream: ${type} ${id}`);
    
    // Jeśli ID to nasze sztuczne "rd_...", nie mamy co robić (chyba że zmapujemy to ręcznie)
    // Ale Stremio zazwyczaj używa "tt..." jeśli katalog zwrócił "tt..."
    // Jeśli użytkownik kliknie w kafelek bez ID (tylko filename), to tutaj trafi "rd_..."
    // Wtedy po prostu szukamy pliku po ID z RD
    if (id.startsWith("rd_")) {
        const fileId = id.replace("rd_", "");
        const file = ALL_DOWNLOADS_CACHE.find(f => String(f.id) === fileId);
        if (file) {
            return res.json({ streams: [{ name: "RD Direct", title: file.filename, url: file.download }] });
        }
    }

    const hosters = hostersOnly(ALL_DOWNLOADS_CACHE);
    const match = await getStreamCandidate(type, id, hosters);

    if (match) {
       return res.json({
        streams: [{
          name: "RD Download",
          title: match.filename,
          url: match.download
        }]
      });
    }
    return res.json({ streams: [] });
  } catch (e) {
    console.error(e);
    return res.json({ streams: [] });
  }
});

/* =========================
   DEBUG & START
========================= */
app.get("/debug/hosters", (req, res) => {
  res.json({ 
    total: ALL_DOWNLOADS_CACHE.length,
    meta_count: Object.keys(METADATA_CACHE).length,
    sample_meta: Object.values(METADATA_CACHE).slice(0,5)
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Addon running with CATALOG support.");
  syncAllDownloads();
  setInterval(syncAllDownloads, 15 * 60 * 1000);
});