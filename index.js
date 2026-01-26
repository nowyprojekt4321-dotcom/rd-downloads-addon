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
   TMDB CONFIG & HELPERS
========================= */
const TMDB_BASE = "https://api.themoviedb.org/3";
// Mapowanie ID dostawców
const PROVIDERS = { 
    "netflix": "8", 
    "disney": "337", 
    "amazon": "119", 
    "apple": "350", 
    "hbo": "384" 
};
// Mapowanie nazw dostawców do wyświetlania w tytule
const PROVIDER_NAMES = {
    "8": "NETFLIX",
    "337": "DISNEY+",
    "119": "PRIME",
    "350": "APPLE",
    "384": "MAX"
};
// Globalne Gatunki
const GENRES = {
    "action": "28", "comedy": "35", "horror": "27", "scifi": "878", "drama": "18", "animation": "16", "crime": "80"
};

async function fetchTMDB(endpoint, params = "") {
    if (!TMDB_KEY) return null;
    try {
        const r = await fetch(`${TMDB_BASE}${endpoint}?api_key=${TMDB_KEY}&language=pl-PL&${params}`);
        if (!r.ok) return null;
        return await r.json();
    } catch (e) { return null; }
}

// Helper: Data premiery (tylko rok lub DD.MM)
function formatReleaseDate(dateStr) {
    if (!dateStr) return "";
    const release = new Date(dateStr);
    const now = new Date();
    // Jeśli przyszłość -> Data dzienna (np. 15.03)
    if (release > now) {
        const day = String(release.getDate()).padStart(2, '0');
        const month = String(release.getMonth() + 1).padStart(2, '0');
        return `${day}.${month}`;
    }
    // Jeśli przeszłość -> Rok (2024)
    return dateStr.substring(0, 4);
}

