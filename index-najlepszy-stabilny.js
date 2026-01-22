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
let HIDDEN_GROUPS = new Set(); // Tu trzymamy ukryte rzeczy
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
   MANAGER UI (MOBILE GRID)
========================= */
app.get("/manager", (req, res) => {
  const showHidden = req.query.showHidden === "true"; // Czy pokazać ukryte?
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
        detectedName: null
      };
    }
    groups[key].files.push(f);
    
    if (METADATA_CACHE[f.id]) {
      groups[key].assignedId = METADATA_CACHE[f.id].id;
      groups[key].poster = METADATA_CACHE[f.id].poster;
      groups[key].detectedName = METADATA_CACHE[f.id].name;
    }
  }

  // HTML START
  let html = `
  <html>
  <head>
    <title>RD Manager</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0"> 
    <style>
      body { font-family: sans-serif; background: #121212; color: #e0e0e0; margin: 0; padding: 10px; }
      
      /* GÓRNY PASEK */
      .header { display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px; align-items: center; }
      h1 { margin: 0; font-size: 1.5em; color: #E2B616; }
      
      .top-buttons { display: flex; gap: 10px; }
      
      /* GRID LAYOUT (KAFELKI) */
      .grid-container {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); /* Responsywne kafelki */
        gap: 15px;
      }

      /* KARTA (KAFELEK) */
      .card {
        background: #1e1e1e;
        border: 1px solid #333;
        border-radius: 8px;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        position: relative;
      }
      
      .card.hidden-item { border: 1px dashed #555; opacity: 0.6; }

      /* OBRAZEK */
      .poster-area {
        height: 220px;
        background: #000;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
      }
      .poster-img { width: 100%; height: 100%; object-fit: cover; }
      .no-poster { color: #555; font-size: 2em; }

      /* TREŚĆ */
      .content { padding: 10px; display: flex; flex-direction: column; gap: 8px; flex-grow: 1; }
      
      /* TYTUŁ (Skrócony) */
      .title {
        font-weight: bold;
        color: #fff;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        cursor: pointer;
      }
      .title.expanded { white-space: normal; } /* Po kliknięciu */

      .subtitle { font-size: 0.8em; color: #888; }

      /* FORMULARZ */
      .input-row { display: flex; gap: 5px; margin-top: auto; }
      input { 
        background: #333; color: #fff; border: 1px solid #444; 
        border-radius: 4px; padding: 6px; width: 100%; font-size: 0.9em;
      }

      /* PRZYCISKI */
      button {
        background: #E2B616; /* TWÓJ KOLOR */
        color: #000;
        font-weight: bold;
        border: none;
        border-radius: 4px;
        padding: 8px;
        cursor: pointer;
        font-size: 0.9em;
      }
      button:hover { background: #c9a313; }

      .btn-small { padding: 4px 8px; font-size: 0.8em; }
      .btn-hide { background: #333; color: #aaa; margin-top: 5px; width: 100%; }
      .btn-unhide { background: #27ae60; color: #fff; margin-top: 5px; width: 100%; }
      
      /* IMDb LINK */
      .imdb-link {
        text-decoration: none;
        color: #E2B616;
        font-size: 0.9em;
        font-weight: bold;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-top: 5px;
      }
    </style>
    <script>
      function toggleTitle(el) {
        el.classList.toggle('expanded');
      }
    </script>
  </head>
  <body>
    <div class="header">
        <h1>🎬 RD Manager</h1>
        <div class="top-buttons">
            <form action="/manager/refresh" method="POST" style="margin:0">
                <button type="submit">🔄 Odśwież</button>
            </form>
            <a href="/manager?showHidden=${!showHidden}">
                <button style="background: #333; color: #fff;">${showHidden ? '👁️ Ukryj śmieci' : '👁️ Pokaż ukryte'}</button>
            </a>
        </div>
    </div>
    
    <div class="grid-container">
  `;

  // Sortowanie: Najpierw te z przypisanym ID, potem reszta wg ilości plików
  const sortedGroups = Object.values(groups).sort((a,b) => b.files.length - a.files.length);

  for (const g of sortedGroups) {
    // FILTROWANIE UKRYTYCH
    const isHidden = HIDDEN_GROUPS.has(g.key);
    if (isHidden && !showHidden) continue; // Pomiń jeśli ukryte i nie chcemy ich widzieć

    const posterSrc = g.poster ? `<img src="${g.poster}" class="poster-img">` : `<div class="no-poster">?</div>`;
    const currentId = (g.assignedId && g.assignedId.startsWith("tt")) ? g.assignedId : "";
    const searchUrl = `https://www.imdb.com/find?q=${encodeURIComponent(g.displayName)}`;
    
    // Klasa CSS dla ukrytego elementu
    const cardClass = isHidden ? "card hidden-item" : "card";

    html += `
      <div class="${cardClass}">
        <div class="poster-area">${posterSrc}</div>
        <div class="content">
          
          <div class="title" onclick="toggleTitle(this)" title="Kliknij, aby zobaczyć całość">
            ${g.detectedName || g.displayName}
          </div>
          
          <div class="subtitle">${g.files.length} plików</div>
          
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
              ? `<button type="submit" class="btn-unhide">Przywróć</button>` 
              : `<button type="submit" class="btn-hide">Ukryj</button>`
            }
          </form>

        </div>
      </div>
    `;
  }
  html += `</div></body></html>`;
  res.send(html);
});

// Endpoint do odświeżania
app.post("/manager/refresh", async (req, res) => {
    await syncAllDownloads();
    res.redirect("/manager");
});

// Endpoint do ukrywania/pokazywania
app.post("/manager/toggle-hide", (req, res) => {
    const key = req.body.groupKey;
    if (HIDDEN_GROUPS.has(key)) {
        HIDDEN_GROUPS.delete(key);
    } else {
        HIDDEN_GROUPS.add(key);
    }
    // Wracamy do widoku (zachowując stan showHidden jeśli był, uproszczone przekierowanie)
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

/* =========================
   CORE SYNC
========================= */
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
   STREMIO ROUTES
========================= */
app.get("/manifest.json", (req, res) => {
  res.json({
    id: "community.rd.mobile.gold.v1",
    version: "2.0.0",
    name: "RD Manager Gold",
    description: "Your files in Golden Grid.",
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
    
    // WAŻNE: Nie pokazuj w katalogu Stremio, jeśli grupa jest ukryta!
    if (HIDDEN_GROUPS.has(key)) continue;

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

/* =========================
   START
========================= */
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Server running.");
  syncAllDownloads();
  setInterval(syncAllDownloads, 15 * 60 * 1000);
});