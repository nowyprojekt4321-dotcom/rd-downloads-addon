import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const app = express();

// === CORS ===
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});

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
  const re = new RegExp(`S0*${s}[^0-9]*E0*${e}`, "i");
  const re2 = new RegExp(`\\b${s}x${e}\\b`, "i");
  return re.test(filename) || re2.test(filename);
}

// Proste wykrywanie typu (jeśli brak metadata)
function detectType(filename) {
    if (/S\d{2}/i.test(filename)) return "series";
    return "movie";
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
  } catch (err) {
    console.error(`⚠️ Błąd sieci Cinemeta:`, err.message);
    return null;
  }
  return null;
}

/* =========================
   MANAGER UI (TABS + POPUP)
========================= */
app.get("/manager", (req, res) => {
  const showHidden = req.query.showHidden === "true"; 
  const files = hostersOnly(ALL_DOWNLOADS_CACHE);
  const groups = {};
  
  for (const f of files) {
    const key = getNormalizedKey(f.filename); 
    const displayTitle = getDisplayTitle(f.filename);

    if (!groups[key]) {
      groups[key] = {
        key: key,
        displayName: displayTitle, 
        files: [],
        assignedId: null,
        poster: null,
        detectedName: null,
        type: detectType(f.filename) // Wstępne zgadywanie
      };
    }
    groups[key].files.push(f);
    
    // Jeśli mamy zapisane metadane, nadpisujemy typ
    if (METADATA_CACHE[f.id]) {
      groups[key].assignedId = METADATA_CACHE[f.id].id;
      groups[key].poster = METADATA_CACHE[f.id].poster;
      groups[key].detectedName = METADATA_CACHE[f.id].name;
      groups[key].type = METADATA_CACHE[f.id].type;
    }
  }

  // HTML START
  let html = `
  <html>
  <head>
    <title>RD Manager Platinum</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0"> 
    <style>
      body { font-family: sans-serif; background: #121212; color: #e0e0e0; margin: 0; padding: 10px; padding-bottom: 50px; }
      
      /* GÓRA */
      .header { text-align: center; margin-bottom: 20px; }
      h1 { margin: 0 0 10px 0; font-size: 1.5em; color: #E2B616; }
      
      .controls { display: flex; justify-content: center; gap: 10px; margin-bottom: 15px; }
      
      /* ZAKŁADKI (TABS) */
      .tabs { display: flex; border-bottom: 2px solid #333; margin-bottom: 20px; }
      .tab { 
        flex: 1; text-align: center; padding: 15px; cursor: pointer; 
        font-weight: bold; background: #1e1e1e; color: #888; transition: 0.3s;
      }
      .tab.active { background: #E2B616; color: #000; }
      
      /* GRID */
      .grid-container {
        display: none; /* Domyślnie ukryte, JS pokaże odpowiedni */
        grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
        gap: 15px;
      }
      .grid-container.active { display: grid; }

      /* KARTA */
      .card {
        background: #1e1e1e; border: 1px solid #333; border-radius: 8px;
        overflow: hidden; display: flex; flex-direction: column; position: relative;
      }
      .card.hidden-item { border: 1px dashed #555; opacity: 0.5; filter: grayscale(100%); }

      .poster-area {
        height: 220px; background: #000; position: relative;
        cursor: pointer; /* Klik w plakat otwiera popup */
      }
      .poster-img { width: 100%; height: 100%; object-fit: cover; }
      .no-poster { 
        width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; 
        color: #555; font-size: 2em; background: #111;
      }
      
      /* Overlay na plakacie (Info) */
      .poster-info-icon {
        position: absolute; top: 5px; right: 5px; 
        background: rgba(0,0,0,0.7); color: #fff; border-radius: 50%; 
        width: 24px; height: 24px; text-align: center; line-height: 24px; font-size: 14px;
      }

      .content { padding: 10px; display: flex; flex-direction: column; gap: 6px; }
      
      .title {
        font-weight: bold; color: #fff; font-size: 0.95em;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      
      .input-row { display: flex; gap: 5px; margin-top: 5px; }
      input { 
        background: #333; color: #fff; border: 1px solid #444; 
        border-radius: 4px; padding: 6px; width: 100%; font-size: 0.85em;
      }

      /* PRZYCISKI */
      button {
        background: #E2B616; color: #000; font-weight: bold; border: none;
        border-radius: 4px; padding: 8px; cursor: pointer; font-size: 0.9em;
      }
      button.secondary { background: #444; color: #fff; }
      
      .btn-hide { background: transparent; color: #666; border: 1px solid #444; width: 100%; padding: 4px; font-size: 0.8em; margin-top: 5px; }
      .btn-unhide { background: #27ae60; color: #fff; width: 100%; padding: 4px; }
      
      .imdb-link { text-decoration: none; color: #E2B616; font-size: 0.85em; display: flex; align-items: center; gap: 4px; }

      /* MODAL (POPUP) */
      .modal-overlay {
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.85); z-index: 1000;
        display: none; justify-content: center; align-items: center; padding: 20px;
      }
      .modal-content {
        background: #222; width: 100%; max-width: 500px; max-height: 80vh;
        border-radius: 12px; padding: 20px; border: 1px solid #E2B616;
        display: flex; flex-direction: column; gap: 15px;
        box-shadow: 0 0 20px rgba(226, 182, 22, 0.2);
      }
      .modal-header { font-size: 1.2em; font-weight: bold; color: #E2B616; border-bottom: 1px solid #444; padding-bottom: 10px; }
      .modal-body { overflow-y: auto; color: #ccc; font-size: 0.9em; line-height: 1.5; }
      .file-item { padding: 5px 0; border-bottom: 1px solid #333; word-break: break-all; }
      .close-btn { background: #E2B616; width: 100%; padding: 12px; margin-top: auto; }

    </style>
    <script>
      // ZAKŁADKI
      function switchTab(type) {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.getElementById('tab-' + type).classList.add('active');
        
        document.querySelectorAll('.grid-container').forEach(g => g.classList.remove('active'));
        document.getElementById('grid-' + type).classList.add('active');
      }

      // MODAL (POPUP)
      function showDetails(title, filesEncoded) {
        const files = JSON.parse(decodeURIComponent(filesEncoded));
        const modal = document.getElementById('infoModal');
        const titleEl = document.getElementById('modalTitle');
        const bodyEl = document.getElementById('modalBody');

        titleEl.textContent = title;
        bodyEl.innerHTML = files.map(f => \`<div class="file-item">📄 \${f}</div>\`).join('');
        
        modal.style.display = 'flex';
      }

      function closeModal() {
        document.getElementById('infoModal').style.display = 'none';
      }
      
      // Zamknij na kliknięcie poza
      window.onclick = function(event) {
        const modal = document.getElementById('infoModal');
        if (event.target == modal) {
          modal.style.display = "none";
        }
      }
    </script>
  </head>
  <body>
    
    <div id="infoModal" class="modal-overlay">
      <div class="modal-content">
        <div id="modalTitle" class="modal-header">Tytuł</div>
        <div id="modalBody" class="modal-body">...</div>
        <button class="close-btn" onclick="closeModal()">ZAMKNIJ</button>
      </div>
    </div>

    <div class="header">
        <h1>🎬 RD Manager</h1>
        <div class="controls">
            <form action="/manager/refresh" method="POST" style="margin:0">
                <button type="submit">🔄 Odśwież</button>
            </form>
            <a href="/manager?showHidden=${!showHidden}">
                <button type="button" class="secondary">${showHidden ? '👁️ Ukryj śmieci' : '👁️ Pokaż ukryte'}</button>
            </a>
        </div>
    </div>
    
    <div class="tabs">
        <div id="tab-series" class="tab active" onclick="switchTab('series')">SERIALE</div>
        <div id="tab-movie" class="tab" onclick="switchTab('movie')">FILMY</div>
    </div>

    ${renderGrid("series", groups, showHidden)}
    ${renderGrid("movie", groups, showHidden)}

  </body>
  </html>
  `;
  
  res.send(html);
});

