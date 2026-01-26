import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const RD_TOKEN = process.env.RD_TOKEN;
const TMDB_KEY = process.env.TMDB_KEY;

if (!RD_TOKEN) {
  console.error("❌ RD_TOKEN is not set.");
  process.exit(1);
}

// === CORS & STATIC FILES ===
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});

app.use("/assets", express.static(path.join(__dirname, "assets")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =========================
   CACHE & STATE
========================= */
let ALL_DOWNLOADS_CACHE = []; 
let ALL_TORRENTS_CACHE = [];  
let METADATA_CACHE = {}; 
let HIDDEN_GROUPS = new Set();
let isUpdating = false;

/* =========================
   TMDB ENGINE (INFINITE SCROLL)
========================= */
const TMDB_BASE = "https://api.themoviedb.org/3";
const PROVIDERS = { "netflix": "8", "hbo": "384", "disney": "337", "amazon": "119", "apple": "350" };

async function fetchTMDB(endpoint, params = "") {
    if (!TMDB_KEY) return null;
    try {
        const r = await fetch(`${TMDB_BASE}${endpoint}?api_key=${TMDB_KEY}&language=pl-PL&${params}`);
        if (!r.ok) return null;
        return await r.json();
    } catch (e) { return null; }
}

// NOWOŚĆ: Obsługa skip (paginacja)
async function getCatalog(type, catalogId, skip = 0) {
    const tmdbType = type === 'series' ? 'tv' : 'movie';
    let endpoint = "", params = "region=PL&include_adult=false";
    
    if (catalogId === "trending") endpoint = `/trending/${tmdbType}/week`;
    else if (catalogId === "top_rated") endpoint = `/${tmdbType}/top_rated`;
    else if (PROVIDERS[catalogId]) {
        endpoint = `/discover/${tmdbType}`;
        params += `&with_watch_providers=${PROVIDERS[catalogId]}&watch_region=PL&sort_by=popularity.desc`;
    } else return [];
    
    // OBLICZANIE STRON (Stremio wysyła skip=0, 20, 40... TMDB ma strony po 20 wyników)
    // Pobieramy 2 strony na raz (40 wyników), żeby ładowanie było płynne
    const itemsPerPage = 20; 
    const startPage = Math.floor(skip / itemsPerPage) + 1;
    const endPage = startPage + 1; // Pobierz obecną i następną stronę

    let allResults = [];
    for (let i = startPage; i <= endPage; i++) {
        const data = await fetchTMDB(endpoint, `${params}&page=${i}`);
        if (data && data.results) allResults = allResults.concat(data.results);
        else break;
    }

    return allResults.map(item => ({
        id: `tmdb:${item.id}`,
        type: type,
        name: item.title || item.name,
        poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
        description: item.overview,
        releaseInfo: (item.release_date || item.first_air_date || "").substring(0, 4)
    })).filter(i => i.poster);
}

async function getMetaFromTMDB(tmdbId, type) {
    const tmdbType = type === 'series' ? 'tv' : 'movie';
    const id = tmdbId.replace("tmdb:", "");
    const data = await fetchTMDB(`/${tmdbType}/${id}`, "append_to_response=external_ids");
    if (!data) return null;
    return {
        id: data.external_ids?.imdb_id || `tmdb:${id}`,
        tmdb_id: id, type: type, name: data.title || data.name,
        poster: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null,
        description: data.overview || "Brak opisu.",
        releaseInfo: (data.release_date || data.first_air_date || "").substring(0, 4)
    };
}

/* =========================
   HELPERS
========================= */
function deLeet(s) { return String(s || "").replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s").replace(/7/g, "t").replace(/@/g, "a"); }
function getNormalizedKey(filename) {
  const clean = String(filename || "").replace(/[\._]/g, " ");
  const match = clean.match(/^(.+?)(?=\s+(s\d{2}|19\d{2}|20\d{2}|4k|1080p|720p))/i);
  let rawTitle = match && match[1] ? match[1] : clean;
  return deLeet(rawTitle).toLowerCase().replace(/[^a-z0-9]/g, "");
}
function getDisplayTitle(filename) {
  const clean = String(filename || "").replace(/[\._]/g, " ");
  const match = clean.match(/^(.+?)(?=\s+s\d{2})/i); 
  return match && match[1] ? match[1].trim() : clean;
}
function getSearchQuery(filename) {
  let clean = String(filename || "").replace(/[\._]/g, " ");
  clean = clean.replace(/^\[.*?\]/, "").trim();
  let match = clean.match(/^(.+?)\s+(19\d{2}|20\d{2})/);
  if (match && match[1]) return match[1].trim();
  match = clean.match(/^(.+?)(?=\s+s\d{2})/i);
  if (match && match[1]) return match[1].trim();
  match = clean.match(/^(.+?)(?=\s+(1080|720|4k|2160p|bluray|web|dvd|x264|uhd))/i);
  if (match && match[1]) return match[1].trim();
  return clean;
}
function hostersOnly(downloads) { return downloads.filter(d => d.streamable === 1 && !d.link.includes("/d/")); }
function dashboardHostersOnly(downloads) { return downloads.filter(d => !d.link.includes("/d/")); }
function matchesEpisode(filename, season, episode) {
  if (!season || !episode) return false;
  const s = Number(season), e = Number(episode);
  return new RegExp(`S0*${s}[^0-9]*E0*${e}(?![0-9])`, "i").test(filename) || new RegExp(`\\b${s}x${e}\\b`, "i").test(filename);
}
function detectType(filename) { return /S\d{2}/i.test(filename) ? "series" : "movie"; }
function formatBytes(bytes) { if (!+bytes) return '0 B'; const k = 1024; const i = Math.floor(Math.log(bytes) / Math.log(k)); return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${['B', 'KB', 'MB', 'GB', 'TB'][i]}`; }
function getStreamInfo(filename, sizeBytes) {
    const f = filename.toLowerCase(); let tags = [];
    if (sizeBytes) tags.push(`${formatBytes(sizeBytes)}`);
    if (f.includes("2160p") || f.includes("4k")) tags.push("4K");
    else if (f.includes("1080p")) tags.push("1080p");
    if (f.includes("hdr")) tags.push("HDR");
    if (f.includes("dv")) tags.push("DV");
    return tags.join(" | ");
}

/* =========================
   METADATA LOGIC
========================= */
async function fetchCinemeta(idOrName) {
  if (!idOrName.startsWith("tt")) return null;
  const metaBase = "https://v3-cinemeta.strem.io";
  try {
    let r = await fetch(`${metaBase}/meta/series/${idOrName}.json`);
    if (r.ok) { let j = await r.json(); if (j?.meta) return { id: j.meta.imdb_id, name: j.meta.name, poster: j.meta.poster, type: "series" }; }
    r = await fetch(`${metaBase}/meta/movie/${idOrName}.json`);
    if (r.ok) { let j = await r.json(); if (j?.meta) return { id: j.meta.imdb_id, name: j.meta.name, poster: j.meta.poster, type: "movie" }; }
  } catch (err) { return null; }
  return null;
}
async function fetchByImdbTMDB(imdbId) {
    if (!TMDB_KEY) return null;
    const data = await fetchTMDB(`/find/${imdbId}`, "external_source=imdb_id");
    const res = data?.movie_results?.[0] || data?.tv_results?.[0];
    if (res) return { id: imdbId, name: res.title || res.name, poster: res.poster_path ? `https://image.tmdb.org/t/p/w500${res.poster_path}` : null, type: res.media_type || (res.title ? "movie" : "series") };
    return null;
}

/* =========================
   MANAGER UI (HYBRYDA: HTML Z PLIKU + DANE Z CACHE)
========================= */
app.get("/manager", async (req, res) => {
  // Sprawdzenie hasła (jeśli używasz)
  // if (!checkAuth(req)) return res.set('WWW-Authenticate', 'Basic realm="401"').status(401).send('Logowanie wymagane');

  try {
      // 1. POBIERANIE DANYCH Z TWOJEGO CACHE (To przywraca plakaty i wszystkie pliki)
      const showHidden = req.query.showHidden === "true";
      
      // Używamy Twoich funkcji filtrujących (zakładam, że masz je w kodzie)
      const downloadFiles = typeof dashboardHostersOnly === 'function' 
          ? dashboardHostersOnly(ALL_DOWNLOADS_CACHE) 
          : ALL_DOWNLOADS_CACHE; // Zabezpieczenie
      
      const groupsDownloads = {};
      const groupsTorrents = {};
      let stats = { totalFiles: downloadFiles.length + ALL_TORRENTS_CACHE.length, size: 0 };

      // 2. LOGIKA GRUPOWANIA (Twoja oryginalna, która obsługuje plakaty!)
      const addToGroup = (item, targetGroup, isTorrent) => {
          // Funkcje pomocnicze, które masz w kodzie
          const key = getNormalizedKey(item.filename); 
          const displayTitle = getDisplayTitle(item.filename);
          
          if (!targetGroup[key]) {
              targetGroup[key] = { 
                  key, 
                  displayName: displayTitle, 
                  files: [], 
                  assignedId: null, 
                  poster: null, 
                  detectedName: null, 
                  type: detectType(item.filename), 
                  size: 0, 
                  isTorrent, 
                  status: item.status, 
                  progress: item.progress, 
                  streamable: item.streamable 
              };
          }
          
          targetGroup[key].files.push(item);
          const size = isTorrent ? item.bytes : item.filesize;
          targetGroup[key].size += size; 
          stats.size += size;

          // PRZYWRACANIE METADANYCH (PLAKATY)
          if (METADATA_CACHE[item.id]) { 
              const m = METADATA_CACHE[item.id]; 
              targetGroup[key].assignedId = m.id; 
              targetGroup[key].poster = m.poster; 
              targetGroup[key].detectedName = m.name; 
              targetGroup[key].type = m.type; 
          }
      };

      // Wypełniamy grupy danymi z Cache
      downloadFiles.forEach(f => addToGroup(f, groupsDownloads, false));
      ALL_TORRENTS_CACHE.forEach(t => addToGroup(t, groupsTorrents, true));

      // 3. GENEROWANIE KAFELKÓW (RenderGrid)
      const gridDLSeries = renderGrid('series', groupsDownloads, showHidden, 'downloads', true);
      const gridDLMovie = renderGrid('movie', groupsDownloads, showHidden, 'downloads', false);
      const gridTorSeries = renderGrid('series', groupsTorrents, showHidden, 'torrents', true);
      const gridTorMovie = renderGrid('movie', groupsTorrents, showHidden, 'torrents', false);

      // 4. WCZYTANIE PLIKU HTML I PODMIANA
      let template = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');

      let page = template
          .replace('{{STATS_SIZE}}', formatBytes(stats.size))
          .replace('{{STATS_FILES}}', stats.totalFiles)
          .replace('{{SHOW_HIDDEN_TOGGLE}}', (!showHidden).toString())
          .replace('{{TRASH_ICON}}', showHidden ? 'undo' : 'delete_sweep')
          .replace('{{TRASH_TEXT}}', showHidden ? 'Wyjdź z Kosza' : 'Kosz')
          .replace('{{GRID_DOWNLOADS_SERIES}}', gridDLSeries)
          .replace('{{GRID_DOWNLOADS_MOVIE}}', gridDLMovie)
          .replace('{{GRID_TORRENTS_SERIES}}', gridTorSeries)
          .replace('{{GRID_TORRENTS_MOVIE}}', gridTorMovie);

      res.send(page);

  } catch (e) {
      console.error("Błąd Dashboardu:", e);
      res.status(500).send("Błąd serwera: " + e.message);
  }
});

function renderGrid(type, groups, showHidden, viewMode, isActive) {
    let html = `<div id="grid-${viewMode}-${type}" class="grid-container ${isActive ? 'active' : ''}">`;
    const sorted = Object.values(groups).filter(g => g.type === type).sort((a,b) => { if (!a.assignedId && b.assignedId) return -1; if (a.assignedId && !b.assignedId) return 1; return b.files.length - a.files.length; });
    for (const g of sorted) {
        if (HIDDEN_GROUPS.has(g.key) && !showHidden) continue;
        const posterSrc = g.poster ? `<img src="${g.poster}" class="poster-img">` : `<div class="no-poster"><span class="icon" style="font-size:40px">image_not_supported</span></div>`;
        const currentId = (g.assignedId && g.assignedId.startsWith("tt")) ? g.assignedId : "";
        
        // FIX: Używamy funkcji getSearchQuery
        const searchUrl = `https://www.imdb.com/find?q=${encodeURIComponent(getSearchQuery(g.displayName))}`;
        
        const cardClass = HIDDEN_GROUPS.has(g.key) ? "card hidden-item" : "card";
        const filesEncoded = encodeURIComponent(JSON.stringify(g.files.map(f => f.filename)));
        const safeTitle = g.detectedName || g.displayName;
        const downloadIds = g.files.map(f => f.id).join(",");
        let statusHtml = "";
        if (g.isTorrent || (g.streamable !== 1 && !g.isTorrent)) {
            let color = "#10b981"; let text = "GOTOWE";
            if (g.isTorrent) { if (g.status === 'downloading') { color = "#f59e0b"; text = `POBIERANIE ${g.progress || 0}%`; } else if (g.status === 'magnet_conversion') { color = "#8b5cf6"; text = "KONWERSJA"; } } else { color = "#f59e0b"; text = "PRZETWARZANIE..."; }
            statusHtml = `<div class="status-text" style="color:${color}">${text}</div>`;
        }
        html += `<div class="${cardClass}" data-title="${safeTitle}"><div class="poster-area" onclick="showDetails('${safeTitle.replace(/'/g, "\\'")}', '${filesEncoded}')">${posterSrc}<div class="badge"><span class="icon" style="font-size:14px">folder</span> ${g.files.length}</div><div class="size-badge">${formatBytes(g.size)}</div></div><div class="content"><div class="title" onclick="showDetails('${safeTitle.replace(/'/g, "\\'")}', '${filesEncoded}')">${safeTitle}</div>${statusHtml}<a href="${searchUrl}" target="_blank" class="btn-imdb"><span class="icon" style="font-size:16px">search</span> Szukaj ID</a><form action="/manager/update-group" method="POST" style="margin:0;"><input type="hidden" name="groupKey" value="${g.key}"><div class="input-row"><input type="text" name="imdbId" value="${currentId}" placeholder="tt..."><button type="submit" class="btn-icon-only"><span class="icon">save</span></button></div></form><div style="display:flex; gap:5px; margin-top:5px;"><form action="/manager/toggle-hide" method="POST" style="margin:0; flex:1;"><input type="hidden" name="groupKey" value="${g.key}">${HIDDEN_GROUPS.has(g.key) ? `<button type="submit" class="btn-restore"><span class="icon">undo</span></button>` : `<button type="submit" class="btn-delete" style="color:#888; border-color:#444"><span class="icon">visibility_off</span></button>`}</form><form action="/manager/delete-rd" method="POST" style="margin:0; flex:1;" onsubmit="return confirmDelete()"><input type="hidden" name="downloadIds" value="${downloadIds}"><button type="submit" class="btn-delete"><span class="icon">delete</span></button></form></div></div></div>`;
    }
    return html + `</div>`;
}

// === API ENDPOINTS ===
app.post("/manager/add-magnet", async (req, res) => {
    const { magnet, imdbId } = req.body;
    try {
        const params = new URLSearchParams(); params.append('magnet', magnet);
        const r = await fetch("https://api.real-debrid.com/rest/1.0/torrents/addMagnet", { method: "POST", headers: { Authorization: `Bearer ${RD_TOKEN}` }, body: params });
        const data = await r.json();
        if (data.id) {
            const selParams = new URLSearchParams(); selParams.append('files', 'all');
            await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${data.id}`, { method: "POST", headers: { Authorization: `Bearer ${RD_TOKEN}` }, body: selParams });
            if (imdbId) { let meta = await fetchByImdbTMDB(imdbId); if (!meta) meta = await fetchCinemeta(imdbId); METADATA_CACHE[data.id] = meta; }
        }
    } catch(e) { console.error(e); }
    setTimeout(syncAllDownloads, 1500); res.redirect("/manager");
});
app.post("/manager/add-links", async (req, res) => {
    const { links, imdbId } = req.body;
    const linkList = links.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    let meta = null; if (imdbId) meta = await fetchCinemeta(imdbId);
    for (const link of linkList) {
        try {
            const params = new URLSearchParams(); params.append('link', link);
            const r = await fetch("https://api.real-debrid.com/rest/1.0/unrestrict/link", { method: "POST", headers: { Authorization: `Bearer ${RD_TOKEN}` }, body: params });
            const data = await r.json();
            if (data.id && meta) METADATA_CACHE[data.id] = meta;
        } catch (e) {}
    }
    setTimeout(syncAllDownloads, 1000); res.redirect("/manager");
});
app.post("/manager/refresh", async (req, res) => { await syncAllDownloads(); res.redirect("/manager"); });
app.post("/manager/toggle-hide", (req, res) => { const k = req.body.groupKey; if(HIDDEN_GROUPS.has(k)) HIDDEN_GROUPS.delete(k); else HIDDEN_GROUPS.add(k); res.redirect("/manager"); });
app.post("/manager/delete-rd", async (req, res) => {
    const ids = req.body.downloadIds.split(",");
    for (const id of ids) { 
        try { await fetch(`https://api.real-debrid.com/rest/1.0/downloads/delete/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${RD_TOKEN}` } }); } catch(e) {}
        try { await fetch(`https://api.real-debrid.com/rest/1.0/torrents/delete/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${RD_TOKEN}` } }); } catch(e) {}
    }
    await syncAllDownloads(); res.redirect("/manager");
});
app.post("/manager/update-group", async (req, res) => {
    const { groupKey, imdbId } = req.body;
    if (imdbId) {
        let meta = await fetchCinemeta(imdbId);
        dashboardHostersOnly(ALL_DOWNLOADS_CACHE).forEach(f => { if (getNormalizedKey(f.filename) === groupKey) METADATA_CACHE[f.id] = meta; });
        ALL_TORRENTS_CACHE.forEach(t => { if (getNormalizedKey(t.filename) === groupKey) METADATA_CACHE[t.id] = meta; });
    }
    res.redirect("/manager");
});

async function syncAllDownloads() {
  if (isUpdating) return;
  isUpdating = true;
  try {
    let page = 1, dlItems = [], keep = true;
    while (keep) {
      const r = await fetch(`https://api.real-debrid.com/rest/1.0/downloads?limit=100&page=${page}`, { headers: { Authorization: `Bearer ${RD_TOKEN}` } });
      const data = await r.json().catch(() => []);
      if (!Array.isArray(data) || data.length === 0) keep = false;
      else { dlItems = dlItems.concat(data); if (data.length < 100) keep = false; else page++; await new Promise(r => setTimeout(r, 200)); }
    }
    ALL_DOWNLOADS_CACHE = dlItems;
    page = 1; let torItems = []; keep = true;
    while (keep) {
      const r = await fetch(`https://api.real-debrid.com/rest/1.0/torrents?limit=100&page=${page}`, { headers: { Authorization: `Bearer ${RD_TOKEN}` } });
      const data = await r.json().catch(() => []);
      if (!Array.isArray(data) || data.length === 0) keep = false;
      else { torItems = torItems.concat(data); if (data.length < 100) keep = false; else page++; await new Promise(r => setTimeout(r, 200)); }
    }
    const detailedTorrents = [];
    for (const t of torItems) {
        if (t.status === 'downloaded') {
            await new Promise(r => setTimeout(r, 50)); 
            const infoRes = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${t.id}`, { headers: { Authorization: `Bearer ${RD_TOKEN}` } });
            const info = await infoRes.json();
            if (info && info.files) { t.files = info.files.filter(f => f.selected === 1); t.links = info.links; detailedTorrents.push(t); }
        } else { detailedTorrents.push(t); }
    }
    ALL_TORRENTS_CACHE = detailedTorrents;
  } catch (e) { console.error("Sync error:", e.message); } finally { isUpdating = false; }
}

// === STREMIO MANIFEST & ROUTES ===
app.get("/manifest.json", (req, res) => {
  res.json({
    id: "community.rd.manager.final",
    version: "14.1.0",
    name: "RDD ULTIMATE",
    description: "VOD Manager + PL",
    logo: "https://rd-downloads-addon.onrender.com/assets/logo.png",
    resources: ["stream", "catalog", "meta"],
    types: ["movie", "series"],
    idPrefixes: ["tt", "tmdb"],
    catalogs: [
        { type: "series", id: "rd_series", name: "💎 Moje Seriale", extraSupported: ["skip"] }, 
        { type: "movie", id: "rd_movies", name: "💎 Moje Filmy", extraSupported: ["skip"] },
        { type: "movie", id: "trending", name: "🔥 Popularne", extraSupported: ["skip"] },
        { type: "series", id: "trending", name: "🔥 Popularne", extraSupported: ["skip"] },
        { type: "movie", id: "netflix", name: "🔴 Netflix", extraSupported: ["skip"] },
        { type: "series", id: "netflix", name: "🔴 Netflix", extraSupported: ["skip"] },
        { type: "movie", id: "hbo", name: "🟣 HBO Max", extraSupported: ["skip"] },
        { type: "series", id: "hbo", name: "🟣 HBO Max", extraSupported: ["skip"] },
        { type: "movie", id: "disney", name: "🟢 Disney+", extraSupported: ["skip"] },
        { type: "series", id: "disney", name: "🟢 Disney+", extraSupported: ["skip"] },
        { type: "movie", id: "amazon", name: "🔵 Prime Video", extraSupported: ["skip"] },
        { type: "series", id: "amazon", name: "🔵 Prime Video", extraSupported: ["skip"] },
        { type: "movie", id: "apple", name: "🍏 Apple TV+", extraSupported: ["skip"] }
    ]
  });
});

async function handleCatalog(req, res) {
    const { type, id, extra } = req.params;
    let skip = 0;
    if (extra) { const match = extra.match(/skip=(\d+)/); if (match) skip = parseInt(match[1]); }

    if (id === "rd_series" || id === "rd_movies") {
        const metas = [];
        const files = hostersOnly(ALL_DOWNLOADS_CACHE); 
        const unique = new Set();
        for (const f of files) {
            const key = getNormalizedKey(f.filename);
            if (HIDDEN_GROUPS.has(key)) continue;
            const meta = METADATA_CACHE[f.id];
            if (!meta || !meta.id.startsWith("tt") || meta.type !== type) continue;
            if (!unique.has(meta.id)) { unique.add(meta.id); metas.push({ id: meta.id, type: meta.type, name: meta.name, poster: meta.poster }); }
        }
        for (const t of ALL_TORRENTS_CACHE) {
            if (t.status !== 'downloaded') continue;
            const key = getNormalizedKey(t.filename);
            if (HIDDEN_GROUPS.has(key)) continue;
            const meta = METADATA_CACHE[t.id];
            if (!meta || !meta.id.startsWith("tt") || meta.type !== type) continue;
            if (!unique.has(meta.id)) { unique.add(meta.id); metas.push({ id: meta.id, type: meta.type, name: meta.name, poster: meta.poster }); }
        }
        return res.json({ metas: metas.slice(0, 100) });
    }
    const items = await getCatalog(type, id, skip);
    res.json({ metas: items });
}

app.get("/catalog/:type/:id.json", handleCatalog);
app.get("/catalog/:type/:id/:extra.json", handleCatalog);

app.get("/meta/:type/:id.json", async (req, res) => {
    const { type, id } = req.params;
    if (id.startsWith("tmdb:")) return res.json({ meta: await getMetaFromTMDB(id, type) });
    if (id.startsWith("tt")) {
        const data = await fetchTMDB(`/find/${id}`, "external_source=imdb_id");
        const hit = data?.movie_results?.[0] || data?.tv_results?.[0];
        if (hit) {
            const details = await getMetaFromTMDB(`tmdb:${hit.id}`, type);
            if (details) { details.id = id; return res.json({ meta: details }); }
        }
    }
    res.status(404).send();
});

function parseSeasonEpisode(id) { const p = id.split(":"); return { baseId: p[0], season: p[1], episode: p[2] }; }

app.get("/stream/:type/:id.json", (req, res) => {
  const { type, id } = req.params;
  const { baseId, season, episode } = parseSeasonEpisode(id);
  const streams = [];
  
  for (const f of ALL_DOWNLOADS_CACHE) {
    const meta = METADATA_CACHE[f.id];
    if (meta && meta.id === baseId) {
      const smartInfo = getStreamInfo(f.filename, f.filesize);
      const title = `${f.filename}\n${smartInfo}`;
      const name = "💎 MOJE RD";
      if (type === "series") {
        if (matchesEpisode(f.filename, season, episode)) streams.push({ name: name, title: title, url: f.download });
      } else { streams.push({ name: name, title: title, url: f.download }); }
    }
  }

  for (const t of ALL_TORRENTS_CACHE) {
      if (t.status !== 'downloaded') continue;
      const meta = METADATA_CACHE[t.id];
      if (meta && meta.id === baseId) {
          if (t.files && t.links) {
              t.files.forEach((file, index) => {
                  const isVid = /\.(mkv|mp4|avi)$/i.test(file.path);
                  let match = false;
                  if (type === "series") match = matchesEpisode(file.path, season, episode); else match = true;
                  if (match) {
                      const myUrl = `${req.protocol}://${req.get('host')}/play/t/${t.id}/${index}`;
                      const title = `[TORRENT] ${path.basename(file.path)}\n${getStreamInfo(file.path, file.bytes)}`;
                      streams.push({ name: "💎 CHMURA", title, url: myUrl });
                  }
              });
          }
      }
  }
  res.json({ streams });
});

app.get("/play/t/:tid/:idx", async (req, res) => {
    const { tid, idx } = req.params;
    const torrent = ALL_TORRENTS_CACHE.find(t => t.id === tid);
    if (!torrent || !torrent.links || !torrent.links[idx]) return res.status(404).send("File not found.");
    try {
        const params = new URLSearchParams(); params.append('link', torrent.links[idx]);
        const r = await fetch("https://api.real-debrid.com/rest/1.0/unrestrict/link", { method: "POST", headers: { Authorization: `Bearer ${RD_TOKEN}` }, body: params });
        const data = await r.json();
        if (data.download) res.redirect(data.download); else res.status(500).send("RD Error");
    } catch (e) { res.status(500).send("Server Error"); }
});

app.listen(PORT, "0.0.0.0", () => { console.log("✅ RDD ULTIMATE v14.1 (Infinite Scroll + Search Top) RUNNING"); syncAllDownloads(); setInterval(syncAllDownloads, 15 * 60 * 1000); });