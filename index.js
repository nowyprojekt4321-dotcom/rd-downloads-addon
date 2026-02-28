import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3001;
const RD_TOKEN = process.env.RD_TOKEN;
const TMDB_KEY = process.env.TMDB_KEY;
const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID;
const TRAKT_USERNAME = process.env.TRAKT_USERNAME;

// Sprawdzenie bezpieczeństwa (opcjonalne, ale dobre dla debugowania)
if (!TRAKT_CLIENT_ID || !TRAKT_USERNAME) {
    console.warn("⚠️ Brak konfiguracji Trakt. Rekomendacje nie będą działać.");
}

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
// 1. WSPÓLNA KOŃCÓWKA DLA WSZYSTKICH (LATA + OCENY)
const COMMON_FILTERS = [
    "--- LATA ---", 
    "Ten rok", "Zeszły rok", "5 lat wstecz", "10 lat wstecz",
    "--- OCENY ---", 
    "Hity (8.0+)", "Dobre (7.0+)", "Reszta (4.5+)"
];

// 2. LISTY DO MENU
const FILTERS_STANDARD = [
    "Akcja", "Komedia", "Horror", "Fanstasy", "Przygodowy", "Sci-fi", "Animowany", "Dokumentalny", "Dramat",
    ...COMMON_FILTERS
];

const FILTERS_HORROR = [
    "Zombie", "Slasher", "Duchy", "Opętania", "Wampiry", "Potwory", "Psychologiczny",
    ...COMMON_FILTERS
];

const FILTERS_ACTION = [
    "Superbohaterowie", "Sztuki Walki", "Wyścigi", "Szpiedzy", "Wojenne", "Cyberpunk",
    ...COMMON_FILTERS
];

const FILTERS_COMEDY = [
    "Czarna Komedia", "Parodia", "Romantyczna", "Szkolna", "Świąteczne",
    ...COMMON_FILTERS
];

const FILTERS_SCIFI = [
    "Kosmos", "Obcy", "Podróże w czasie", "Post-Apo", "Sztuczna Inteligencja", "Cyberpunk",
    ...COMMON_FILTERS
];

// ---> NOWA LISTA DLA ANIMACJI <---
const FILTERS_ANIMATION = [
    "Anime", "Rodzinne", "Dla dorosłych", "Superbohaterowie", "Stop Motion",
    ...COMMON_FILTERS
];