// Helper do generowania HTML dla konkretnego typu
function renderGrid(type, groups, showHidden) {
    const isActive = type === "series" ? "active" : "";
    let html = `<div id="grid-${type}" class="grid-container ${isActive}">`;
    
    // Filtrowanie i Sortowanie
    const sorted = Object.values(groups)
        .filter(g => g.type === type)
        .sort((a,b) => b.files.length - a.files.length);

    for (const g of sorted) {
        const isHidden = HIDDEN_GROUPS.has(g.key);
        if (isHidden && !showHidden) continue;

        const posterSrc = g.poster ? `<img src="${g.poster}" class="poster-img">` : `<div class="no-poster">?</div>`;
        const currentId = (g.assignedId && g.assignedId.startsWith("tt")) ? g.assignedId : "";
        const searchUrl = `https://www.imdb.com/find?q=${encodeURIComponent(g.displayName)}`;
        const cardClass = isHidden ? "card hidden-item" : "card";
        
        // Przygotowanie danych do Popupa (bezpieczne kodowanie)
        const filesJson = JSON.stringify(g.files.map(f => f.filename));
        const filesEncoded = encodeURIComponent(filesJson);
        const safeTitle = g.detectedName || g.displayName;

        html += `
          <div class="${cardClass}">
            <div class="poster-area" onclick="showDetails('${safeTitle.replace(/'/g, "\\'")}', '${filesEncoded}')">
                ${posterSrc}
                <div class="poster-info-icon">i</div>
            </div>
            
            <div class="content">
              <div class="title" onclick="showDetails('${safeTitle.replace(/'/g, "\\'")}', '${filesEncoded}')">
                ${safeTitle}
              </div>
              
              <a href="${searchUrl}" target="_blank" class="imdb-link">
                🔍 Szukaj ID
              </a>

              <form action="/manager/update-group" method="POST" style="margin:0;">
                <input type="hidden" name="groupKey" value="${g.key}">
                <div class="input-row">
                    <input type="text" name="imdbId" value="${currentId}" placeholder="tt...">
                    <button type="submit">💾</button>
                </div>
              </form>

              <form action="/manager/toggle-hide" method="POST" style="margin:0;">
                <input type="hidden" name="groupKey" value="${g.key}">
                ${isHidden 
                  ? `<button type="submit" class="btn-unhide">PRZYWRÓĆ</button>` 
                  : `<button type="submit" class="btn-hide">UKRYJ</button>`
                }
              </form>
            </div>
          </div>
        `;
    }
    html += `</div>`;
    return html;
}