/* =========================
   CATALOG LOGIC (v15.5 SMART VOTE FILTER)
========================= */
async function getCatalog(catalogId, type, genre, skip = 0) {
    let results = [];
    const regionParams = "&watch_region=PL&region=PL";
    const page = Math.floor(skip / 20) + 1;

    // --- 1. SEKCJA "PREMIERY" (MIX FILMY + SERIALE) ---
    if (catalogId === "this_month") {
        const now = new Date();
        // Limit górny: +3 miesiące (widzimy przyszłość)
        const futureDate = new Date(now.getFullYear(), now.getMonth() + 3, 1).toISOString().split('T')[0];

        // KONFIGURACJA FILTRÓW:
        // 1. vote_count.gte=50 -> TO JEST KLUCZ. Wywala amatorskie produkcje i błędy bazy danych.
        //    Prawdziwe hity kinowe (nawet przed premierą) mają dużo głosów "Want to see".
        // 2. Sortowanie po dacie -> Żebyś widział co wychodzi TERAZ.
        const filters = `primary_release_date.lte=${futureDate}&sort_by=primary_release_date.desc&vote_count.gte=50`;
        const tvFilters = `first_air_date.lte=${futureDate}&sort_by=first_air_date.desc&vote_count.gte=50`;

        const [movies, series] = await Promise.all([
            fetchTMDB("/discover/movie", `${filters}&page=${page}${regionParams}`),
            fetchTMDB("/discover/tv", `${tvFilters}&page=${page}${regionParams}`)
        ]);

        let mixed = [];
        if (movies?.results) mixed.push(...movies.results.map(i => ({...i, media_type: 'movie'})));
        if (series?.results) mixed.push(...series.results.map(i => ({...i, media_type: 'tv'})));

        // Sortujemy mix po dacie (Najnowsze na górze)
        results = mixed.sort((a,b) => new Date(b.release_date || b.first_air_date) - new Date(a.release_date || a.first_air_date));
    } 

    // --- 2. SEKCJA PREMIUM NOWOŚCI ---
    else if (catalogId.endsWith("_new")) {
        const [providerName] = catalogId.split("_");
        const providerId = PROVIDERS[providerName];
        
        // Tu też filtrujemy (min 20 głosów dla streamingów, bo tam czasem wychodzą niszowe rzeczy szybciej)
        const [movies, series] = await Promise.all([
            fetchTMDB("/discover/movie", `with_watch_providers=${providerId}&sort_by=primary_release_date.desc&vote_count.gte=20&page=${page}${regionParams}`),
            fetchTMDB("/discover/tv", `with_watch_providers=${providerId}&sort_by=first_air_date.desc&vote_count.gte=20&page=${page}${regionParams}`)
        ]);

        let mixed = [];
        if (movies?.results) mixed.push(...movies.results.map(i => ({...i, media_type: 'movie'})));
        if (series?.results) mixed.push(...series.results.map(i => ({...i, media_type: 'tv'})));

        results = mixed.sort((a,b) => new Date(b.release_date || b.first_air_date) - new Date(a.release_date || a.first_air_date));
    }

    // --- 3. SEKCJA PREMIUM ZWYKŁA ---
    else if (PROVIDERS[catalogId.split("_")[0]]) {
        const [providerName, subType] = catalogId.split("_");
        const providerId = PROVIDERS[providerName];
        const tmdbType = (subType === 'series' || type === 'series') ? 'tv' : 'movie';
        
        let genreParam = "";
        if (genre) {
            const genreObj = Object.entries(GENRES).find(([k,v]) => k === genre.toLowerCase() || k === genre);
            if (genreObj) genreParam = `&with_genres=${genreObj[1]}`;
        }

        const data = await fetchTMDB(`/discover/${tmdbType}`, `with_watch_providers=${providerId}&sort_by=popularity.desc${genreParam}&page=${page}${regionParams}`);
        results = data?.results || [];
        results = results.map(i => ({...i, media_type: tmdbType}));
    }

    // --- 4. GATUNKI GLOBALNE ---
    else if (catalogId.startsWith("genre_")) {
        const genreKey = catalogId.replace("genre_", "");
        const genreId = GENRES[genreKey];
        const data = await fetchTMDB(`/discover/movie`, `with_genres=${genreId}&sort_by=popularity.desc&page=${page}${regionParams}`);
        results = data?.results || [];
        results = results.map(i => ({...i, media_type: 'movie'}));
    }

    // --- MAPOWANIE WYNIKÓW ---
    return results.map(item => {
        const isMovie = item.media_type === 'movie';
        const date = item.release_date || item.first_air_date;
        const year = (date || "").substring(0, 4);
        
        let name = item.title || item.name;

        // TAGI (CZYSTE I PROSTE)
        if (catalogId === "this_month") {
            const releaseDate = new Date(date);
            const now = new Date(); 
            
            let tag = "";
            if (releaseDate > now) {
                tag = "WKRÓTCE";
            } else {
                tag = isMovie ? "FILM" : "SERIAL";
            }
            name = `${name} [${tag}]`;
        } 
        else if (catalogId.endsWith("_new")) {
            name = `${name} [${isMovie ? 'FILM' : 'SERIAL'}]`;
        }

        return {
            id: `tmdb:${item.id}`,
            type: isMovie ? 'movie' : 'series',
            name: name,
            poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
            description: item.overview || "", 
            releaseInfo: formatReleaseDate(date)
        };
    }).filter(i => i.poster);
}

