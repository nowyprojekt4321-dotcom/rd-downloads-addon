import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

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

const PORT = process.env.PORT || 3001;
const RD_TOKEN = process.env.RD_TOKEN;

if (!RD_TOKEN) {
  console.error("❌ RD_TOKEN is not set.");
  process.exit(1);
}

/* =========================
   CACHE & STATE
========================= */
let ALL_DOWNLOADS_CACHE = []; 
let METADATA_CACHE = {}; 
let HIDDEN_GROUPS = new Set();
let isUpdating = false;

/* =========================
   HELPERS
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

function hostersOnly(downloads) {
  return downloads.filter(d => d.streamable === 1 && !d.link.includes("/d/"));
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
    if (f.includes("atmos")) tags.push("Atmos");
    if (f.includes("5.1")) tags.push("5.1");
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

/* =========================
   MANAGER UI (MODERN RED)
========================= */
app.get("/manager", (req, res) => {
  const showHidden = req.query.showHidden === "true"; 
  const files = hostersOnly(ALL_DOWNLOADS_CACHE);
  const groups = {};
  let stats = { totalFiles: files.length, series: 0, movies: 0, totalSize: 0 };

  for (const f of files) {
    const key = getNormalizedKey(f.filename); 
    const displayTitle = getDisplayTitle(f.filename);

    if (!groups[key]) {
      groups[key] = {
        key: key, displayName: displayTitle, files: [], assignedId: null, poster: null, detectedName: null, type: detectType(f.filename), size: 0
      };
    }
    groups[key].files.push(f);
    groups[key].size += f.filesize; 
    stats.totalSize += f.filesize;
    
    if (METADATA_CACHE[f.id]) {
      groups[key].assignedId = METADATA_CACHE[f.id].id;
      groups[key].poster = METADATA_CACHE[f.id].poster;
      groups[key].detectedName = METADATA_CACHE[f.id].name;
      groups[key].type = METADATA_CACHE[f.id].type;
    }
  }
  Object.values(groups).forEach(g => { if (g.type === 'series') stats.series++; else stats.movies++; });

  let html = `
  <html>
  <head>
    <title>RD Manager</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0"> 
    <link rel="icon" type="image/png" href="/assets/fav.png">
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0" />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap" rel="stylesheet">
    
    <style>
      /* --- NOWOCZESNA PALETA KOLORÓW --- */
      :root {
        /* Twój wybrany akcent (RED) */
        --primary: #F72C25;
        
        /* Tła "Niedokońca czarne" */
        --bg: #111111;         /* Główne tło */
        --card-bg: #1a1a1a;    /* Karty (jaśniejsze) */
        --card-border: #333333;
        --input-bg: #0a0a0a;

        --text: #ffffff;
        --text-muted: #888888;
        --danger: #ef4444;
        --success: #10b981;
      }
      
      body { 
        font-family: 'Inter', sans-serif; 
        background: var(--bg); 
        color: var(--text); 
        margin: 0; 
        padding-bottom: 80px;
        -webkit-font-smoothing: antialiased;
      }
      
      .icon { font-family: 'Material Symbols Outlined'; font-weight: normal; font-style: normal; font-size: 20px; line-height: 1; display: inline-block; vertical-align: middle; }
      .icon-lg { font-size: 24px; }
      
      /* Header z delikatnym gradientem koloru akcentu */
      .header { 
        background: radial-gradient(circle at top, rgba(247, 44, 37, 0.15) 0%, transparent 70%); 
        padding: 30px 20px 20px; text-align: center; border-bottom: 1px solid transparent;
      }
      
      .stats-bar { display: flex; justify-content: center; gap: 20px; margin-top: 10px; font-size: 0.85em; color: var(--text-muted); }
      .stat-item { display: flex; align-items: center; gap: 6px; }
      .stat-item strong { color: #fff; }

      /* Downloader - bardziej płaski i nowoczesny */
      .downloader-card { 
        max-width: 600px; margin: 20px auto; padding: 25px; 
        background: var(--card-bg); 
        border: 1px solid var(--card-border); 
        border-radius: 16px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.2);
        margin-left: 10px;
        margin-right: 10px;
      }
      .downloader-header { color: var(--primary); font-weight: 800; display: flex; align-items: center; gap: 10px; margin-bottom: 15px; font-size: 1.1em; }
      textarea { width: 100%; background: var(--input-bg); color: #fff; border: 1px solid var(--card-border); border-radius: 8px; padding: 12px; font-family: monospace; resize: vertical; outline: none; transition: 0.2s; }
      textarea:focus { border-color: var(--primary); }
      label { display: block; margin: 15px 0 8px; font-size: 0.85em; color: var(--text-muted); font-weight: 600; }

      .search-container { max-width: 400px; margin: 20px auto; padding: 0 15px; position: relative; }
      .search-icon { position: absolute; left: 25px; top: 50%; transform: translateY(-50%); color: var(--text-muted); }
      .search-input { width: 100%; padding: 14px 14px 14px 45px; border-radius: 99px; border: 1px solid var(--card-border); background: var(--card-bg); color: #fff; outline: none; transition: 0.3s; font-size: 0.95em; }
      .search-input:focus { border-color: var(--primary); box-shadow: 0 0 0 2px rgba(247, 44, 37, 0.2); }
      
      .tabs { display: flex; justify-content: center; gap: 10px; margin: 25px 0; }
      .tab { padding: 10px 24px; border-radius: 99px; cursor: pointer; background: var(--card-bg); border: 1px solid var(--card-border); color: var(--text-muted); font-weight: 600; font-size: 0.9em; display: flex; align-items: center; gap: 8px; transition: 0.3s; }
      .tab:hover { background: #222; color: #fff; }
      .tab.active { background: var(--primary); color: #fff; border-color: var(--primary); box-shadow: 0 4px 15px rgba(247, 44, 37, 0.4); }

      .grid-container { display: none; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 15px; padding: 0 15px; animation: fadeIn 0.4s ease; }
      .grid-container.active { display: grid; }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

      .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; transition: transform 0.2s, box-shadow 0.2s; }
      .card:hover { transform: translateY(-3px); box-shadow: 0 10px 20px rgba(0,0,0,0.3); border-color: #444; }
      .card.hidden-item { opacity: 0.5; filter: grayscale(100%); border-style: dashed; }
      
      .poster-area { height: 240px; background: #000; position: relative; cursor: pointer; }
      .poster-img { width: 100%; height: 100%; object-fit: cover; }
      .no-poster { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: #444; background: #000; }
      .badge { position: absolute; top: 8px; right: 8px; background: rgba(0,0,0,0.7); color: #fff; border-radius: 6px; padding: 4px 8px; font-size: 0.75em; font-weight: bold; backdrop-filter: blur(4px); display: flex; align-items: center; gap: 4px; }
      .size-badge { position: absolute; bottom: 8px; left: 8px; background: var(--primary); color: #fff; padding: 3px 6px; font-size: 0.7em; font-weight: bold; border-radius: 4px; box-shadow: 0 2px 10px rgba(0,0,0,0.3); }
      
      .content { padding: 15px; display: flex; flex-direction: column; gap: 12px; }
      .title { font-weight: 700; color: #fff; font-size: 1em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      
      .input-row { display: flex; gap: 8px; }
      input { background: var(--input-bg); color: #fff; border: 1px solid var(--card-border); border-radius: 6px; padding: 10px; width: 100%; outline: none; font-size: 0.9em; transition: 0.2s; }
      input:focus { border-color: var(--primary); }
      
      /* Przyciski z efektem Glow */
      button { 
        background: var(--primary); color: #fff; font-weight: 700; border: none; border-radius: 8px; padding: 10px; cursor: pointer; 
        text-transform: uppercase; font-size: 0.75em; display: flex; align-items: center; justify-content: center; gap: 6px; transition: 0.2s; 
        box-shadow: 0 2px 10px rgba(0,0,0,0.2);
      }
      button:hover { filter: brightness(1.1); transform: translateY(-1px); }
      
      .refresh-btn { padding: 10px 20px; background: var(--card-bg); color: #fff; border: 1px solid var(--card-border); box-shadow: none; }
      .refresh-btn:hover { background: #333; border-color: #555; }
      
      .btn-icon-only { width: 40px; padding: 0; }
      .btn-delete { background: transparent; color: var(--danger); border: 1px solid var(--card-border); width: 100%; box-shadow: none; }
      .btn-delete:hover { background: rgba(239, 68, 68, 0.1); border-color: var(--danger); color: var(--danger); }
      .btn-restore { background: transparent; color: var(--success); border: 1px solid var(--success); width: 100%; box-shadow: none; }
      .btn-imdb { background: transparent; color: #fff; border: 1px solid var(--card-border); width: 100%; text-decoration: none; padding: 8px; border-radius: 8px; font-size: 0.8em; font-weight: bold; display: flex; align-items: center; justify-content: center; gap: 5px; transition: 0.2s;}
      .btn-imdb:hover { border-color: var(--primary); color: var(--primary); }

      /* MODAL */
      .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); z-index: 1000; display: none; justify-content: center; align-items: center; padding: 20px; backdrop-filter: blur(10px); }
      .modal-content { background: var(--card-bg); width: 90%; max-width: 500px; max-height: 80vh; border-radius: 20px; padding: 0; margin-right: 40px; border: 1px solid var(--card-border); display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0,0,0,0.6); }
      .modal-header { padding: 20px; border-bottom: 1px solid var(--card-border); display: flex; justify-content: space-between; align-items: center; }
      .modal-title { font-size: 1.2em; font-weight: 800; color: #fff; }
      .modal-body { overflow-y: auto; padding: 20px; color: #ccc; font-family: monospace; font-size: 0.9em; line-height: 1.6; }
      .file-item { padding: 8px 0; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 10px; }
      .modal-footer { padding: 20px; border-top: 1px solid var(--card-border); }
      .close-btn { background: #333; color: #fff; width: 100%; padding: 12px; box-shadow: none; }

    </style>
    <script>
      function switchTab(type) {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.getElementById('tab-' + type).classList.add('active');
        document.querySelectorAll('.grid-container').forEach(g => g.classList.remove('active'));
        document.getElementById('grid-' + type).classList.add('active');
      }
      function showDetails(title, filesEncoded) {
        const files = JSON.parse(decodeURIComponent(filesEncoded));
        document.getElementById('modalTitle').textContent = title;
        document.getElementById('modalBody').innerHTML = files.map(f => \`
            <div class="file-item">
                <span class="icon" style="color:#666">description</span>
                <span>\${f}</span>
            </div>\`).join('');
        document.getElementById('infoModal').style.display = 'flex';
      }
      function closeModal() { document.getElementById('infoModal').style.display = 'none'; }
      window.onclick = function(event) { if (event.target == document.getElementById('infoModal')) closeModal(); }
      function filterGrid() {
          const input = document.getElementById('searchInput').value.toLowerCase();
          document.querySelectorAll('.card').forEach(card => {
              card.style.display = card.getAttribute('data-title').toLowerCase().includes(input) ? 'flex' : 'none';
          });
      }
      function confirmDelete() { return confirm("⚠️ CZY NA PEWNO? \\nUsuniesz te pliki fizycznie z RD!"); }
    </script>
  </head>
  <body>
    
    <div id="infoModal" class="modal-overlay">
      <div class="modal-content">
        <div class="modal-header">
            <div id="modalTitle" class="modal-title"></div>
            <button onclick="closeModal()" class="btn-icon-only" style="background:transparent;color:#fff;box-shadow:none"><span class="icon">close</span></button>
        </div>
        <div id="modalBody" class="modal-body"></div>
        <div class="modal-footer">
            <button class="close-btn" onclick="closeModal()">ZAMKNIJ</button>
        </div>
      </div>
    </div>

    <div class="header">
        <img src="/assets/logo.png" alt="RDD MANAGER" style="max-height: 70px; width: auto; margin-bottom: 10px; display: block; margin-left: auto; margin-right: auto;">
        <div class="stats-bar">
             <div class="stat-item"><span class="icon">hard_drive</span> <strong>${formatBytes(stats.totalSize)}</strong></div>
             <div class="stat-item"><span class="icon">movie</span> <strong>${stats.totalFiles}</strong> plików</div>
        </div>
    </div>

    <div class="downloader-card">
        <div class="downloader-header"><span class="icon icon-lg">rocket_launch</span> SZYBKI DOWNLOADER</div>
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
    
    <div class="search-container">
        <span class="icon search-icon">search</span>
        <input type="text" id="searchInput" class="search-input" onkeyup="filterGrid()" placeholder="Szukaj w kolekcji...">
    </div>

    <div style="display:flex; justify-content:center; gap:10px; margin-bottom:20px;">
        <form action="/manager/refresh" method="POST" style="margin:0"><button type="submit" class="refresh-btn"><span class="icon">refresh</span> Odśwież</button></form>
        <a href="/manager?showHidden=${!showHidden}" style="text-decoration:none"><button type="button" class="refresh-btn">
            <span class="icon">${showHidden ? 'visibility_off' : 'delete_sweep'}</span> ${showHidden ? 'Kosz' : 'Kosz'}
        </button></a>
    </div>

    <div class="tabs">
        <div id="tab-series" class="tab active" onclick="switchTab('series')"><span class="icon">tv</span> SERIALE</div>
        <div id="tab-movie" class="tab" onclick="switchTab('movie')"><span class="icon">movie</span> FILMY</div>
    </div>

    ${renderGrid("series", groups, showHidden)}
    ${renderGrid("movie", groups, showHidden)}

  </body>
  </html>
  `;
  res.send(html);
});