// LOGIKA API
app.post("/manager/refresh", async (req, res) => {
    await syncAllDownloads();
    res.redirect("/manager");
});

app.post("/manager/toggle-hide", (req, res) => {
    const key = req.body.groupKey;
    if (HIDDEN_GROUPS.has(key)) HIDDEN_GROUPS.delete(key);
    else HIDDEN_GROUPS.add(key);
    res.redirect("/manager");
});

app.post("/manager/update-group", async (req, res) => {
  const { groupKey, imdbId } = req.body;
  if (imdbId && imdbId.startsWith("tt")) {
    let meta = await fetchCinemeta(imdbId);
    if (!meta) {
        meta = { id: imdbId, name: "Wymuszono: " + groupKey, poster: null, type: "series" };
    }
    const files = hostersOnly(ALL_DOWNLOADS_CACHE);
    for (const f of files) {
      if (getNormalizedKey(f.filename) === groupKey) METADATA_CACHE[f.id] = meta;
    }
  }
  res.redirect("/manager");
});

async function syncAllDownloads() {
  if (isUpdating) return;
  isUpdating = true;
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
      if (!Array.isArray(data) || data.length === 0) keepFetching = false;
      else {
        allItems = allItems.concat(data);
        if (data.length < 100) keepFetching = false;
        else page++;
        await new Promise(r => setTimeout(r, 200));
      }
    }
    if (allItems.length > 0) ALL_DOWNLOADS_CACHE = allItems;
  } catch (e) { console.error("Sync error:", e.message); } 
  finally { isUpdating = false; }
}

/* =========================
   MANIFEST & STREMIO
========================= */
app.get("/manifest.json", (req, res) => {
  res.json({
    id: "community.rd.manager.platinum.v3", // Bump version
    version: "3.0.0",
    name: "RD Manager Platinum",
    description: "Ultimate Dashboard.",
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
    if (HIDDEN_GROUPS.has(key)) continue; // Ukrywanie w katalogu

    const meta = METADATA_CACHE[f.id];
    if (!meta || !meta.id.startsWith("tt") || meta.type !== req.params.type) continue;
    if (!unique.has(meta.id)) {
      unique.add(meta.id);
      metas.push({ id: meta.id, type: meta.type, name: meta.name, poster: meta.poster });
    }
  }
  res.json({ metas: metas.slice(0, 100) });
});

function parseSeasonEpisode(id) {
    const p = id.split(":");
    return { baseId: p[0], season: p[1], episode: p[2] };
}

app.get("/stream/:type/:id.json", (req, res) => {
  const { type, id } = req.params;
  const { baseId, season, episode } = parseSeasonEpisode(id);
  const streams = [];
  for (const f of ALL_DOWNLOADS_CACHE) {
    const meta = METADATA_CACHE[f.id];
    if (meta && meta.id === baseId) {
      if (type === "series") {
        if (matchesEpisode(f.filename, season, episode)) streams.push({ name: "MOJE RD", title: f.filename, url: f.download });
      } else {
         streams.push({ name: "MOJE RD", title: f.filename, url: f.download });
      }
    }
  }
  res.json({ streams });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Server running.");
  syncAllDownloads();
  setInterval(syncAllDownloads, 15 * 60 * 1000);
});