/* =========================
   META HANDLER (NAPRAWA SERIALI + ID DLA INNYCH WTYCZEK)
========================= */
async function getMetaFromTMDB(tmdbId, type) {
    const tmdbType = type === 'series' ? 'tv' : 'movie';
    const id = tmdbId.replace("tmdb:", "");
    
    // Kluczowe: Pobieramy external_ids ORAZ sezony
    const data = await fetchTMDB(`/${tmdbType}/${id}`, "append_to_response=external_ids");
    if (!data) return null;

    // Ustalamy "Główne ID" - jeśli mamy IMDb (tt...), to go używamy. Jak nie, to TMDB.
    // To jest kluczowe dla AIO|PL i innych wtyczek.
    const realId = data.external_ids?.imdb_id || `tmdb:${id}`;

    const meta = {
        id: realId,
        tmdb_id: id,
        type: type,
        name: data.title || data.name,
        poster: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null,
        background: data.backdrop_path ? `https://image.tmdb.org/t/p/original${data.backdrop_path}` : null,
        description: data.overview || "Brak opisu.",
        releaseInfo: (data.release_date || data.first_air_date || "").substring(0, 4),
        genres: data.genres ? data.genres.map(g => g.name) : []
    };

    // 🚨 LOGIKA SERIALI - POBIERANIE ODCINKÓW 🚨
    if (type === 'series' && data.seasons) {
        meta.videos = [];
        // Pobieramy szczegóły dla każdego sezonu
        const seasonPromises = data.seasons
            .filter(s => s.season_number > 0)
            .map(s => fetchTMDB(`/tv/${id}/season/${s.season_number}`));
        
        const seasonsData = await Promise.all(seasonPromises);
        
        seasonsData.forEach(season => {
            if (season && season.episodes) {
                season.episodes.forEach(ep => {
                    meta.videos.push({
                        // TU BYŁ BŁĄD: Wcześniej dawaliśmy `tmdb:${id}...`
                        // TERAZ: Dajemy `realId` (czyli tt12345...), jeśli jest dostępne.
                        id: `${realId}:${season.season_number}:${ep.episode_number}`,
                        title: ep.name,
                        released: new Date(ep.air_date).toISOString(),
                        season: season.season_number,
                        episode: ep.episode_number,
                        overview: ep.overview,
                        thumbnail: ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : null
                    });
                });
            }
        });
        // Sortujemy odcinki
        meta.videos.sort((a,b) => (a.season - b.season) || (a.episode - b.episode));
    }

    return meta;
}

/* =========================
   HELPERS (DASHBOARD & UTILS)
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
function getSearchQuery(filename) {
  let clean = String(filename || "").replace(/[\._]/g, " ");
  // Usuń nawiasy na początku, jeśli są
  clean = clean.replace(/^\[.*?\]/, "").trim();
  // 1. Utnij wszystko od roku (np. 2024)
  let match = clean.match(/^(.+?)\s+(19\d{2}|20\d{2})/);
  if (match && match[1]) return match[1].trim();
  // 2. Utnij wszystko od sezonu (S01)
  match = clean.match(/^(.+?)(?=\s+s\d{2})/i);
  if (match && match[1]) return match[1].trim();
  // 3. Utnij wszystko od jakości (1080p, 4k, web-dl itp.)
  match = clean.match(/^(.+?)(?=\s+(1080|720|4k|2160p|bluray|web|dvd|x264|hevc|uhd))/i);
  if (match && match[1]) return match[1].trim();
  
  return clean;
}

/* =========================
   METADATA CACHE FILLERS
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

/* =========================
   MANAGER UI (HYBRID)
========================= */
app.get("/manager", async (req, res) => {
  try {
      const showHidden = req.query.showHidden === "true";
      const downloadFiles = typeof dashboardHostersOnly === 'function' ? dashboardHostersOnly(ALL_DOWNLOADS_CACHE) : ALL_DOWNLOADS_CACHE;
      
      const groupsDownloads = {};
      const groupsTorrents = {};
      let stats = { totalFiles: downloadFiles.length + ALL_TORRENTS_CACHE.length, size: 0 };

      const addToGroup = (item, targetGroup, isTorrent) => {
          const key = getNormalizedKey(item.filename); 
          const displayTitle = getDisplayTitle(item.filename);
          if (!targetGroup[key]) {
              targetGroup[key] = { key, displayName: displayTitle, files: [], assignedId: null, poster: null, detectedName: null, type: detectType(item.filename), size: 0, isTorrent, status: item.status, progress: item.progress, streamable: item.streamable };
          }
          targetGroup[key].files.push(item);
          const size = isTorrent ? item.bytes : item.filesize;
          targetGroup[key].size += size; 
          stats.size += size;
          if (METADATA_CACHE[item.id]) { const m = METADATA_CACHE[item.id]; targetGroup[key].assignedId = m.id; targetGroup[key].poster = m.poster; targetGroup[key].detectedName = m.name; targetGroup[key].type = m.type; }
      };

      downloadFiles.forEach(f => addToGroup(f, groupsDownloads, false));
      ALL_TORRENTS_CACHE.forEach(t => addToGroup(t, groupsTorrents, true));

      const gridDLSeries = renderGrid('series', groupsDownloads, showHidden, 'downloads', true);
      const gridDLMovie = renderGrid('movie', groupsDownloads, showHidden, 'downloads', false);
      const gridTorSeries = renderGrid('series', groupsTorrents, showHidden, 'torrents', true);
      const gridTorMovie = renderGrid('movie', groupsTorrents, showHidden, 'torrents', false);

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
  } catch (e) { console.error("Błąd Dashboardu:", e); res.status(500).send("Błąd serwera: " + e.message); }
});

