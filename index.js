import express from "express";
import fetch from "node-fetch";
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

// Udostępnianie folderu assets
app.use("/assets", express.static(path.join(__dirname, "assets")));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =========================
   CACHE & STATE
========================= */
let ALL_DOWNLOADS_CACHE = []; // To są Twoje Hostery (Rapidgator)
let ALL_TORRENTS_CACHE = [];  // To są Twoje Torrenty
let METADATA_CACHE = {}; 
let HIDDEN_GROUPS = new Set();
let isUpdating = false;

/* =========================
   TMDB ENGINE (KATALOGI PL)
========================= */
const TMDB_BASE = "https://api.themoviedb.org/3";
const PROVIDERS = { "netflix": "8", "hbo": "384", "disney": "337", "amazon": "119", "apple": "350" };

async function fetchTMDB(endpoint, params = "") {
    if (!TMDB_KEY) return null;
    try {
        const r = await fetch(`${TMDB_BASE}${endpoint}?api_key=${TMDB_KEY}&language=pl-PL&${params}`);
        return await r.json();
    } catch (e) { return null; }
}

async function getCatalog(type, catalogId) {
    let endpoint = "", params = "region=PL&include_adult=false";
    if (catalogId === "trending") endpoint = `/trending/${type}/week`;
    else if (catalogId === "top_rated") endpoint = `/${type}/top_rated`;
    else if (PROVIDERS[catalogId]) {
        endpoint = `/discover/${type}`;
        params += `&with_watch_providers=${PROVIDERS[catalogId]}&watch_region=PL&sort_by=popularity.desc`;
    } else return [];
    
    // FIX: Pobieramy 2 strony, żeby katalogi nie były puste
    let allResults = [];
    for (let i = 1; i <= 2; i++) {
        const data = await fetchTMDB(endpoint, `${params}&page=${i}`);
        if (data && data.results) allResults = allResults.concat(data.results);
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

// Helper do wyciągania meta z TMDB (dla katalogów)
async function getMetaFromTMDB(tmdbId, type) {
    const id = tmdbId.replace("tmdb:", "");
    const data = await fetchTMDB(`/${type}/${id}`, "append_to_response=external_ids");
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
   HELPERS (TWOJE ORYGINALNE + POPRAWKA)
========================= */
function deLeet(s) {
  return String(s || "").replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e")
    .replace(/4/g, "a").replace(/5/g, "s").replace(/7/g, "t").replace(/@/g, "a");
}

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

// ULEPSZONA FUNKCJA CZYSZCZĄCA (v2)
function getSearchQuery(filename) {
  let clean = String(filename || "").replace(/[\._]/g, " ");
  
  // 1. [NOWOŚĆ] Usuń tagi w nawiasach na początku (np. [best-torrents.com])
  clean = clean.replace(/^\[.*?\]/, "").trim();

  // 2. Jeśli znajdzie rok (np. 2008, 2025), utnij wszystko od roku włącznie
  let match = clean.match(/^(.+?)\s+(19\d{2}|20\d{2})/);
  if (match && match[1]) return match[1].trim();
  
  // 3. Jeśli znajdzie sezon (S01), utnij wszystko od sezonu
  match = clean.match(/^(.+?)(?=\s+s\d{2})/i);
  if (match && match[1]) return match[1].trim();

  // 4. Jeśli znajdzie jakość (1080p, 4k, bluray), utnij to
  match = clean.match(/^(.+?)(?=\s+(1080|720|4k|2160p|bluray|web|dvd|x264|uhd))/i);
  if (match && match[1]) return match[1].trim();

  return clean;
}

// [WAŻNE] To jest Twój filtr dla STREMIO (musi być gotowe do oglądania)
function hostersOnly(downloads) {
  return downloads.filter(d => d.streamable === 1 && !d.link.includes("/d/"));
}

// [NAPRAWIONE] To jest filtr dla DASHBOARDU (pokazuje też pobieranie - np. ECHO)
function dashboardHostersOnly(downloads) {
    // Pokazuje wszystko co nie jest folderem (/d/), nawet jak nie jest streamable
    return downloads.filter(d => !d.link.includes("/d/"));
}

function matchesEpisode(filename, season, episode) {
  if (!season || !episode) return false;
  const s = Number(season); 
  const e = Number(episode);
  const re = new RegExp(`S0*${s}[^0-9]*E0*${e}(?![0-9])`, "i");
  const re2 = new RegExp(`\\b${s}x${e}\\b`, "i");
  return re.test(filename) || re2.test(filename);
}

function detectType(filename) {
    if (/S\d{2}/i.test(filename)) return "series";
    return "movie";
}

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

// ✨ CLEAN TAGS FOR STREMIO
function getStreamInfo(filename, sizeBytes) {
    const f = filename.toLowerCase();
    let tags = [];
    if (sizeBytes) tags.push(`${formatBytes(sizeBytes)}`);
    if (f.includes("2160p") || f.includes("4k")) tags.push("4K");
    else if (f.includes("1080p")) tags.push("1080p");
    if (f.includes("hdr")) tags.push("HDR");
    if (f.includes("dv") || f.includes("dolby vision")) tags.push("DV");
    return tags.join(" | ");
}

/* =========================
   METADATA LOGIC (STARA - CINEMETA)
========================= */
async function fetchCinemeta(idOrName) {
  if (!idOrName.startsWith("tt")) return null;
  const metaBase = "https://v3-cinemeta.strem.io";
  try {
    let r = await fetch(`${metaBase}/meta/series/${idOrName}.json`);
    if (r.ok) {
      let j = await r.json();
      if (j?.meta) return { id: j.meta.imdb_id, name: j.meta.name, poster: j.meta.poster, type: "series" };
    }
    r = await fetch(`${metaBase}/meta/movie/${idOrName}.json`);
    if (r.ok) {
      let j = await r.json();
      if (j?.meta) return { id: j.meta.imdb_id, name: j.meta.name, poster: j.meta.poster, type: "movie" };
    }
  } catch (err) { console.error(`⚠️ Błąd Cinemeta:`, err.message); return null; }
  return null;
}

// [NOWE] Helper TMDB do szukania ID dla Torrentów
async function fetchByImdbTMDB(imdbId) {
    if (!TMDB_KEY) return null;
    const data = await fetchTMDB(`/find/${imdbId}`, "external_source=imdb_id");
    const res = data?.movie_results?.[0] || data?.tv_results?.[0];
    if (res) return { id: imdbId, name: res.title || res.name, poster: res.poster_path ? `https://image.tmdb.org/t/p/w500${res.poster_path}` : null, type: res.media_type || (res.title ? "movie" : "series") };
    return null;
}

/* =========================
   MANAGER UI (THE SWITCH EDITION)
========================= */
app.get("/manager", (req, res) => {
  const showHidden = req.query.showHidden === "true"; 
  
  // 1. DANE DLA DOWNLOADS (Używamy teraz dashboardHostersOnly!)
  const downloadFiles = dashboardHostersOnly(ALL_DOWNLOADS_CACHE);
  const groupsDownloads = {};
  
  // 2. DANE DLA TORRENTS
  const groupsTorrents = {};

  let stats = { totalFiles: downloadFiles.length + ALL_TORRENTS_CACHE.length, size: 0 };

  // Helper do grupowania (uniwersalny)
  const addToGroup = (item, targetGroup, isTorrent) => {
      const key = getNormalizedKey(item.filename); 
      const displayTitle = getDisplayTitle(item.filename);

      if (!targetGroup[key]) {
        targetGroup[key] = {
          key: key, displayName: displayTitle, files: [], assignedId: null, poster: null, detectedName: null, 
          type: detectType(item.filename), size: 0, isTorrent: isTorrent, status: item.status, progress: item.progress, streamable: item.streamable
        };
      }
      targetGroup[key].files.push(item);
      const size = isTorrent ? item.bytes : item.filesize;
      targetGroup[key].size += size; 
      stats.size += size;
      
      if (METADATA_CACHE[item.id]) {
        targetGroup[key].assignedId = METADATA_CACHE[item.id].id;
        targetGroup[key].poster = METADATA_CACHE[item.id].poster;
        targetGroup[key].detectedName = METADATA_CACHE[item.id].name;
        targetGroup[key].type = METADATA_CACHE[item.id].type;
      }
  };

  // Wypełnij grupy
  downloadFiles.forEach(f => addToGroup(f, groupsDownloads, false));
  ALL_TORRENTS_CACHE.forEach(t => addToGroup(t, groupsTorrents, true));

  let html = `
  <html>
  <head>
    <title>RDD ULTIMATE</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0"> 
    <link rel="icon" type="image/png" href="/assets/fav.png">
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0" />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap" rel="stylesheet">
    
    <style>
      :root { --primary: #F72C25; --bg: #111111; --card-bg: #1a1a1a; --card-border: #333333; --input-bg: #0a0a0a; --text: #ffffff; --text-muted: #888888; --danger: #ef4444; --success: #10b981; }
      body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); margin: 0; padding-bottom: 80px; -webkit-font-smoothing: antialiased; }
      .icon { font-family: 'Material Symbols Outlined'; font-size: 20px; vertical-align: middle; } .icon-lg { font-size: 24px; }
      .header { background: radial-gradient(circle at top, rgba(247, 44, 37, 0.15) 0%, transparent 70%); padding: 30px 20px 20px; text-align: center; }
      .stats-bar { display: flex; justify-content: center; gap: 20px; margin-top: 10px; font-size: 0.85em; color: var(--text-muted); }
      
      /* SWITCH STYLES */
      .switch-container { display: flex; justify-content: center; gap: 0; margin: 20px auto; width: fit-content; border: 1px solid var(--card-border); border-radius: 8px; background: var(--card-bg); overflow: hidden; }
      .switch-btn { padding: 12px 25px; border: none; background: transparent; color: #888; cursor: pointer; font-weight: 800; font-size: 1em; transition: 0.2s; box-shadow: none; border-radius: 0;}
      .switch-btn.active { background: var(--primary); color: #fff; }
      .switch-btn:hover:not(.active) { color: #fff; background: #222; }
      
      .view-section { display: none; animation: fadeIn 0.4s ease; }
      .view-section.active { display: block; }

      .downloader-card { max-width: 600px; margin: 20px auto; padding: 25px; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
      .downloader-header { color: var(--primary); font-weight: 800; display: flex; align-items: center; gap: 10px; margin-bottom: 15px; font-size: 1.1em; }
      textarea, input { width: 100%; background: var(--input-bg); color: #fff; border: 1px solid var(--card-border); border-radius: 8px; padding: 12px; font-family: monospace; resize: vertical; outline: none; transition: 0.2s; margin-bottom: 10px; }
      textarea:focus, input:focus { border-color: var(--primary); }
      label { display: block; margin: 5px 0; font-size: 0.85em; color: var(--text-muted); font-weight: 600; }

      .search-container { max-width: 400px; margin: 20px auto; padding: 0 15px; position: relative; }
      .search-icon { position: absolute; left: 25px; top: 50%; transform: translateY(-50%); color: var(--text-muted); }
      .search-input { width: 100%; padding: 14px 14px 14px 45px; border-radius: 99px; border: 1px solid var(--card-border); background: var(--card-bg); color: #fff; outline: none; }
      
      .tabs { display: flex; justify-content: center; gap: 10px; margin: 25px 0; }
      .tab { padding: 10px 24px; border-radius: 99px; cursor: pointer; background: var(--card-bg); border: 1px solid var(--card-border); color: var(--text-muted); font-weight: 600; font-size: 0.9em; display: flex; align-items: center; gap: 8px; transition: 0.3s; }
      .tab.active { background: var(--primary); color: #fff; border-color: var(--primary); }

      .grid-container { display: none; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 15px; padding: 0 15px; } .grid-container.active { display: grid; }
      .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; transition: transform 0.2s; } .card:hover { transform: translateY(-3px); border-color: #444; } .card.hidden-item { opacity: 0.5; filter: grayscale(100%); border-style: dashed; }
      .poster-area { height: 240px; background: #000; position: relative; cursor: pointer; } .poster-img { width: 100%; height: 100%; object-fit: cover; }
      .no-poster { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: #444; background: #000; }
      .badge { position: absolute; top: 8px; right: 8px; background: rgba(0,0,0,0.7); color: #fff; border-radius: 6px; padding: 4px 8px; font-size: 0.75em; font-weight: bold; backdrop-filter: blur(4px); }
      .size-badge { position: absolute; bottom: 8px; left: 8px; background: var(--primary); color: #fff; padding: 3px 6px; font-size: 0.7em; font-weight: bold; border-radius: 4px; }
      .content { padding: 15px; display: flex; flex-direction: column; gap: 12px; }
      .title { font-weight: 700; color: #fff; font-size: 1em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .input-row { display: flex; gap: 8px; }
      button { background: var(--primary); color: #fff; font-weight: 700; border: none; border-radius: 8px; padding: 10px; cursor: pointer; text-transform: uppercase; font-size: 0.75em; display: flex; align-items: center; justify-content: center; gap: 6px; transition: 0.2s; box-shadow: 0 2px 10px rgba(0,0,0,0.2); }
      .refresh-btn { padding: 10px 20px; background: var(--card-bg); color: #fff; border: 1px solid var(--card-border); box-shadow: none; }
      .btn-icon-only { width: 40px; padding: 0; }
      .btn-delete { background: transparent; color: var(--danger); border: 1px solid var(--card-border); width: 100%; box-shadow: none; }
      .btn-restore { background: transparent; color: var(--success); border: 1px solid var(--success); width: 100%; box-shadow: none; }
      .btn-imdb { background: transparent; color: #fff; border: 1px solid var(--card-border); width: 100%; text-decoration: none; padding: 8px; border-radius: 8px; font-size: 0.8em; font-weight: bold; display: flex; align-items: center; justify-content: center; gap: 5px; }
      .status-text { font-size: 0.8em; font-weight: bold; margin-bottom: 5px; }
      
      /* MODAL */
      .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); z-index: 1000; display: none; justify-content: center; align-items: center; padding: 20px; backdrop-filter: blur(10px); }
      .modal-content { background: var(--card-bg); width: 90%; max-width: 500px; max-height: 80vh; border-radius: 20px; padding: 0; border: 1px solid var(--card-border); display: flex; flex-direction: column; }
      .modal-header { padding: 20px; border-bottom: 1px solid var(--card-border); display: flex; justify-content: space-between; align-items: center; }
      .modal-title { font-size: 1.2em; font-weight: 800; color: #fff; }
      .modal-body { overflow-y: auto; padding: 20px; color: #ccc; font-family: monospace; font-size: 0.9em; line-height: 1.6; }
      .file-item { padding: 8px 0; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 10px; }
      .modal-footer { padding: 20px; border-top: 1px solid var(--card-border); }
      .close-btn { background: #333; color: #fff; width: 100%; padding: 12px; }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    </style>
    <script>
      // LOGIKA SWITCHA
      function toggleView(view) {
          // Buttons
          document.getElementById('btn-downloads').classList.remove('active');
          document.getElementById('btn-torrents').classList.remove('active');
          document.getElementById('btn-' + view).classList.add('active');
          
          // Views
          document.getElementById('view-downloads').classList.remove('active');
          document.getElementById('view-torrents').classList.remove('active');
          document.getElementById('view-' + view).classList.add('active');
          
          // Reset tabs
          switchTab(view, 'series');
      }

      function switchTab(view, type) {
        // Ukryj wszystkie w tym widoku
        const container = document.getElementById('view-' + view);
        container.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        container.querySelectorAll('.grid-container').forEach(g => g.classList.remove('active'));
        
        // Pokaż właściwe
        document.getElementById('tab-' + view + '-' + type).classList.add('active');
        document.getElementById('grid-' + view + '-' + type).classList.add('active');
      }

      function showDetails(title, filesEncoded) {
        const files = JSON.parse(decodeURIComponent(filesEncoded));
        document.getElementById('modalTitle').textContent = title;
        document.getElementById('modalBody').innerHTML = files.map(f => \`
            <div class="file-item"><span class="icon" style="color:#666">description</span><span>\${f}</span></div>\`).join('');
        document.getElementById('infoModal').style.display = 'flex';
      }
      function closeModal() { document.getElementById('infoModal').style.display = 'none'; }
      window.onclick = function(event) { if (event.target == document.getElementById('infoModal')) closeModal(); }
      function filterGrid() {
          const input = document.getElementById('searchInput').value.toLowerCase();
          document.querySelectorAll('.card').forEach(card => {
              // Filtruj tylko w aktywnym widoku
              if(card.offsetParent !== null) {
                  card.style.display = card.getAttribute('data-title').toLowerCase().includes(input) ? 'flex' : 'none';
              }
          });
      }
      function confirmDelete() { return confirm("⚠️ CZY NA PEWNO? \\nUsuniesz te pliki fizycznie z RD!"); }
    </script>
  </head>
  <body>
    
    <div id="infoModal" class="modal-overlay">
      <div class="modal-content">
        <div class="modal-header"><div id="modalTitle" class="modal-title"></div><button onclick="closeModal()" class="btn-icon-only" style="background:transparent;color:#fff;box-shadow:none"><span class="icon">close</span></button></div>
        <div id="modalBody" class="modal-body"></div>
        <div class="modal-footer"><button class="close-btn" onclick="closeModal()">ZAMKNIJ</button></div>
      </div>
    </div>

    <div class="header">
        <img src="/assets/logo.png" alt="RDD MANAGER" style="max-height: 70px; width: auto; margin-bottom: 10px; display: block; margin-left: auto; margin-right: auto;">
        <div class="stats-bar">
             <div class="stat-item"><span class="icon">hard_drive</span> <strong>${formatBytes(stats.size)}</strong></div>
             <div class="stat-item"><span class="icon">movie</span> <strong>${stats.totalFiles}</strong> plików</div>
        </div>
    </div>

    <div class="switch-container">
        <button id="btn-downloads" class="switch-btn active" onclick="toggleView('downloads')"><span class="icon">download</span> DOWNLOADS</button>
        <button id="btn-torrents" class="switch-btn" onclick="toggleView('torrents')"><span class="icon">link</span> TORRENTS</button>
    </div>

    <div id="view-downloads" class="view-section active">
        <div class="downloader-card">
            <div class="downloader-header"><span class="icon icon-lg">rocket_launch</span> SZYBKI DOWNLOADER (Hostery)</div>
            <form action="/manager/add-links" method="POST">
                <label>1. Wklej linki (Rapidgator itp.):</label>
                <textarea name="links" rows="4" placeholder="https://rapidgator.net/file/..."></textarea>
                <label>2. Wpisz ID IMDb (opcjonalne):</label>
                <div class="input-row">
                    <input type="text" name="imdbId" placeholder="tt1234567">
                    <button type="submit" style="width:auto; padding: 0 25px;"><span class="icon">download</span> POBIERZ</button>
                </div>
            </form>
        </div>
        
        <div class="tabs">
            <div id="tab-downloads-series" class="tab active" onclick="switchTab('downloads', 'series')"><span class="icon">tv</span> SERIALE</div>
            <div id="tab-downloads-movie" class="tab" onclick="switchTab('downloads', 'movie')"><span class="icon">movie</span> FILMY</div>
        </div>

        ${renderGrid("series", groupsDownloads, showHidden, 'downloads', true)}
        ${renderGrid("movie", groupsDownloads, showHidden, 'downloads', false)}
    </div>

    <div id="view-torrents" class="view-section">
        <div class="downloader-card">
            <div class="downloader-header"><span class="icon icon-lg">link</span> DODAJ MAGNET (Torrenty)</div>
            <form action="/manager/add-magnet" method="POST">
                <label>1. Wklej Magnet Link lub Hash:</label>
                <input type="text" name="magnet" placeholder="magnet:?xt=urn:btih:...">
                <label>2. Wpisz ID IMDb (opcjonalne):</label>
                <div class="input-row">
                    <input type="text" name="imdbId" placeholder="tt1234567">
                    <button type="submit" style="width:auto; padding: 0 25px;"><span class="icon">cloud_upload</span> DODAJ</button>
                </div>
            </form>
        </div>

        <div class="tabs">
            <div id="tab-torrents-series" class="tab active" onclick="switchTab('torrents', 'series')"><span class="icon">tv</span> SERIALE</div>
            <div id="tab-torrents-movie" class="tab" onclick="switchTab('torrents', 'movie')"><span class="icon">movie</span> FILMY</div>
        </div>

        ${renderGrid("series", groupsTorrents, showHidden, 'torrents', true)}
        ${renderGrid("movie", groupsTorrents, showHidden, 'torrents', false)}
    </div>

    <div class="search-container">
        <span class="icon search-icon">search</span>
        <input type="text" id="searchInput" class="search-input" onkeyup="filterGrid()" placeholder="Szukaj w kolekcji...">
    </div>

    <div style="display:flex; justify-content:center; gap:10px; margin-bottom:20px; margin-top:20px;">
        <form action="/manager/refresh" method="POST" style="margin:0"><button type="submit" class="refresh-btn"><span class="icon">refresh</span> Odśwież</button></form>
        <a href="/manager?showHidden=${!showHidden}" style="text-decoration:none"><button type="button" class="refresh-btn">
            <span class="icon">${showHidden ? 'visibility_off' : 'delete_sweep'}</span> ${showHidden ? 'Kosz' : 'Kosz'}
        </button></a>
    </div>

  </body>
  </html>
  `;
  res.send(html);
});

function renderGrid(type, groups, showHidden, viewMode, isActive) {
    let html = `<div id="grid-${viewMode}-${type}" class="grid-container ${isActive ? 'active' : ''}">`;
    
    const sorted = Object.values(groups).filter(g => g.type === type).sort((a,b) => {
         if (!a.assignedId && b.assignedId) return -1;
         if (a.assignedId && !b.assignedId) return 1;
         return b.files.length - a.files.length;
    });

    for (const g of sorted) {
        if (HIDDEN_GROUPS.has(g.key) && !showHidden) continue;
        
        const posterSrc = g.poster ? `<img src="${g.poster}" class="poster-img">` : `<div class="no-poster"><span class="icon" style="font-size:40px">image_not_supported</span></div>`;
        const currentId = (g.assignedId && g.assignedId.startsWith("tt")) ? g.assignedId : "";
        const searchUrl = `https://www.imdb.com/find?q=${encodeURIComponent(g.displayName)}`;
        const cardClass = HIDDEN_GROUPS.has(g.key) ? "card hidden-item" : "card";
        const filesEncoded = encodeURIComponent(JSON.stringify(g.files.map(f => f.filename)));
        const safeTitle = g.detectedName || g.displayName;
        const downloadIds = g.files.map(f => f.id).join(",");

        // Status bar dla Torrentów LUB pobierania Rapidgator
        let statusHtml = "";
        
        // WARUNEK: Jeśli to torrent ALBO jeśli to rapidgator, który nie jest streamable (czyli się konwertuje)
        if (g.isTorrent || (g.streamable !== 1 && !g.isTorrent)) {
            let color = "#10b981"; // Zielony
            let text = "GOTOWE";
            
            if (g.isTorrent) {
                if (g.status === 'downloading') { color = "#f59e0b"; text = `POBIERANIE ${g.progress || 0}%`; }
                else if (g.status === 'magnet_conversion') { color = "#8b5cf6"; text = "KONWERSJA"; }
            } else {
                // Dla Rapidgatorów - jeśli nie streamable, to pewnie konwersja
                color = "#f59e0b"; text = "PRZETWARZANIE...";
            }
            
            statusHtml = `<div class="status-text" style="color:${color}">${text}</div>`;
        }

        html += `
          <div class="${cardClass}" data-title="${safeTitle}">
            <div class="poster-area" onclick="showDetails('${safeTitle.replace(/'/g, "\\'")}', '${filesEncoded}')">
                ${posterSrc}
                <div class="badge"><span class="icon" style="font-size:14px">folder</span> ${g.files.length}</div>
                <div class="size-badge">${formatBytes(g.size)}</div>
            </div>
            <div class="content">
              <div class="title" onclick="showDetails('${safeTitle.replace(/'/g, "\\'")}', '${filesEncoded}')">${safeTitle}</div>
              ${statusHtml}
              
              <a href="${searchUrl}" target="_blank" class="btn-imdb">
                <span class="icon" style="font-size:16px">search</span> Szukaj ID
              </a>

              <form action="/manager/update-group" method="POST" style="margin:0;">
                <input type="hidden" name="groupKey" value="${g.key}">
                <div class="input-row">
                    <input type="text" name="imdbId" value="${currentId}" placeholder="tt...">
                    <button type="submit" class="btn-icon-only"><span class="icon">save</span></button>
                </div>
              </form>

              <div style="display:flex; gap:5px; margin-top:5px;">
                  <form action="/manager/toggle-hide" method="POST" style="margin:0; flex:1;">
                    <input type="hidden" name="groupKey" value="${g.key}">
                    ${HIDDEN_GROUPS.has(g.key) 
                        ? `<button type="submit" class="btn-restore"><span class="icon">undo</span></button>` 
                        : `<button type="submit" class="btn-delete" style="color:#888; border-color:#444"><span class="icon">visibility_off</span></button>`
                    }
                  </form>
                  <form action="/manager/delete-rd" method="POST" style="margin:0; flex:1;" onsubmit="return confirmDelete()">
                     <input type="hidden" name="downloadIds" value="${downloadIds}">
                     <button type="submit" class="btn-delete"><span class="icon">delete</span></button>
                  </form>
              </div>

            </div>
          </div>`;
    }
    return html + `</div>`;
}

// === DOWNLOADER (HOSTERY) - STARA LOGIKA ===
app.post("/manager/add-links", async (req, res) => {
    const { links, imdbId } = req.body;
    const linkList = links.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    
    let meta = null;
    if (imdbId && imdbId.startsWith("tt")) {
        meta = await fetchCinemeta(imdbId);
        if (!meta) meta = { id: imdbId, name: "Wymuszono: " + imdbId, poster: null, type: "series" };
    }

    for (const link of linkList) {
        try {
            const params = new URLSearchParams();
            params.append('link', link);
            const r = await fetch("https://api.real-debrid.com/rest/1.0/unrestrict/link", {
                method: "POST", headers: { Authorization: `Bearer ${RD_TOKEN}` }, body: params
            });
            const data = await r.json();
            if (data.id && meta) METADATA_CACHE[data.id] = meta;
        } catch (e) { console.error("Network error:", e); }
    }
    setTimeout(syncAllDownloads, 1000); 
    res.redirect("/manager");
});

// === TORRENTS ADDER (NOWA LOGIKA) ===
app.post("/manager/add-magnet", async (req, res) => {
    const { magnet, imdbId } = req.body;
    try {
        const params = new URLSearchParams(); params.append('magnet', magnet);
        const r = await fetch("https://api.real-debrid.com/rest/1.0/torrents/addMagnet", { method: "POST", headers: { Authorization: `Bearer ${RD_TOKEN}` }, body: params });
        const data = await r.json();
        
        if (data.id) {
            // Select ALL files
            const selParams = new URLSearchParams(); selParams.append('files', 'all');
            await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${data.id}`, { method: "POST", headers: { Authorization: `Bearer ${RD_TOKEN}` }, body: selParams });
            
            // Meta
            if (imdbId) {
                let meta = await fetchByImdbTMDB(imdbId);
                if (!meta) meta = await fetchCinemeta(imdbId);
                METADATA_CACHE[data.id] = meta;
            }
        }
    } catch(e) { console.error(e); }
    setTimeout(syncAllDownloads, 1500); 
    res.redirect("/manager");
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
  if (imdbId && imdbId.startsWith("tt")) {
    let meta = await fetchCinemeta(imdbId);
    
    // Update Downloads
    const files = dashboardHostersOnly(ALL_DOWNLOADS_CACHE);
    for (const f of files) { if (getNormalizedKey(f.filename) === groupKey) METADATA_CACHE[f.id] = meta; }
    
    // Update Torrents
    ALL_TORRENTS_CACHE.forEach(t => { if (getNormalizedKey(t.filename) === groupKey) METADATA_CACHE[t.id] = meta; });
  }
  res.redirect("/manager");
});

// === SYNC (TERAZ POBIERA I DOWNLOADS I TORRENTS) ===
async function syncAllDownloads() {
  if (isUpdating) return;
  isUpdating = true;
  
  try {
    // 1. Pobierz Downloads (Hostery) - Stara pętla
    let page = 1, dlItems = [], keep = true;
    while (keep) {
      const r = await fetch(`https://api.real-debrid.com/rest/1.0/downloads?limit=100&page=${page}`, { headers: { Authorization: `Bearer ${RD_TOKEN}` } });
      if (!r.ok) break;
      const data = await r.json().catch(() => []);
      if (!Array.isArray(data) || data.length === 0) keep = false;
      else { dlItems = dlItems.concat(data); if (data.length < 100) keep = false; else page++; await new Promise(r => setTimeout(r, 200)); }
    }
    ALL_DOWNLOADS_CACHE = dlItems;

    // 2. Pobierz Torrents - Nowa pętla
    page = 1; let torItems = []; keep = true;
    while (keep) {
      const r = await fetch(`https://api.real-debrid.com/rest/1.0/torrents?limit=100&page=${page}`, { headers: { Authorization: `Bearer ${RD_TOKEN}` } });
      if (!r.ok) break;
      const data = await r.json().catch(() => []);
      if (!Array.isArray(data) || data.length === 0) keep = false;
      else { 
          torItems = torItems.concat(data); 
          if (data.length < 100) keep = false; else page++; 
          await new Promise(r => setTimeout(r, 200)); 
      }
    }
    
    const detailedTorrents = [];
    for (const t of torItems) {
        if (t.status === 'downloaded') {
            await new Promise(r => setTimeout(r, 50)); 
            const infoRes = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${t.id}`, { headers: { Authorization: `Bearer ${RD_TOKEN}` } });
            const info = await infoRes.json();
            if (info && info.files) {
                t.files = info.files.filter(f => f.selected === 1);
                t.links = info.links;
                detailedTorrents.push(t);
            }
        } else {
            detailedTorrents.push(t);
        }
    }
    ALL_TORRENTS_CACHE = detailedTorrents;

  } catch (e) { console.error("Sync error:", e.message); } finally { isUpdating = false; }
}

app.get("/manifest.json", (req, res) => {
  res.json({
    id: "community.rd.manager.final",
    version: "3.0.0",
    name: "RDD ULTIMATE",
    description: "VOD Manager.",
    logo: "https://rd-downloads-addon.onrender.com/assets/logo.png",
    resources: ["stream", "catalog", "meta"],
    types: ["movie", "series"],
    idPrefixes: ["tt", "tmdb"],
    catalogs: [
        { type: "series", id: "rd_series", name: "Moje Seriale (RD)" }, 
        { type: "movie", id: "rd_movies", name: "Moje Filmy (RD)" },
        // NOWE KATALOGI TMDB
        { type: "movie", id: "trending", name: "🔥 Popularne Filmy" },
        { type: "series", id: "trending", name: "🔥 Popularne Seriale" },
        { type: "movie", id: "netflix", name: "🔴 Netflix (Filmy)" },
        { type: "series", id: "netflix", name: "🔴 Netflix (Seriale)" },
        { type: "movie", id: "hbo", name: "🟣 HBO Max (Filmy)" },
        { type: "series", id: "hbo", name: "🟣 HBO Max (Seriale)" },
        { type: "movie", id: "disney", name: "🟢 Disney+ (Filmy)" },
        { type: "series", id: "disney", name: "🟢 Disney+ (Seriale)" },
        { type: "movie", id: "amazon", name: "🔵 Prime Video (Filmy)" },
        { type: "series", id: "amazon", name: "🔵 Prime Video (Seriale)" },
        { type: "movie", id: "apple", name: "🍏 Apple TV+ (Filmy)" }
    ]
  });
});

app.get("/catalog/:type/:id.json", async (req, res) => {
  const { type, id } = req.params;

  if (id === "rd_series" || id === "rd_movies") {
      const metas = [];
      const files = hostersOnly(ALL_DOWNLOADS_CACHE); // STARY FILTR DLA STREMIO
      const unique = new Set();
      
      for (const f of files) {
        const key = getNormalizedKey(f.filename);
        if (HIDDEN_GROUPS.has(key)) continue;
        const meta = METADATA_CACHE[f.id];
        if (!meta || !meta.id.startsWith("tt") || meta.type !== type) continue;
        if (!unique.has(meta.id)) { unique.add(meta.id); metas.push({ id: meta.id, type: meta.type, name: meta.name, poster: meta.poster }); }
      }
      
      // Torrenty w Stremio (tylko gotowe)
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

  const items = await getCatalog(type, id);
  res.json({ metas: items });
});

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
  
  // 1. DOWNLOADS
  for (const f of ALL_DOWNLOADS_CACHE) {
    const meta = METADATA_CACHE[f.id];
    if (meta && meta.id === baseId) {
      const smartInfo = getStreamInfo(f.filename, f.filesize);
      const title = `${f.filename}\n${smartInfo}`;
      const name = "💎 MOJE RD";
      if (type === "series") {
        if (matchesEpisode(f.filename, season, episode)) streams.push({ name: name, title: title, url: f.download });
      } else {
         streams.push({ name: name, title: title, url: f.download });
      }
    }
  }

  // 2. TORRENTS
  for (const t of ALL_TORRENTS_CACHE) {
      if (t.status !== 'downloaded') continue;
      const meta = METADATA_CACHE[t.id];
      if (meta && meta.id === baseId) {
          if (t.files && t.links) {
              t.files.forEach((file, index) => {
                  const isVid = /\.(mkv|mp4|avi)$/i.test(file.path);
                  let match = false;
                  if (type === "series") match = matchesEpisode(file.path, season, episode);
                  else match = true;

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

app.listen(PORT, "0.0.0.0", () => { console.log("✅ Server running."); syncAllDownloads(); setInterval(syncAllDownloads, 15 * 60 * 1000); });