function renderGrid(type, groups, showHidden) {
    const isActive = type === "series" ? "active" : "";
    let html = `<div id="grid-${type}" class="grid-container ${isActive}">`;
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

        html += `
          <div class="${cardClass}" data-title="${safeTitle}">
            <div class="poster-area" onclick="showDetails('${safeTitle.replace(/'/g, "\\'")}', '${filesEncoded}')">
                ${posterSrc}
                <div class="badge"><span class="icon" style="font-size:14px">folder</span> ${g.files.length}</div>
                <div class="size-badge">${formatBytes(g.size)}</div>
            </div>
            <div class="content">
              <div class="title" onclick="showDetails('${safeTitle.replace(/'/g, "\\'")}', '${filesEncoded}')">${safeTitle}</div>
              
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

// === DOWNLOADER & API ===
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

app.post("/manager/refresh", async (req, res) => { await syncAllDownloads(); res.redirect("/manager"); });
app.post("/manager/toggle-hide", (req, res) => { const k = req.body.groupKey; if(HIDDEN_GROUPS.has(k)) HIDDEN_GROUPS.delete(k); else HIDDEN_GROUPS.add(k); res.redirect("/manager"); });
app.post("/manager/delete-rd", async (req, res) => {
    const ids = req.body.downloadIds.split(",");
    for (const id of ids) {
        try { await fetch(`https://api.real-debrid.com/rest/1.0/downloads/delete/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${RD_TOKEN}` } }); } catch(e) {}
    }
    await syncAllDownloads(); res.redirect("/manager");
});
app.post("/manager/update-group", async (req, res) => {
  const { groupKey, imdbId } = req.body;
  if (imdbId && imdbId.startsWith("tt")) {
    let meta = await fetchCinemeta(imdbId);
    if (!meta) meta = { id: imdbId, name: "Wymuszono: " + groupKey, poster: null, type: "series" };
    const files = hostersOnly(ALL_DOWNLOADS_CACHE);
    for (const f of files) { if (getNormalizedKey(f.filename) === groupKey) METADATA_CACHE[f.id] = meta; }
  }
  res.redirect("/manager");
});