function renderGrid(type, groups, showHidden, viewMode, isActive) {
    let html = `<div id="grid-${viewMode}-${type}" class="grid-container ${isActive ? 'active' : ''}">`;
    const sorted = Object.values(groups).filter(g => g.type === type).sort((a,b) => { if (!a.assignedId && b.assignedId) return -1; if (a.assignedId && !b.assignedId) return 1; return b.files.length - a.files.length; });
    for (const g of sorted) {
        if (HIDDEN_GROUPS.has(g.key) && !showHidden) continue;
        const posterSrc = g.poster ? `<img src="${g.poster}" class="poster-img">` : `<div class="no-poster"><span class="icon" style="font-size:40px">image_not_supported</span></div>`;
        const currentId = (g.assignedId && g.assignedId.startsWith("tt")) ? g.assignedId : "";
        // Używamy getSearchQuery zamiast surowego g.displayName
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

/* =========================
   STREMIO MANIFEST & ROUTES (v15)
========================= */
app.get("/manifest.json", (req, res) => {
    // Definicja gatunków do filtrów
    const genreFilters = Object.keys(GENRES).map(g => g.charAt(0).toUpperCase() + g.slice(1));
    
    res.json({
        id: "community.rd.manager.v15",
        version: "15.0.0",
        name: "RDD ULTIMATE PL",
        description: "Manager + Premium VOD + Kino",
        logo: "https://rd-downloads-addon.onrender.com/assets/logo.png",
        resources: ["stream", "catalog", "meta"],
        types: ["movie", "series"],
        idPrefixes: ["tt", "tmdb"],
        catalogs: [
            // MOJE PLIKI (Tu muszą być osobno, bo to cache lokalny)
            { type: "series", id: "rd_series", name: "💎 MOJE SERIALE", extraSupported: ["skip"] }, 
            { type: "movie", id: "rd_movies", name: "💎 MOJE FILMY", extraSupported: ["skip"] },
            
            // W TYM MIESIĄCU (JEDEN SUPER-KATALOG MIX)
            // Definiujemy jako 'movie', ale wsadzimy tu też seriale
            { type: "movie", id: "this_month", name: "◢◤PREMIERY", extraSupported: ["skip"] },

            // PREMIUM 3x3 (NETFLIX)
            { type: "movie", id: "netflix_movies", name: "◢◤NETFLIX", extraSupported: ["skip", "genre"] },
            { type: "series", id: "netflix_series", name: "◢◤NETFLIX", extraSupported: ["skip", "genre"] },
            { type: "movie", id: "netflix_new", name: "◢◤NETFLIX | NOWOŚCI", extraSupported: ["skip"] }, // MIX

            // PREMIUM 3x3 (DISNEY+)
            { type: "movie", id: "disney_movies", name: "◢◤DISNEY+", extraSupported: ["skip", "genre"] },
            { type: "series", id: "disney_series", name: "◢◤DISNEY+", extraSupported: ["skip", "genre"] },
            { type: "movie", id: "disney_new", name: "◢◤DISNEY+ | NOWOŚCI", extraSupported: ["skip"] }, // MIX

            // PREMIUM 3x3 (AMAZON)
            { type: "movie", id: "amazon_movies", name: "◢◤AMZN PRIME", extraSupported: ["skip", "genre"] },
            { type: "series", id: "amazon_series", name: "◢◤AMZN PRIME", extraSupported: ["skip", "genre"] },
            { type: "movie", id: "amazon_new", name: "◢◤AMZN PRIME | NOWOŚCI", extraSupported: ["skip"] }, // MIX

            // GLOBALNE GATUNKI
            { type: "movie", id: "genre_horror", name: "HORRORY", extraSupported: ["skip"] },
            { type: "movie", id: "genre_comedy", name: "KOMEDIE", extraSupported: ["skip"] },
            { type: "movie", id: "genre_scifi", name: "SCI-FI", extraSupported: ["skip"] },
            { type: "movie", id: "genre_action", name: "AKCJA", extraSupported: ["skip"] },
            { type: "movie", id: "genre_animation", name: "ANIMOWANE", extraSupported: ["skip"] }
        ]
    });
});

async function handleCatalog(req, res) {
    const { type, id, extra } = req.params;
    let skip = 0;
    let genre = null;
    
    // Parsowanie extra params (skip i genre)
    if (extra) {
        const skipMatch = extra.match(/skip=(\d+)/);
        if (skipMatch) skip = parseInt(skipMatch[1]);
        const genreMatch = extra.match(/genre=([^&]+)/);
        if (genreMatch) genre = genreMatch[1];
    }

    // OBSŁUGA "MOJE PLIKI" (Lokalny Cache)
    if (id === "rd_series" || id === "rd_movies") {
        const metas = [];
        const files = hostersOnly(ALL_DOWNLOADS_CACHE); 
        const unique = new Set();
        
        const processItem = (item) => {
            const key = getNormalizedKey(item.filename);
            if (HIDDEN_GROUPS.has(key)) return;
            const meta = METADATA_CACHE[item.id];
            if (!meta || !meta.id.startsWith("tt") || meta.type !== type) return;
            if (!unique.has(meta.id)) { unique.add(meta.id); metas.push({ id: meta.id, type: meta.type, name: meta.name, poster: meta.poster }); }
        };

        files.forEach(processItem);
        ALL_TORRENTS_CACHE.filter(t => t.status === 'downloaded').forEach(processItem);
        
        return res.json({ metas: metas.slice(0, 100) });
    }

    // OBSŁUGA KATALOGÓW TMDB (v15 Engine)
    const items = await getCatalog(id, type, genre, skip);
    res.json({ metas: items });
}

app.get("/catalog/:type/:id.json", handleCatalog);
app.get("/catalog/:type/:id/:extra.json", handleCatalog);

app.get("/meta/:type/:id.json", async (req, res) => {
    const { type, id } = req.params;
    if (id.startsWith("tmdb:")) return res.json({ meta: await getMetaFromTMDB(id, type) });
    
    // Obsługa IMDb ID (konwersja na TMDB dla pełnych danych o odcinkach)
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

function parseSeasonEpisode(id) { 
    // Obsługa formatu TMDB: tmdb:123:1:5 (ID:Sezon:Odcinek)
    if (id.startsWith("tmdb:") && id.split(":").length >= 4) {
        const p = id.split(":");
        return { baseId: `tmdb:${p[1]}`, season: p[2], episode: p[3] }; 
    }
    const p = id.split(":"); 
    return { baseId: p[0], season: p[1], episode: p[2] }; 
}

app.get("/stream/:type/:id.json", async (req, res) => {
  const { type, id } = req.params;
  const { baseId, season, episode } = parseSeasonEpisode(id);
  const streams = [];
  
  // 1. SZUKANIE W CACHE (MOJE PLIKI)
  // Musimy znaleźć odpowiednie ID z cache (IMDb lub TMDB)
  // Uproszczenie: Szukamy po prostu pasującego assignedId w grupach
  
  // Dla downloadów
  for (const f of ALL_DOWNLOADS_CACHE) {
    const meta = METADATA_CACHE[f.id];
    // Sprawdzamy czy meta.id pasuje do baseId (może być tt... lub tmdb:...)
    if (meta && (meta.id === baseId || meta.tmdb_id === baseId.replace("tmdb:", ""))) {
      const smartInfo = getStreamInfo(f.filename, f.filesize);
      const title = `${f.filename}\n${smartInfo}`;
      const name = "💎 MOJE RD";
      if (type === "series") {
        if (matchesEpisode(f.filename, season, episode)) streams.push({ name: name, title: title, url: f.download });
      } else { streams.push({ name: name, title: title, url: f.download }); }
    }
  }

  // Dla torrentów
  for (const t of ALL_TORRENTS_CACHE) {
      if (t.status !== 'downloaded') continue;
      const meta = METADATA_CACHE[t.id];
      if (meta && (meta.id === baseId || meta.tmdb_id === baseId.replace("tmdb:", ""))) {
          if (t.files && t.links) {
              t.files.forEach((file, index) => {
                  const match = (type === "series") ? matchesEpisode(file.path, season, episode) : true;
                  if (match) {
                      const myUrl = `${req.protocol}://${req.get('host')}/play/t/${t.id}/${index}`;
                      const title = `[TORRENT] ${path.basename(file.path)}\n${getStreamInfo(file.path, file.bytes)}`;
                      streams.push({ name: "💎 CHMURA", title, url: myUrl });
                  }
              });
          }
      }
  }

  // 2. SEKCJA "PODOBNE" (REKOMENDACJE TMDB)
  // Dodajemy to na końcu listy jako "strumienie", które przekierowują do detali
  try {
      const tmdbId = baseId.replace("tmdb:", "").replace("tt", ""); // Proste czyszczenie, idealnie powinniśmy mieć pewne TMDB ID
      // Jeśli to ID imdb (tt...), musimy najpierw znaleźć TMDB ID.
      let realTmdbId = tmdbId;
      if (baseId.startsWith("tt")) {
          const find = await fetchTMDB(`/find/${baseId}`, "external_source=imdb_id");
          const hit = find?.movie_results?.[0] || find?.tv_results?.[0];
          if (hit) realTmdbId = hit.id;
      }

      const endpoint = type === 'series' ? `/tv/${realTmdbId}/recommendations` : `/movie/${realTmdbId}/recommendations`;
      const recData = await fetchTMDB(endpoint);
      
      if (recData && recData.results) {
          recData.results.slice(0, 5).forEach(rec => {
              const recTitle = rec.title || rec.name;
              const recYear = (rec.release_date || rec.first_air_date || "").substring(0,4);
              // Stremio Deep Link do detali
              const deepLink = `stremio:///detail/${type === 'series' ? 'series' : 'movie'}/tmdb:${rec.id}`;
              
              streams.push({
                  name: "🔍 PODOBNE",
                  title: `${recTitle} (${recYear})\nOcena: ${rec.vote_average}/10`,
                  url: deepLink,
                  behaviorHints: { bingieGroup: "recommendations" } // Opcjonalne
              });
          });
      }
  } catch (e) { console.error("Rec error", e); }

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

app.listen(PORT, "0.0.0.0", () => { console.log("✅ RDD ULTIMATE v15.0 (New Engine) RUNNING"); syncAllDownloads(); setInterval(syncAllDownloads, 15 * 60 * 1000); });