// 3. MAPA SŁÓW KLUCZOWYCH
const KEYWORDS = {
    // HORROR
    "Zombie": "12377", "Slasher": "12339", "Duchy": "9675", "Opętania": "1701", 
    "Wampiry": "3133", "Potwory": "4953", "Psychologiczny": "12565",
    // AKCJA
    "Superbohaterowie": "9748", "Sztuki Walki": "9680", "Wyścigi": "830", 
    "Szpiedzy": "470", "Wojenne": "10705",
    // KOMEDIA
    "Czarna Komedia": "9716", "Parodia": "9714", "Romantyczna": "9799", 
    "Szkolna": "6270", "Świąteczne": "207317",
    // SCI-FI
    "Kosmos": "9882", "Obcy": "9951", "Podróże w czasie": "4387", 
    "Post-Apo": "285366", "Sztuczna Inteligencja": "310", "Cyberpunk": "12190",
    // ANIMACJE
    "Anime": "210024", "Dla dorosłych": "207208", "Stop Motion": "3054"
    // Uwaga: "Rodzinne" jest obsługiwane jako gatunek w getCatalog, a "Superbohaterowie" mają ID wspólne z Akcją
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
   CARD META CACHE (dla nagłówka kafelków w /catalog)
   - Stremio często buduje nagłówek hover z danych katalogu
   - dociągamy runtime/genres/rating tylko dla aktualnej strony (20 szt.)
========================= */
const CARD_META_CACHE = new Map();
const CARD_META_TTL = 24 * 60 * 60 * 1000; // 24h

async function getCardMetaExtras(tmdbId, type) {
  const key = `${type}:${tmdbId}`;
  const now = Date.now();

  const cached = CARD_META_CACHE.get(key);
  if (cached && now - cached.timestamp < CARD_META_TTL) return cached.data;

  const tmdbType = type === "series" ? "tv" : "movie";
  const details = await fetchTMDB(`/${tmdbType}/${tmdbId}`); // pl-PL już jest w fetchTMDB

  if (!details || !details.id) {
    const fallback = { runtime: null, genres: [], imdbRating: null };
    CARD_META_CACHE.set(key, { data: fallback, timestamp: now });
    return fallback;
  }

  // runtime: movie.runtime / tv.episode_run_time[0] -> ZAWSZE "X min"
  let runtime = null;
  if (type === "movie" && typeof details.runtime === "number" && details.runtime > 0) {
    runtime = `${details.runtime} min`;
  } else if (
    type === "series" &&
    Array.isArray(details.episode_run_time) &&
    typeof details.episode_run_time[0] === "number" &&
    details.episode_run_time[0] > 0
  ) {
    runtime = `${details.episode_run_time[0]} min`;
  }

  const genres = Array.isArray(details.genres)
    ? details.genres.map((g) => g?.name).filter(Boolean)
    : [];

  // rating z TMDB (ale wkładamy w imdbRating żeby UI było jak w Cinemeta)
  const imdbRating =
    typeof details.vote_average === "number" && details.vote_average > 0
      ? Math.round(details.vote_average * 10) / 10
      : null;

  const data = { runtime, genres, imdbRating };
  CARD_META_CACHE.set(key, { data, timestamp: now });
  return data;
}

/* =========================
   CATALOG LOGIC (v16.2 FINAL ENGINE: FILTERS + ANIMATION + GENRE FIX)
========================= */
async function getCatalog(catalogId, type, genre, skip = 0) {
    let results = [];
    const regionParams = "&watch_region=PL&region=PL";
    const page = Math.floor(skip / 20) + 1;
    const now = new Date();
    const currentYear = now.getFullYear(); // 2026

    // --- BUDOWANIE PARAMETRÓW FILTROWANIA ---
    let sortParam = "sort_by=primary_release_date.desc"; // Domyślnie najnowsze
    let extraFilters = "&vote_count.gte=50"; // Anty-śmieci

    // OBSŁUGA FILTRÓW Z MENU (GENRE)
    if (genre) {
        // A. SŁOWA KLUCZOWE (ZOMBIE, SLASHER, ANIME ITD.)
        if (KEYWORDS[genre]) {
            extraFilters += `&with_keywords=${KEYWORDS[genre]}`;
        }
        // B. STANDARDOWE GATUNKI (Dodałem "Rodzinne" dla Animacji)
        else if (["Akcja", "Komedia", "Horror", "Sci-fi", "Dramat", "Animowany", "Dokumentalny", "Fanstasy", "Przygodowy", "Rodzinne"].includes(genre)) {
             const genreMap = { 
                "Akcja": "28", "Komedia": "35", "Horror": "27", "Sci-fi": "878", "Dramat": "18", 
                "Animowany": "16", "Kryminał": "80", "Fanstasy": "14", "Przygodowy": "12", 
                "Dokumentalny": "99", "Rodzinne": "10751"
            };
            if (genreMap[genre]) extraFilters += `&with_genres=${genreMap[genre]}`;
        }
        // C. OCENY
        else if (genre === "Hity (8.0+)") extraFilters += `&vote_average.gte=8.0&vote_count.gte=200`;
        else if (genre === "Dobre (7.0+)") extraFilters += `&vote_average.gte=7.0&vote_count.gte=100`;
        else if (genre === "Reszta (4.5+)") extraFilters += `&vote_average.gte=4.5`;
        // D. LATA (MATEMATYKA DAT - BAZA 2026)
        else if (genre === "Ten rok") {
            extraFilters += `&primary_release_year=${currentYear}`;
            extraFilters += `&first_air_date_year=${currentYear}`;
        }
        else if (genre === "Zeszły rok") {
            extraFilters += `&primary_release_year=${currentYear - 1}`;
            extraFilters += `&first_air_date_year=${currentYear - 1}`;
        }
        else if (genre === "5 lat wstecz") {
            const start = currentYear - 6; // 2020
            const end = currentYear - 2;   // 2024
            extraFilters += `&primary_release_date.gte=${start}-01-01&primary_release_date.lte=${end}-12-31`;
            extraFilters += `&first_air_date.gte=${start}-01-01&first_air_date.lte=${end}-12-31`;
        }
        else if (genre === "10 lat wstecz") {
            const start = currentYear - 11; // 2015
            const end = currentYear - 7;    // 2019
            extraFilters += `&primary_release_date.gte=${start}-01-01&primary_release_date.lte=${end}-12-31`;
            extraFilters += `&first_air_date.gte=${start}-01-01&first_air_date.lte=${end}-12-31`;
        }
    }

    // --- 1. SEKCJA PREMIERY (MIX) ---
    if (catalogId === "this_month") {
        if (!genre) {
            const futureDate = new Date(now.getFullYear(), now.getMonth() + 3, 1).toISOString().split('T')[0];
            extraFilters += `&primary_release_date.lte=${futureDate}`; 
        }

        const [movies, series] = await Promise.all([
            fetchTMDB("/discover/movie", `${sortParam}${extraFilters}&page=${page}${regionParams}`),
            fetchTMDB("/discover/tv", `${sortParam.replace('primary_release_date', 'first_air_date')}${extraFilters}&page=${page}${regionParams}`)
        ]);

        if (movies?.results) results.push(...movies.results.map(i => ({...i, media_type: 'movie'})));
        if (series?.results) results.push(...series.results.map(i => ({...i, media_type: 'tv'})));
    } 

    // --- 2. SEKCJA PREMIUM (NETFLIX, DISNEY ITD.) ---
    else if (catalogId.endsWith("_movies") || catalogId.endsWith("_series") || catalogId.endsWith("_new")) {
        let providerId = "8"; // Default Netflix
        if (catalogId.includes("disney")) providerId = "337";
        if (catalogId.includes("amazon")) providerId = "119";
        
        const isMovies = catalogId.includes("_movies") || (catalogId.endsWith("_new") && type === 'movie');
        const isSeries = catalogId.includes("_series") || (catalogId.endsWith("_new") && type === 'series');
        const isMix = catalogId.endsWith("_new"); 

        const requests = [];
        if (isMovies || isMix) {
            requests.push(fetchTMDB("/discover/movie", `with_watch_providers=${providerId}&${sortParam}${extraFilters}&page=${page}${regionParams}`));
        }
        if (isSeries || isMix) {
            requests.push(fetchTMDB("/discover/tv", `with_watch_providers=${providerId}&${sortParam.replace('primary_release_date', 'first_air_date')}${extraFilters}&page=${page}${regionParams}`));
        }

        const responses = await Promise.all(requests);
        responses.forEach(data => {
            if (data?.results) {
                results.push(...data.results.map(i => ({...i, media_type: i.title ? 'movie' : 'tv'})));
            }
        });
    }

    // --- 3. GATUNKI GLOBALNE (Z DEDYKOWANYMI FILTRAMI) ---
    else if (catalogId.startsWith("genre_")) {
        const genreKey = catalogId.replace("genre_", "");
        const baseGenreId = GENRES[genreKey];

        let finalParams = `${sortParam}${extraFilters}&page=${page}${regionParams}`;
        if (!finalParams.includes("with_genres=")) {
            finalParams += `&with_genres=${baseGenreId}`;
        }

        const data = await fetchTMDB(`/discover/movie`, finalParams);
        results = data?.results || [];
        results = results.map(i => ({...i, media_type: 'movie'}));
    }
    
    // --- 4. LEGACY PROVIDERS (BACKUP) ---
    else if (PROVIDERS[catalogId.split("_")[0]]) {
         const [providerName, subType] = catalogId.split("_");
         const providerId = PROVIDERS[providerName];
         const tmdbType = (subType === 'series' || type === 'series') ? 'tv' : 'movie';
         const data = await fetchTMDB(`/discover/${tmdbType}`, `with_watch_providers=${providerId}&sort_by=popularity.desc&page=${page}${regionParams}`);
         results = data?.results || [];
         results = results.map(i => ({...i, media_type: tmdbType}));
    }

    // --- 5. FIX SORTOWANIA (NAJNOWSZE ZAWSZE NA GÓRZE) ---
    results = results.sort((a, b) => {
        const dateA = new Date(a.release_date || a.first_air_date || "1900-01-01");
        const dateB = new Date(b.release_date || b.first_air_date || "1900-01-01");
        return dateB - dateA; 
    });

    // --- MAPOWANIE WYNIKÓW (CLEAN UI v15.8) + NAGŁÓWEK HOVER ---
    const mapped = await Promise.all(results.map(async (item) => {
        const isMovie = item.media_type === 'movie';
        const date = item.release_date || item.first_air_date;
        let name = item.title || item.name;
        let descriptionPrefix = ""; 

        if (catalogId === "this_month" || catalogId.endsWith("_new") || catalogId.endsWith("_movies") || catalogId.endsWith("_series")) {
            const releaseDate = new Date(date);
            const nowTime = new Date(); 
            if (releaseDate > nowTime) {
                name = `${name}`;
                descriptionPrefix = "";
            } else {
                descriptionPrefix = isMovie ? "" : "";
            }
        }

        // >>> DODATEK: runtime/imdbRating/genres do hover header
        const extras = await getCardMetaExtras(item.id, isMovie ? "movie" : "series");

        return {
            id: `tmdb:${item.id}`,
            type: isMovie ? 'movie' : 'series',
            name: name, 
            poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
            description: `${descriptionPrefix}${item.overview || "Brak opisu."}`,
            releaseInfo: formatReleaseDate(date),

            runtime: extras.runtime,
            imdbRating: extras.imdbRating,
            genres: extras.genres
        };
    }));

    return mapped.filter(i => i.poster);
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

function isTorrentOriginLink(link) {
  if (!link || typeof link !== "string") return false;

  try {
    const u = new URL(link);
    // Torrent-pochodne pozycje w RD często mają "oryginalny link" w formie:
    // https://real-debrid.com/d/<TOKEN>
    return u.hostname === "real-debrid.com" && u.pathname.startsWith("/d/");
  } catch (e) {
    // fallback jeśli link nie jest poprawnym URL
    return link.includes("real-debrid.com/d/");
  }
}

function hostersOnly(downloads) {
  // To, co ma trafić do "MOJE ..." z DOWNLOADS:
  // - streamable (żeby działało w Stremio)
  // - ma direct download URL
  // - NIE pochodzi z torrentów (czyli link != real-debrid.com/d/...)
  return (downloads || []).filter(d =>
    d &&
    d.streamable === 1 &&
    typeof d.download === "string" &&
    d.download.startsWith("http") &&
    !isTorrentOriginLink(d.link)
  );
}

function dashboardHostersOnly(downloads) {
  // Dashboard hosters: trzymamy to samo kryterium co w Stremio,
  // żeby nie mieszać torrent-pochodnych pozycji z hosterami.
  return (downloads || []).filter(d =>
    d &&
    d.streamable === 1 &&
    typeof d.download === "string" &&
    d.download.startsWith("http") &&
    !isTorrentOriginLink(d.link)
  );
}

function matchesEpisode(filename, season, episode) {F
  if (!season || !episode) return false;
  const s = Number(season), e = Number(episode);

  // ZMIANA: S[0O]* zamiast S0*
  return new RegExp(`S[0O]*${s}[^0-9]*E0*${e}(?![0-9])`, "i").test(filename)
      || new RegExp(`\\b${s}x${e}\\b`, "i").test(filename);
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

function getBaseUrl(req) {
  const xfProto = req.headers["x-forwarded-proto"];
  const proto = (xfProto ? xfProto.split(",")[0].trim() : req.protocol) || "https";
  return `${proto}://${req.get("host")}`;
}

async function rdUnrestrict(link) {
  const params = new URLSearchParams();
  params.append("link", link);

  const r = await fetch("https://api.real-debrid.com/rest/1.0/unrestrict/link", {
    method: "POST",
    headers: { Authorization: `Bearer ${RD_TOKEN}` },
    body: params
  });

  const data = await r.json().catch(() => null);

  if (!r.ok || !data || !data.download) {
    // zostawiamy debug info w logach serwera
    console.warn("RD unrestrict failed:", r.status, data);
    return null;
  }

  return data.download;
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

function applyCinemetaHeaderOnly(tmdbMeta, cineMeta) {
  if (!tmdbMeta || !cineMeta) return tmdbMeta;

  // Cinemeta: runtime zwykle "45 min" (string) — zostawiamy
  const runtime = cineMeta.runtime || tmdbMeta.runtime;

  // Cinemeta: releaseInfo często "2016–2018" lub "2016-2018"
  const releaseInfo = cineMeta.releaseInfo || tmdbMeta.releaseInfo;

  // rating: Cinemeta ma imdbRating
  const imdbRating = cineMeta.imdbRating ?? tmdbMeta.imdbRating;
  const ratings = cineMeta.ratings || tmdbMeta.ratings;

  return {
    ...tmdbMeta,
    releaseInfo,
    runtime,
    imdbRating,
    ratings,
    genres: translateGenresPL(cineMeta.genres || tmdbMeta.genres)
  };
}

/* =========================
   CINEMETA HEADER CACHE (dla MOJE FILMY / MOJE SERIALE)
   - te katalogi nie mają danych z TMDB listy
   - bierzemy header z Cinemeta: runtime/releaseInfo/imdbRating/genres
========================= */
const CINEMETA_HEADER_CACHE = new Map();
const CINEMETA_HEADER_TTL = 24 * 60 * 60 * 1000; // 24h

async function getCinemetaHeader(imdbId, type) {
  const key = `${type}:${imdbId}`;
  const now = Date.now();

  const cached = CINEMETA_HEADER_CACHE.get(key);
  if (cached && now - cached.timestamp < CINEMETA_HEADER_TTL) return cached.data;

  const metaBase = "https://v3-cinemeta.strem.io";
  try {
    const r = await fetch(`${metaBase}/meta/${type}/${imdbId}.json`);
    if (!r.ok) throw new Error(`Cinemeta ${r.status}`);
    const j = await r.json();
    const m = j?.meta;
    if (!m) throw new Error("No meta");

    // runtime: zostawiamy jak Cinemeta (zwykle "45 min"); jak number -> dopnij " min"
    let runtime = m.runtime ?? null;
    if (typeof runtime === "number") runtime = `${runtime} min`;

    const data = {
      runtime,
      releaseInfo: m.releaseInfo ?? null,
      imdbRating: m.imdbRating ?? null,
      genres: Array.isArray(m.genres) ? m.genres : []
    };

    CINEMETA_HEADER_CACHE.set(key, { data, timestamp: now });
    return data;
  } catch (e) {
    const fallback = { runtime: null, releaseInfo: null, imdbRating: null, genres: [] };
    CINEMETA_HEADER_CACHE.set(key, { data: fallback, timestamp: now });
    return fallback;
  }
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
            // 1. MOJE PLIKI
            { type: "series", id: "rd_series", name: "💎 MOJE SERIALE", extraSupported: ["skip"] }, 
            { type: "movie", id: "rd_movies", name: "💎 MOJE FILMY", extraSupported: ["skip"] },
            
            // 2. PREMIERY & PREMIUM (STANDARDOWE FILTRY)
            { type: "movie", id: "this_month", name: "◢◤PREMIERY", extra: [{ name: "skip" }, { name: "genre", options: FILTERS_STANDARD }] },
            { type: "movie", id: "netflix_movies", name: "◢◤NETFLIX", extra: [{ name: "skip" }, { name: "genre", options: FILTERS_STANDARD }] },
            { type: "series", id: "netflix_series", name: "◢◤NETFLIX", extra: [{ name: "skip" }, { name: "genre", options: FILTERS_STANDARD }] },
            { type: "movie", id: "netflix_new", name: "◢◤NETFLIX | NOWOŚCI", extra: [{ name: "skip" }, { name: "genre", options: FILTERS_STANDARD }] },

            { type: "movie", id: "disney_movies", name: "◢◤DISNEY+", extra: [{ name: "skip" }, { name: "genre", options: FILTERS_STANDARD }] },
            { type: "series", id: "disney_series", name: "◢◤DISNEY+", extra: [{ name: "skip" }, { name: "genre", options: FILTERS_STANDARD }] },
            { type: "movie", id: "disney_new", name: "◢◤DISNEY+ | NOWOŚCI", extra: [{ name: "skip" }, { name: "genre", options: FILTERS_STANDARD }] },

            { type: "movie", id: "amazon_movies", name: "◢◤AMZN PRIME", extra: [{ name: "skip" }, { name: "genre", options: FILTERS_STANDARD }] },
            { type: "series", id: "amazon_series", name: "◢◤AMZN PRIME", extra: [{ name: "skip" }, { name: "genre", options: FILTERS_STANDARD }] },
            { type: "movie", id: "amazon_new", name: "◢◤AMZN PRIME | NOWOŚCI", extra: [{ name: "skip" }, { name: "genre", options: FILTERS_STANDARD }] },

            // 3. GATUNKI SPECJALNE (DEDYKOWANE FILTRY!)
            { type: "movie", id: "genre_horror", name: "HORRORY", extra: [{ name: "skip" }, { name: "genre", options: FILTERS_HORROR }] },
            { type: "movie", id: "genre_comedy", name: "KOMEDIE", extra: [{ name: "skip" }, { name: "genre", options: FILTERS_COMEDY }] },
            { type: "movie", id: "genre_scifi", name: "SCI-FI", extra: [{ name: "skip" }, { name: "genre", options: FILTERS_SCIFI }] },
            { type: "movie", id: "genre_action", name: "AKCJA", extra: [{ name: "skip" }, { name: "genre", options: FILTERS_ACTION }] },
            { type: "movie", id: "genre_animation", name: "ANIMOWANE", extra: [{ name: "skip" }, { name: "genre", options: FILTERS_ANIMATION }] }
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

  // ✅ OBSŁUGA "MOJE PLIKI" (Lokalny Cache) + HEADER
  if (id === "rd_series" || id === "rd_movies") {
    const files = hostersOnly(ALL_DOWNLOADS_CACHE);
    const unique = new Map(); // imdbId -> base meta (z METADATA_CACHE)

    const collect = (item) => {
      const key = getNormalizedKey(item.filename);
      if (HIDDEN_GROUPS.has(key)) return;

      const meta = METADATA_CACHE[item.id];
      if (!meta || !meta.id?.startsWith("tt") || meta.type !== type) return;

      if (!unique.has(meta.id)) {
        unique.set(meta.id, { id: meta.id, type: meta.type, name: meta.name, poster: meta.poster });
      }
    };

    files.forEach(collect);
    ALL_TORRENTS_CACHE.filter((t) => t.status === "downloaded").forEach(collect);

    // dociągnij header z Cinemeta (z cache) dla unikalnych pozycji
    const metas = await Promise.all(
      [...unique.values()].map(async (m) => {
        const header = await getCinemetaHeader(m.id, m.type);

        return {
          ...m,
          releaseInfo: header.releaseInfo || undefined,
          runtime: header.runtime || undefined,
          imdbRating: header.imdbRating ?? undefined,
          genres: header.genres || undefined
        };
      })
    );

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

  // 1) DOWNLOADS — unrestrictujemy po ORYGINALNYM linku (f.link), a nie po f.download
    for (const f of ALL_DOWNLOADS_CACHE) {
    const meta = METADATA_CACHE[f.id];
    if (!meta) continue;

    if (!(meta.id === baseId || meta.tmdb_id === baseId.replace("tmdb:", ""))) continue;

    const smartInfo = getStreamInfo(f.filename, f.filesize);
    const title = `${f.filename}\n${smartInfo}`;
    const name = "💎 MOJE RD";

    if (type === "series") {
        if (!matchesEpisode(f.filename, season, episode)) continue;
    }

    // RD unrestrict najlepiej działa na f.link (oryginalny hoster / google drive / itd.)
    // f.download to często już CDN RD i API może to odrzucać.
    const candidate = (typeof f.link === "string" && f.link.startsWith("http"))
        ? f.link
        : f.download;

    let direct = null;

    if (candidate) {
        direct = await rdUnrestrict(candidate);
    }

    // Fallback: gdyby RD jednak nie przyjął f.link, spróbuj f.download
    if (!direct && candidate !== f.download && typeof f.download === "string") {
        direct = await rdUnrestrict(f.download);
    }

    // Ostateczny fallback: jeśli nadal brak, spróbuj puścić surowy download (czasem działa)
    if (!direct && typeof f.download === "string") {
        direct = f.download;
    }

    if (direct) {
        streams.push({ name, title, url: direct });
    }
    }

  // 2) TORRENTY — ZAWSZE DIRECT z RD (TAK JAK DOWNLOADS)
  for (const t of ALL_TORRENTS_CACHE) {
    if (t.status !== "downloaded") continue;

    const meta = METADATA_CACHE[t.id];
    if (!meta) continue;

    if (!(meta.id === baseId || meta.tmdb_id === baseId.replace("tmdb:", ""))) continue;
    if (!t.files || !t.links) continue;

    // UWAGA: t.files to "selected files", ale t.links z RD może mieć inną kolejność
    // Najbezpieczniej iterować po indexie t.links i brać t.files[index] jeśli istnieje
    for (let index = 0; index < t.links.length; index++) {
      const file = t.files[index];
      if (!file) continue;

      const match = (type === "series")
        ? matchesEpisode(file.path, season, episode)
        : true;
      if (!match) continue;

      const filename = path.basename(file.path);
      const title = `[TORRENT] ${filename}\n${getStreamInfo(file.path, file.bytes)}`;

      const direct = await rdUnrestrict(t.links[index]);
      if (direct) {
        streams.push({
          name: "💎 CHMURA",
          title,
          url: direct
        });
      }
    }
  }

  return res.json({ streams });
});

app.listen(PORT, "0.0.0.0", () => { console.log("✅ RDD ULTIMATE v15.0 (New Engine) RUNNING"); syncAllDownloads(); setInterval(syncAllDownloads, 15 * 60 * 1000); });