async function syncAllDownloads() {
  if (isUpdating) return;
  isUpdating = true;
  let page = 1, allItems = [], keepFetching = true;
  try {
    while (keepFetching) {
      const r = await fetch(`https://api.real-debrid.com/rest/1.0/downloads?limit=100&page=${page}`, { headers: { Authorization: `Bearer ${RD_TOKEN}` } });
      if (!r.ok) break;
      const data = await r.json().catch(() => []);
      if (!Array.isArray(data) || data.length === 0) keepFetching = false;
      else { allItems = allItems.concat(data); if (data.length < 100) keepFetching = false; else page++; await new Promise(r => setTimeout(r, 200)); }
    }
    if (allItems.length > 0) ALL_DOWNLOADS_CACHE = allItems;
  } catch (e) { console.error("Sync error:", e.message); } finally { isUpdating = false; }
}

app.get("/manifest.json", (req, res) => {
  res.json({
    id: "community.rd.manager.final",
    version: "1.0.0",
    name: "RD Manager",
    description: "VOD Manager.",
    logo: "https://ds-addon.onrender.com/assets/logo.png",
    resources: ["stream", "catalog"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [{ type: "series", id: "rd_series", name: "Moje Seriale (RD)" }, { type: "movie", id: "rd_movies", name: "Moje Filmy (RD)" }]
  });
});

app.get("/catalog/:type/:id.json", (req, res) => {
  const metas = [];
  const files = hostersOnly(ALL_DOWNLOADS_CACHE);
  const unique = new Set();
  for (const f of files) {
    const key = getNormalizedKey(f.filename);
    if (HIDDEN_GROUPS.has(key)) continue;
    const meta = METADATA_CACHE[f.id];
    if (!meta || !meta.id.startsWith("tt") || meta.type !== req.params.type) continue;
    if (!unique.has(meta.id)) { unique.add(meta.id); metas.push({ id: meta.id, type: meta.type, name: meta.name, poster: meta.poster }); }
  }
  res.json({ metas: metas.slice(0, 100) });
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
      } else {
         streams.push({ name: name, title: title, url: f.download });
      }
    }
  }
  res.json({ streams });
});

app.listen(PORT, "0.0.0.0", () => { console.log("✅ Server running."); syncAllDownloads(); setInterval(syncAllDownloads, 15 * 60 * 1000); });