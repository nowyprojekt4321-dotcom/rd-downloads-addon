import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const app = express();

// === NAPRAWA: DODANO OBSŁUGĘ CORS ===
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});
// ====================================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3001;
const RD_TOKEN = process.env.RD_TOKEN;

if (!RD_TOKEN) {
  console.error("❌ RD_TOKEN is not set.");
  process.exit(1);
}

/* =========================
   CACHE & DATABASE
========================= */
let ALL_DOWNLOADS_CACHE = []; 
let METADATA_CACHE = {}; 
let isUpdating = false;

/* =========================
   HELPERS
========================= */
function hostersOnly(downloads) {
  return downloads.filter(d => d.streamable === 1 && !d.link.includes("/d/"));
}

// Wyciąga "Nazwę Grupy" z pliku (np. z "Loki.S02E01.mkv" robi "Loki")
function getGroupName(filename) {
  const clean = String(filename || "").replace(/\./g, " ").trim();
  const match = clean.match(/^(.+?)(?=\s+s\d{2})/i); 
  if (match && match[1]) {
    return match[1].trim();
  }
  return clean;
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
  if (idOrName.startsWith("tt")) {
    let r = await fetch(`https://v3-cinemeta.stremio.com/meta/series/${idOrName}.json`);
    let j = await r.json();
    if (j?.meta) return { id: j.meta.imdb_id, name: j.meta.name, poster: j.meta.poster, type: "series" };
    
    r = await fetch(`https://v3-cinemeta.stremio.com/meta/movie/${idOrName}.json`);
    j = await r.json();
    if (j?.meta) return { id: j.meta.imdb_id, name: j.meta.name, poster: j.meta.poster, type: "movie" };
    return null;
  }
  return null;
}

/* =========================
   MANAGER UI (Grupowanie)
========================= */
app.get("/manager", (req, res) => {
  const files = hostersOnly(ALL_DOWNLOADS_CACHE);
  
  // 1. GRUPOWANIE PLIKÓW
  const groups = {};
  
  for (const f of files) {
    const groupName = getGroupName(f.filename);
    if (!groups[groupName]) {
      groups[groupName] = {
        name: groupName,
        files: [],
        assignedId: null,
        poster: null,
        detectedName: null
      };
    }
    groups[groupName].files.push(f);
    
    if (METADATA_CACHE[f.id]) {
      groups[groupName].assignedId = METADATA_CACHE[f.id].id;
      groups[groupName].poster = METADATA_CACHE[f.id].poster;
      groups[groupName].detectedName = METADATA_CACHE[f.id].name;
    }
  }

  // 2. GENEROWANIE HTML
  let html = `
  <html>
  <head>
    <title>RD Smart Manager</title>
    <style>
      body { font-family: sans-serif; background: #121212; color: #e0e0e0; padding: 20px; }
      .group-card { background: #1e1e1e; border: 1px solid #333; margin-bottom: 20px; padding: 15px; border-radius: 8px; display: flex; align-items: center; }
      .poster { width: 60px; height: 90px; object-fit: cover; margin-right: 15px; border-radius: 4px; background: #333; }
      .info { flex-grow: 1; }
      .title { font-size: 1.2em; font-weight: bold; color: #fff; }
      .files-count { font-size: 0.9em; color: #888; margin-top: 5px; }
      .files-list { font-size: 0.8em; color: #666; max-height: 0; overflow: hidden; transition: max-height 0.3s; }
      .group-card:hover .files-list { max-height: 200px; overflow-y: auto; }
      .action { margin-left: 20px; text-align: right; }
      input { background: #333; color: #fff; border: 1px solid #555; padding: 8px; border-radius: 4px; }
      button { background: #6c5ce7; color: white; border: none; padding: 8px 15px; border-radius: 4px; cursor: pointer; font-weight: bold; }
      button:hover { background: #5649c0; }
    </style>
  </head>
  <body>
    <h1>🎬 Twój Inteligentny Manager</h1>
    <p>System automatycznie pogrupował Twoje pliki. Przypisz ID do grupy, a zadziała dla wszystkich odcinków.</p>
  `;

  const sortedGroups = Object.values(groups).sort((a,b) => b.files.length - a.files.length);

  for (const g of sortedGroups) {
    const posterSrc = g.poster || "https://via.placeholder.com/60x90?text=?";
    const currentId = (g.assignedId && g.assignedId.startsWith("tt")) ? g.assignedId : "";
    const fileListHtml = g.files.map(f => `<div>📄 ${f.filename}</div>`).join("");

    html += `
      <div class="group-card">
        <img src="${posterSrc}" class="poster">
        <div class="info">
          <div class="title">${g.detectedName || g.name}</div>
          <div class="files-count">Plików w grupie: <strong>${g.files.length}</strong></div>
          <div class="files-list">${fileListHtml}</div>
        </div>
        <div class="action">
          <form action="/manager/update-group" method="POST">
            <input type="hidden" name="groupName" value="${g.name}">
            <input type="text" name="imdbId" value="${currentId}" placeholder="np. tt9140554">
            <button type="submit">Zapisz dla całej grupy</button>
          </form>
        </div>
      </div>
    `;
  }

  html += `</body></html>`;
  res.send(html);
});

// Endpoint grupowy
app.post("/manager/update-group", async (req, res) => {
  const { groupName, imdbId } = req.body;
  
  if (imdbId && imdbId.startsWith("tt")) {
    const meta = await fetchCinemeta(imdbId);
    if (meta) {
      console.log(`📦 [GROUP UPDATE] Przypisuję ${meta.name} do grupy "${groupName}"`);
      const files = hostersOnly(ALL_DOWNLOADS_CACHE);
      for (const f of files) {
        if (getGroupName(f.filename) === groupName) {
          METADATA_CACHE[f.id] = meta;
        }
      }
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
      if (!Array.isArray(data) || data.length === 0) keepFetching = false;
      else {
        allItems = allItems.concat(data);
        if (data.length < 100) keepFetching = false;
        else page++;
        await new Promise(r => setTimeout(r, 200));
      }
    }
    if (allItems.length > 0) {
      ALL_DOWNLOADS_CACHE = allItems;
    }
  } catch (e) { console.error(e); } 
  finally { isUpdating = false; }
}

/* =========================
   STREMIO ROUTES
========================= */
app.get("/manifest.json", (req, res) => {
  res.json({
    id: "community.rd.smart.manager.v7",
    version: "1.1.1",
    name: "RD Smart Manager",
    description: "Group & Manage your RD files easily.",
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
        if (matchesEpisode(f.filename, season, episode)) {
             streams.push({ name: "MOJE RD", title: f.filename, url: f.download });
        }
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
  console.log(`👉 DASHBOARD: http://127.0.0.1:${PORT}/manager`);
  syncAllDownloads();
  setInterval(syncAllDownloads, 15 * 60 * 1000);
});