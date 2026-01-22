import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const app = express();

// === CORS (Dostęp dla Stremio) ===
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
   CACHE & DATABASE
========================= */
let ALL_DOWNLOADS_CACHE = []; 
let METADATA_CACHE = {}; 
let isUpdating = false;

/* =========================
   HELPERS
========================= */
function deLeet(s) {
  return String(s || "")
    .replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e")
    .replace(/4/g, "a").replace(/5/g, "s").replace(/7/g, "t")
    .replace(/@/g, "a");
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
   METADATA LOGIC (ZABEZPIECZONA)
========================= */
async function fetchCinemeta(idOrName) {
  if (!idOrName.startsWith("tt")) return null;

  try {
    // Próbujemy pobrać dane dla serialu
    let r = await fetch(`https://v3-cinemeta.stremio.com/meta/series/${idOrName}.json`);
    if (r.ok) {
      let j = await r.json();
      if (j?.meta) return { id: j.meta.imdb_id, name: j.meta.name, poster: j.meta.poster, type: "series" };
    }
    
    // Jeśli nie serial, to może film?
    r = await fetch(`https://v3-cinemeta.stremio.com/meta/movie/${idOrName}.json`);
    if (r.ok) {
      let j = await r.json();
      if (j?.meta) return { id: j.meta.imdb_id, name: j.meta.name, poster: j.meta.poster, type: "movie" };
    }
  } catch (err) {
    console.error(`⚠️ Błąd Cinemeta dla ${idOrName}:`, err.message);
    // Zwracamy null, ale NIE CRASHUJEMY serwera
    return null;
  }
  return null;
}

/* =========================
   MANAGER UI
========================= */
app.get("/manager", (req, res) => {
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
    <h1>🎬 Manager v3: Pancerne Fuzzy</h1>
    <p>Teraz błędy sieciowe nie wyłączą wtyczki.</p>
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
          <div class="title">${g.detectedName || g.displayName}</div>
          <div class="files-count">Plików w grupie: <strong>${g.files.length}</strong></div>
          <div class="files-list">${fileListHtml}</div>
        </div>
        <div class="action">
          <form action="/manager/update-group" method="POST">
            <input type="hidden" name="groupKey" value="${g.key}">
            <input type="text" name="imdbId" value="${currentId}" placeholder="np. tt9140554">
            <button type="submit">Zapisz grupę</button>
          </form>
        </div>
      </div>
    `;
  }

  html += `</body></html>`;
  res.send(html);
});

// ZABEZPIECZONY Endpoint aktualizacji
app.post("/manager/update-group", async (req, res) => {
  const { groupKey, imdbId } = req.body;
  
  if (imdbId && imdbId.startsWith("tt")) {
    // Tutaj fetchCinemeta już ma try/catch, więc nie wywali serwera
    const meta = await fetchCinemeta(imdbId);
    
    if (meta) {
      console.log(`📦 [GROUP UPDATE] Sukces! ${meta.name} -> "${groupKey}"`);
      const files = hostersOnly(ALL_DOWNLOADS_CACHE);
      for (const f of files) {
        if (getNormalizedKey(f.filename) === groupKey) {
          METADATA_CACHE[f.id] = meta;
        }
      }
    } else {
      console.log(`⚠️ [GROUP UPDATE] Nie znaleziono danych dla ID: ${imdbId}`);
    }
  }
  // Zawsze przekieruj, nawet jak był błąd
  res.redirect("/manager");
});

/* =========================
   CORE SYNC (PAGINATION)
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
  } catch (e) { console.error("Sync error:", e.message); } 
  finally { isUpdating = false; }
}

/* =========================
   STREMIO ROUTES
========================= */
app.get("/manifest.json", (req, res) => {
  res.json({
    id: "community.rd.smart.manager.v9",
    version: "1.1.3",
    name: "RD Manager (Stable)",
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