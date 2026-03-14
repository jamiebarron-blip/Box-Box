'use strict';

/* ============================================================
   F1 TRACKER — app.js
   Data source: OpenF1 API  (https://openf1.org)
   ============================================================ */

const API = 'https://api.openf1.org/v1';
const JOLPICA_API = 'https://api.jolpi.ca/ergast/f1';
const cache = new Map();

/* ─── SERVICE WORKER ─────────────────────────────────────── */
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
}

/* ─── LOCALSTORAGE CACHE ─────────────────────────────────── */
const LS_PREFIX  = 'f1_';
const TTL_4H     = 4  * 60 * 60 * 1000;
const TTL_24H    = 24 * 60 * 60 * 1000;
const NO_LS_ENDPOINTS = ['position', 'laps']; // use IndexedDB instead

/* ─── INDEXEDDB FOR LARGE DATA ───────────────────────────── */
const IDB_NAME = 'f1_cache';
const IDB_STORE = 'responses';
let _idb = null;

function openIDB() {
    if (_idb) return Promise.resolve(_idb);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
        req.onsuccess = () => { _idb = req.result; resolve(_idb); };
        req.onerror = () => reject(req.error);
    });
}

async function idbGet(key) {
    try {
        const db = await openIDB();
        return new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(key);
            req.onsuccess = () => {
                const row = req.result;
                if (!row) return resolve(null);
                if (row.expires && Date.now() > row.expires) return resolve(null);
                resolve(row.data);
            };
            req.onerror = () => resolve(null);
        });
    } catch { return null; }
}

async function idbSet(key, data, ttlMs) {
    try {
        const db = await openIDB();
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put({ data, expires: ttlMs ? Date.now() + ttlMs : null }, key);
    } catch { /* silently ignore */ }
}

function lsGet(key) {
    try {
        const raw = localStorage.getItem(LS_PREFIX + key);
        if (!raw) return null;
        const { data, expires } = JSON.parse(raw);
        if (expires && Date.now() > expires) { localStorage.removeItem(LS_PREFIX + key); return null; }
        return data;
    } catch { return null; }
}
function lsSet(key, data, ttlMs) {
    try {
        localStorage.setItem(LS_PREFIX + key, JSON.stringify({ data, expires: ttlMs ? Date.now() + ttlMs : null }));
    } catch { /* storage full — silently ignore */ }
}

/* ─── FAVOURITE DRIVER ───────────────────────────────────── */
function toggleFavDriver(e, driverNum) {
    e.stopPropagation();
    const num = String(driverNum);
    favDriver = (favDriver === num) ? null : num;
    if (favDriver) {
        localStorage.setItem('f1_fav_driver', favDriver);
    } else {
        localStorage.removeItem('f1_fav_driver');
    }
    /* Update all rendered rows without a full re-render */
    document.querySelectorAll('tr[data-drv]').forEach(tr => {
        const isFav = tr.dataset.drv === favDriver;
        tr.classList.toggle('fav-driver-row', isFav);
        const btn = tr.querySelector('.fav-star-btn');
        if (btn) btn.textContent = isFav ? '★' : '☆';
    });
}

/* ─── STATE ─────────────────────────────────────────────── */
let currentYear       = 2025;
let currentView       = 'calendar';   // 'calendar' | 'weekend' | 'session'
let currentMeeting    = null;
let currentSession    = null;
let currentTimezone   = 'auto';       // 'auto' = browser timezone
let countdownInterval = null;
let cdSessions        = [];   // upcoming sessions for countdown pills
let cdCurrentIdx      = 0;
let favDriver         = localStorage.getItem('f1_fav_driver') || null; // persisted driver_number
let calendarTab       = 'results';    // 'results' | 'upcoming' — persisted per session
let _skipHashUpdate   = false; // prevent recursive hash ↔ nav loops

/* ─── HASH ROUTING ──────────────────────────────────────── */
function updateHash(hash) {
    if (_skipHashUpdate) return;
    const target = hash || '';
    if (location.hash.replace(/^#/, '') !== target) {
        history.pushState(null, '', '#' + target);
    }
}

function routeFromHash() {
    const h = location.hash.replace(/^#/, '');
    if (!h) { navCalendar(); return; }
    const parts = h.split('/');
    const route = parts[0];

    if (route === 'session' && parts[1] && parts[2]) {
        const meetingKey  = parseInt(parts[1]);
        const sessionKey  = parseInt(parts[2]);
        if (parts[3]) { currentYear = parseInt(parts[3]); document.getElementById('currentYearDisplay').textContent = currentYear; }
        navSession(sessionKey, meetingKey);
    } else if (route === 'weekend' && parts[1]) {
        const meetingKey = parseInt(parts[1]);
        if (parts[2]) { currentYear = parseInt(parts[2]); document.getElementById('currentYearDisplay').textContent = currentYear; }
        navWeekend(meetingKey);
    } else if (route === 'standings') {
        if (parts[1]) { currentYear = parseInt(parts[1]); document.getElementById('currentYearDisplay').textContent = currentYear; }
        navStandings();
    } else if (route === 'ratings') {
        if (parts[1]) { currentYear = parseInt(parts[1]); document.getElementById('currentYearDisplay').textContent = currentYear; }
        navRatings();
    } else if (route === 'game') {
        navGame();
    } else {
        navCalendar();
    }
}

window.addEventListener('hashchange', () => {
    _skipHashUpdate = true;
    routeFromHash();
    _skipHashUpdate = false;
});

/* ─── CONSTANTS ─────────────────────────────────────────── */
const COUNTRY_FLAGS = {
    AUS:'🇦🇺', BHR:'🇧🇭', SAU:'🇸🇦', JPN:'🇯🇵', CHN:'🇨🇳',
    USA:'🇺🇸', ITA:'🇮🇹', MON:'🇲🇨', CAN:'🇨🇦', ESP:'🇪🇸',
    AUT:'🇦🇹', GBR:'🇬🇧', HUN:'🇭🇺', BEL:'🇧🇪', NLD:'🇳🇱',
    SGP:'🇸🇬', AZE:'🇦🇿', MEX:'🇲🇽', BRA:'🇧🇷', ARE:'🇦🇪',
    QAT:'🇶🇦', MAR:'🇲🇦', ARG:'🇦🇷', PRT:'🇵🇹', FRA:'🇫🇷',
    DEU:'🇩🇪', ZAF:'🇿🇦', KOR:'🇰🇷', NZL:'🇳🇿', IND:'🇮🇳',
    LAS:'🇦🇪', MIA:'🇺🇸', BAK:'🇦🇿',
};

const TYRE_LETTER = { SOFT:'S', MEDIUM:'M', HARD:'H', INTERMEDIATE:'I', WET:'W', UNKNOWN:'' };

const CONSTRUCTOR_COLORS = {
    'red_bull':'#3671C6','ferrari':'#E8002D','mercedes':'#27F4D2',
    'mclaren':'#FF8000','aston_martin':'#229971','alpine':'#FF87BC',
    'haas':'#B6BABD','williams':'#64C4FF','rb':'#6692FF',
    'racing_bulls':'#6692FF','kick_sauber':'#52E252','sauber':'#52E252',
    'cadillac':'#C4162A',
};

const NATIONALITY_FLAGS = {
    'Dutch':'🇳🇱','British':'🇬🇧','Monegasque':'🇲🇨','Spanish':'🇪🇸',
    'Australian':'🇦🇺','Mexican':'🇲🇽','German':'🇩🇪','French':'🇫🇷',
    'Canadian':'🇨🇦','Japanese':'🇯🇵','Finnish':'🇫🇮','Chinese':'🇨🇳',
    'Danish':'🇩🇰','Thai':'🇹🇭','American':'🇺🇸','Brazilian':'🇧🇷',
    'Argentinian':'🇦🇷','Italian':'🇮🇹','New Zealander':'🇳🇿',
    'Austrian':'🇦🇹','Belgian':'🇧🇪','Polish':'🇵🇱','Portuguese':'🇵🇹',
    'Swiss':'🇨🇭',
};

/* ─── CIRCUIT DATA ───────────────────────────────────────── */
// Keyed by meeting.location (city/venue name from OpenF1)
const CIRCUIT_DATA = {
    'Melbourne':          { name:'Albert Park Circuit',              length:5.278, laps:58, record:'1:20.235', recordBy:'Leclerc (2022)' },
    'Shanghai':           { name:'Shanghai International Circuit',   length:5.451, laps:56, record:'1:32.238', recordBy:'Schumacher (2004)' },
    'Sakhir':             { name:'Bahrain International Circuit',    length:5.412, laps:57, record:'1:31.447', recordBy:'de la Rosa (2005)' },
    'Jeddah':             { name:'Jeddah Corniche Circuit',          length:6.174, laps:50, record:'1:30.734', recordBy:'Hamilton (2021)' },
    'Suzuka':             { name:'Suzuka Circuit',                   length:5.807, laps:53, record:'1:30.983', recordBy:'Hamilton (2019)' },
    'Miami':              { name:'Miami International Autodrome',    length:5.412, laps:57, record:'1:29.708', recordBy:'Verstappen (2023)' },
    'Miami Gardens':      { name:'Miami International Autodrome',    length:5.412, laps:57, record:'1:29.708', recordBy:'Verstappen (2023)' },
    'Imola':              { name:'Autodromo Enzo e Dino Ferrari',    length:4.909, laps:63, record:'1:15.484', recordBy:'Bottas (2020)' },
    'Monaco':             { name:'Circuit de Monaco',                length:3.337, laps:78, record:'1:10.166', recordBy:'Hamilton (2021)' },
    'Barcelona':          { name:'Circuit de Barcelona-Catalunya',   length:4.657, laps:66, record:'1:18.149', recordBy:'Verstappen (2023)' },
    'Montreal':           { name:'Circuit Gilles-Villeneuve',        length:4.361, laps:70, record:'1:13.078', recordBy:'Bottas (2019)' },
    'Montréal':           { name:'Circuit Gilles-Villeneuve',        length:4.361, laps:70, record:'1:13.078', recordBy:'Bottas (2019)' },
    'Spielberg':          { name:'Red Bull Ring',                    length:4.318, laps:71, record:'1:05.619', recordBy:'Sainz (2020)' },
    'Silverstone':        { name:'Silverstone Circuit',              length:5.891, laps:52, record:'1:27.097', recordBy:'Verstappen (2020)' },
    'Budapest':           { name:'Hungaroring',                      length:4.381, laps:70, record:'1:16.627', recordBy:'Hamilton (2020)' },
    'Spa-Francorchamps':  { name:'Circuit de Spa-Francorchamps',     length:7.004, laps:44, record:'1:46.286', recordBy:'Bottas (2018)' },
    'Zandvoort':          { name:'Circuit Zandvoort',                length:4.259, laps:72, record:'1:11.097', recordBy:'Verstappen (2023)' },
    'Monza':              { name:'Autodromo Nazionale di Monza',     length:5.793, laps:53, record:'1:21.046', recordBy:'Barrichello (2004)' },
    'Baku':               { name:'Baku City Circuit',                length:6.003, laps:51, record:'1:43.009', recordBy:'Perez (2023)' },
    'Singapore':          { name:'Marina Bay Street Circuit',        length:5.063, laps:62, record:'1:35.867', recordBy:'Perez (2023)' },
    'Marina Bay':         { name:'Marina Bay Street Circuit',        length:5.063, laps:62, record:'1:35.867', recordBy:'Perez (2023)' },
    'Austin':             { name:'Circuit of the Americas',          length:5.513, laps:56, record:'1:36.169', recordBy:'Verstappen (2023)' },
    'Mexico City':        { name:'Autodromo Hermanos Rodriguez',     length:4.304, laps:71, record:'1:17.774', recordBy:'Bottas (2021)' },
    'São Paulo':          { name:'Autodromo Jose Carlos Pace',       length:4.309, laps:71, record:'1:11.044', recordBy:'Bottas (2018)' },
    'Sao Paulo':          { name:'Autodromo Jose Carlos Pace',       length:4.309, laps:71, record:'1:11.044', recordBy:'Bottas (2018)' },
    'Las Vegas':          { name:'Las Vegas Strip Circuit',          length:6.201, laps:50, record:'1:35.490', recordBy:'Sainz (2023)' },
    'Lusail':             { name:'Lusail International Circuit',     length:5.380, laps:57, record:'1:24.319', recordBy:'Verstappen (2023)' },
    'Yas Island':         { name:'Yas Marina Circuit',               length:5.281, laps:58, record:'1:26.103', recordBy:'Verstappen (2021)' },
};

/* ─── API ────────────────────────────────────────────────── */
async function apiFetch(endpoint, params = {}) {
    const qs  = new URLSearchParams(params).toString();
    const url = `${API}/${endpoint}${qs ? '?' + qs : ''}`;

    if (cache.has(url)) return cache.get(url);

    const useLs = !NO_LS_ENDPOINTS.includes(endpoint);
    const useIdb = NO_LS_ENDPOINTS.includes(endpoint);

    /* Check localStorage or IndexedDB */
    if (useLs) {
        const cached = lsGet(url);
        if (cached) { cache.set(url, cached); return cached; }
    } else if (useIdb) {
        const cached = await idbGet(url);
        if (cached) { cache.set(url, cached); return cached; }
    }

    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await fetch(url);
            if (res.status === 429 && attempt < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                continue;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            cache.set(url, data);
            const thisYear = new Date().getFullYear();
            const yr = parseInt(params.year) || thisYear;
            const ttl = yr < thisYear ? null : TTL_4H;
            if (useLs) {
                lsSet(url, data, ttl);
            } else if (useIdb) {
                idbSet(url, data, ttl);
            }
            return data;
        } catch (e) {
            console.error(`[F1 API] ${endpoint}:`, e.message);
            return [];
        }
    }
    return [];
}

async function jolpicaFetch(path) {
    const cacheKey = 'jolpica_' + path;
    const cached = lsGet(cacheKey);
    if (cached) return cached;
    try {
        const res = await fetch(`${JOLPICA_API}/${path}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const thisYear = new Date().getFullYear();
        const yrMatch = path.match(/^(\d{4})/);
        const yr = yrMatch ? parseInt(yrMatch[1]) : thisYear;
        lsSet(cacheKey, data, yr < thisYear ? null : TTL_4H);
        return data;
    } catch (e) {
        console.error(`[Jolpica] ${path}:`, e.message);
        return null;
    }
}

const getMeetings    = year        => apiFetch('meetings',      { year });
const getSessions    = meetingKey  => apiFetch('sessions',      { meeting_key: meetingKey });
const getDrivers     = sessionKey  => apiFetch('drivers',       { session_key: sessionKey });
const getPositions   = sessionKey  => apiFetch('position',      { session_key: sessionKey });
const getLaps        = sessionKey  => apiFetch('laps',          { session_key: sessionKey });
const getStints      = sessionKey  => apiFetch('stints',        { session_key: sessionKey });
const getRaceControl = sessionKey  => apiFetch('race_control',  { session_key: sessionKey });
const getPits        = sessionKey  => apiFetch('pit',           { session_key: sessionKey });
const getWeather     = sessionKey  => apiFetch('weather',       { session_key: sessionKey });

/* ─── HELPERS ────────────────────────────────────────────── */
function fmtLap(sec) {
    if (!sec || isNaN(sec)) return null;
    const m = Math.floor(sec / 60);
    const s = (sec % 60).toFixed(3).padStart(6, '0');
    return m > 0 ? `${m}:${s}` : `${sec.toFixed(3)}`;
}

function fmtGap(sec) {
    if (sec === 0) return null;   // leader — show dash elsewhere
    if (!sec || isNaN(sec)) return null;
    return `+${sec.toFixed(3)}`;
}

function fmtDate(str) {
    if (!str) return '';
    return new Date(str).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
}

function fmtDateRange(start, end) {
    const s = new Date(start), e = new Date(end);
    const o = { day:'numeric', month:'short' };
    if (s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear()) {
        return `${s.getDate()}–${e.toLocaleDateString('en-GB', o)} ${s.getFullYear()}`;
    }
    return `${s.toLocaleDateString('en-GB', o)} – ${e.toLocaleDateString('en-GB', o)} ${e.getFullYear()}`;
}

function flag(code) { return COUNTRY_FLAGS[(code || '').toUpperCase()] || '🏁'; }

function teamColor(raw) {
    if (!raw) return '#666666';
    return raw.startsWith('#') ? raw : `#${raw}`;
}

function sessionBadgeClass(type, name) {
    const t = (type || name || '').toLowerCase();
    if (t === 'race')                                    return 'badge-race';
    if (t === 'sprint' && !t.includes('quali'))          return 'badge-sprint';
    if (t.includes('quali') || t.includes('shootout'))   return 'badge-qualifying';
    return 'badge-practice';
}

function sessionCompleted(session) {
    return new Date(session.date_end) < new Date();
}

function meetingStatus(meeting) {
    const now = new Date();
    const end = new Date(meeting.date_end);
    const start = new Date(meeting.date_start);
    if (end < now)              return 'completed';
    if (start <= now)           return 'live';
    return 'upcoming';
}

function nextRaceIdx(meetings) {
    const now = new Date();
    for (let i = 0; i < meetings.length; i++) {
        if (new Date(meetings[i].date_end) >= now) return i;
    }
    return -1;
}

function hasSprint(sessions) {
    return sessions && sessions.some(s => {
        const t = (s.session_type || s.session_name || '').toLowerCase();
        return t === 'sprint' || t.includes('sprint qualifying') || t.includes('sprint shootout');
    });
}

function penaltiesFor(raceControl, driverNum) {
    return (raceControl || []).filter(rc => {
        if (!rc.message) return false;
        const msg = rc.message;

        // Only show confirmed penalties (not just investigations or notes)
        const isPenalty = /\bPENALTY\b|DRIVE.?THROUGH|STOP.?AND.?GO|REPRIMAND/i.test(msg)
                       && /FIA STEWARDS/i.test(msg);
        if (!isPenalty) return false;

        // The API always sets driver_number = null for stewards messages.
        // The driver number appears in the message text as "CAR XX" or "CAR XX (ABC)".
        const carMatches = [...msg.matchAll(/\bCAR\s+(\d+)/gi)];
        const numsInMsg  = carMatches.map(m => parseInt(m[1], 10));

        // Also check the driver_number field in case the API ever populates it
        const fieldMatch = rc.driver_number !== null && parseInt(rc.driver_number, 10) === driverNum;

        return numsInMsg.includes(driverNum) || fieldMatch;
    });
}

/* ─── TIMEZONE HELPERS ───────────────────────────────────── */
function resolvedTz() {
    return currentTimezone === 'auto'
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : currentTimezone;
}

function fmtTimeTz(dateStr, tz) {
    try {
        return new Date(dateStr).toLocaleTimeString('en-GB', {
            hour: '2-digit', minute: '2-digit', timeZone: tz
        });
    } catch (e) { return '??:??'; }
}

function tzShort(tz, date) {
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, timeZoneName: 'short'
        }).formatToParts(date || new Date());
        return parts.find(p => p.type === 'timeZoneName')?.value || tz.split('/').pop();
    } catch (e) { return tz.split('/').pop(); }
}

/* Convert an ISO date + gmt_offset (e.g. "+08:00") to the local circuit time "HH:MM" */
function circuitLocalTime(dateStr, gmtOffset) {
    if (!gmtOffset) return null;
    try {
        const sign = gmtOffset[0] === '-' ? -1 : 1;
        const [h, m] = gmtOffset.replace(/^[+-]/, '').split(':').map(Number);
        const offsetMs = sign * (h * 60 + (m || 0)) * 60000;
        const utcMs    = new Date(dateStr).getTime();
        const local    = new Date(utcMs + offsetMs);
        const hh = String(local.getUTCHours()).padStart(2, '0');
        const mm = String(local.getUTCMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
    } catch (e) { return null; }
}

function renderTyres(stints) {
    if (!stints || stints.length === 0) return '<span class="no-val">—</span>';
    return `<div class="tyre-strat">${stints.map(s => {
        const c   = (s.compound || 'UNKNOWN').toUpperCase();
        const ltr = TYRE_LETTER[c] || '?';
        const lps = s.lap_end && s.lap_start ? s.lap_end - s.lap_start : '';
        return `<span class="tyre-dot tyre-${c}" title="${c} · laps ${s.lap_start || '?'}–${s.lap_end || '?'}">${ltr}</span>`
             + (lps ? `<span class="tyre-laps">${lps}L</span>` : '');
    }).join('')}</div>`;
}

function renderPits(pits) {
    if (!pits || pits.length === 0) return '<span class="no-val">—</span>';
    const sorted = [...pits].sort((a, b) => a.lap_number - b.lap_number);
    return `<div class="pit-list">${sorted.map(p => {
        const dur = p.pit_duration != null ? `<span class="pit-dur"> · ${p.pit_duration.toFixed(1)}s</span>` : '';
        return `<span class="pit-stop">L${p.lap_number}${dur}</span>`;
    }).join('')}</div>`;
}

const _weatherCache = new Map();

function renderWeather(weather) {
    if (!weather || weather.length === 0) return '';

    /* Memoize — same weather array reference = same result */
    if (_weatherCache.has(weather)) return _weatherCache.get(weather);

    const vals = key => weather.map(w => w[key]).filter(v => v != null && !isNaN(v));
    const avg  = key => { const v = vals(key); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const minv = key => { const v = vals(key); return v.length ? Math.min(...v) : null; };
    const maxv = key => { const v = vals(key); return v.length ? Math.max(...v) : null; };

    const airMin  = minv('air_temperature'),   airMax  = maxv('air_temperature');
    const trkMin  = minv('track_temperature'), trkMax  = maxv('track_temperature');
    const humidity  = avg('humidity');
    const windSpeed = avg('wind_speed');
    const isWet     = weather.some(w => w.rainfall > 0);

    const tempRange = (mn, mx) => {
        if (mn == null) return null;
        return mn === mx ? `${Math.round(mn)}°C` : `${Math.round(mn)}–${Math.round(mx)}°C`;
    };

    const items = [
        airMin  != null ? `🌡️ <b>${tempRange(airMin, airMax)}</b> <span>air</span>`   : null,
        trkMin  != null ? `🛣️ <b>${tempRange(trkMin, trkMax)}</b> <span>track</span>` : null,
        humidity  != null ? `💧 <b>${Math.round(humidity)}%</b> <span>humidity</span>` : null,
        windSpeed != null ? `💨 <b>${windSpeed.toFixed(1)} m/s</b>`                    : null,
        isWet ? `<span class="weather-wet">🌧️ Wet</span>` : `<span class="weather-dry">☀️ Dry</span>`,
    ].filter(Boolean).map(i => `<span class="weather-item">${i}</span>`).join('');

    const html = `<div class="weather-bar">${items}</div>`;
    _weatherCache.set(weather, html);
    return html;
}

/* ─── POSITION CHART ─────────────────────────────────────── */
function buildChartData(laps) {
    // Build per-driver lap completion times: dnum -> { lapNum -> endMs }
    const driverLapTimes = {};
    (laps || []).forEach(l => {
        if (!l.lap_number || l.lap_number === 1 || !l.lap_duration || l.lap_duration <= 0 || !l.date_start) return;
        const k = String(l.driver_number);
        if (!driverLapTimes[k]) driverLapTimes[k] = {};
        driverLapTimes[k][l.lap_number] = new Date(l.date_start).getTime() + l.lap_duration * 1000;
    });

    const allDrivers = Object.keys(driverLapTimes);
    if (!allDrivers.length) return { driverLapPos: {}, maxLap: 0 };

    let maxLap = 0;
    allDrivers.forEach(dnum => {
        const ns = Object.keys(driverLapTimes[dnum]).map(Number);
        maxLap = Math.max(maxLap, ...ns);
    });

    // For each lap, determine running order from actual lap completion times.
    // More laps completed = higher position; ties broken by who crossed the line first.
    // A driver's chart point is only drawn for laps they actually completed.
    const driverLapPos = {};

    for (let lapNum = 1; lapNum <= maxLap; lapNum++) {
        const entries = [];
        allDrivers.forEach(dnum => {
            const lapMap = driverLapTimes[dnum];
            const lapNums = Object.keys(lapMap).map(Number);
            const done = lapNums.filter(l => l <= lapNum);
            if (!done.length) return;
            const mostRecent = Math.max(...done);
            entries.push({ dnum, lapsCompleted: mostRecent, endMs: lapMap[mostRecent] });
        });

        // Sort: more laps first; same laps → earlier finish time = better position
        entries.sort((a, b) =>
            b.lapsCompleted !== a.lapsCompleted
                ? b.lapsCompleted - a.lapsCompleted
                : a.endMs - b.endMs
        );

        entries.forEach((e, i) => {
            // Only plot a point if the driver actually completed this exact lap
            if (driverLapTimes[e.dnum][lapNum] !== undefined) {
                if (!driverLapPos[e.dnum]) driverLapPos[e.dnum] = {};
                driverLapPos[e.dnum][lapNum] = i + 1;
            }
        });
    }

    return { driverLapPos, maxLap };
}

function renderPositionChart(laps, drivers) {
    if (!laps || laps.length < 10) return '';
    const { driverLapPos, maxLap } = buildChartData(laps);
    if (maxLap < 3) return '';

    const driverNums = Object.keys(driverLapPos).filter(k => Object.keys(driverLapPos[k]).length >= 3);
    if (!driverNums.length) return '';

    // SVG coordinate system
    const VW = 900, VH = 300;
    const mL = 30, mR = 82, mT = 12, mB = 26;
    const cW = VW - mL - mR;
    const cH = VH - mT - mB;
    // Scale to actual field size (22 cars in 2026, 20 in prior years)
    const maxPos = Math.max(driverNums.length, 20);
    const xOf = l => mL + (l - 1) / Math.max(maxLap - 1, 1) * cW;
    const yOf = p => mT + (p - 1) / (maxPos - 1) * cH;

    // Horizontal grid lines — always show P1/5/10/15/20; add maxPos if beyond 20
    const gridPositions = [1, 5, 10, 15, 20];
    if (maxPos > 20) gridPositions.push(maxPos);
    let grid = '';
    gridPositions.forEach(p => {
        const y = yOf(p).toFixed(1);
        grid += `<line class="pchart-grid" x1="${mL}" y1="${y}" x2="${VW - mR}" y2="${y}"/>` +
                `<text class="pchart-grid-label" x="${mL - 4}" y="${(+y + 3.5).toFixed(1)}">P${p}</text>`;
    });
    grid += `<line class="pchart-grid" x1="${mL}" y1="${VH - mB}" x2="${VW - mR}" y2="${VH - mB}" stroke-width="1"/>`;

    // Lap number labels on X axis
    let lapAxis = '';
    const step = maxLap <= 30 ? 5 : maxLap <= 60 ? 10 : 15;
    for (let l = step; l <= maxLap; l += step) {
        lapAxis += `<text class="pchart-lap-label" x="${xOf(l).toFixed(1)}" y="${VH - mB + 14}">${l}</text>`;
    }

    // One polyline per driver
    const driverMap = {};
    (drivers || []).forEach(d => { driverMap[String(d.driver_number)] = d; });

    const lines = driverNums.map(dnum => {
        const d = driverMap[dnum];
        if (!d) return '';
        const tc      = teamColor(d.team_colour);
        const lapNums = Object.keys(driverLapPos[dnum]).map(Number).sort((a, b) => a - b);
        if (!lapNums.length) return '';

        const points = lapNums.map(l =>
            `${xOf(l).toFixed(1)},${yOf(driverLapPos[dnum][l]).toFixed(1)}`
        ).join(' ');

        const lastLap = lapNums[lapNums.length - 1];
        const lastPos = driverLapPos[dnum][lastLap];
        const lx = (xOf(lastLap) + 5).toFixed(1);
        const ly = yOf(lastPos).toFixed(1);

        return `<g class="pchart-group" data-driver="${dnum}">` +
               `<polyline class="pchart-line-hit" points="${points}"/>` +
               `<polyline class="pchart-line" points="${points}" stroke="${tc}"/>` +
               `<text class="pchart-driver-label" x="${lx}" y="${ly}" fill="${tc}">${d.name_acronym || ''}</text>` +
               `</g>`;
    }).join('');

    return `<div class="chart-card">` +
           `<div class="chart-title">📈 Race Position Chart <span class="chart-subtitle">· from lap 2 — grid positions not shown</span> <span class="chart-wip">WIP</span></div>` +
           `<svg class="pchart-svg" id="posChart" viewBox="0 0 ${VW} ${VH}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">` +
           grid + lapAxis + lines +
           `</svg></div>`;
}

function setupPositionChart() {
    const groups = document.querySelectorAll('.pchart-group');
    if (!groups.length) return;
    const svg = document.getElementById('posChart');
    groups.forEach(g => {
        g.addEventListener('mouseenter', () => {
            groups.forEach(other => {
                other.classList.remove('pchart-group-active', 'pchart-group-dim');
                other.classList.add(other === g ? 'pchart-group-active' : 'pchart-group-dim');
            });
        });
    });
    if (svg) {
        svg.addEventListener('mouseleave', () => {
            groups.forEach(g => g.classList.remove('pchart-group-active', 'pchart-group-dim'));
        });
    }
}

/* ─── MINI-GAME (lazy-loaded from game.js) ───────────────── */
let _game = null;
let _gameLoaded = false;

function loadGameScript() {
    if (_gameLoaded) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'game.js';
        s.onload = () => { _gameLoaded = true; resolve(); };
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

window.gameTouch = function(dir) { if (_game) _game.movePlayer(dir === 'left' ? -1 : 1); };
window.gameRestart = function() { if (_game) _game.restart(); };

/* ─── LEADERBOARD HELPERS ────────────────────────────────── */
function getLeaderboard() {
    try { return JSON.parse(localStorage.getItem('f1_game_lb') || '[]'); } catch { return []; }
}
function addToLeaderboard(score) {
    if (score <= 0) return;
    const lb = getLeaderboard();
    const date = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    lb.push({ score, date });
    lb.sort((a, b) => b.score - a.score);
    lb.splice(10); // keep top 10
    localStorage.setItem('f1_game_lb', JSON.stringify(lb));
}
function renderLeaderboard(highlightScore) {
    const lb = getLeaderboard();
    if (lb.length === 0) return '<p class="lb-empty">No scores yet — start racing!</p>';
    let highlighted = false;
    const rows = lb.map((entry, i) => {
        const isNew = !highlighted && highlightScore !== undefined && entry.score === highlightScore;
        if (isNew) highlighted = true;
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
        return `<tr class="${isNew ? 'lb-row-new' : ''}">
            <td class="lb-rank">${medal}</td>
            <td class="lb-score">${entry.score.toLocaleString()}</td>
            <td class="lb-date">${entry.date}</td>
        </tr>`;
    }).join('');
    return `<table class="lb-table">
        <thead><tr><th>Rank</th><th>Score</th><th>Date</th></tr></thead>
        <tbody>${rows}</tbody>
    </table>`;
}

function renderGameHTML() {
    const hs = localStorage.getItem('f1_game_hs') || '0';
    return `<div class="section-header">
        <h1>🎮 Box Box Racer</h1>
        <p class="section-subtitle">Dodge the backmarkers · Best: <span id="gameHsDisplay">${hs}</span></p>
    </div>
    <div class="game-wrap">
        <canvas id="gameCanvas" class="game-canvas"></canvas>
        <div class="game-touch-controls">
            <button class="game-touch-btn" ontouchstart="gameTouch('left')" onmousedown="gameTouch('left')">◀</button>
            <button class="game-touch-btn" ontouchstart="gameTouch('right')" onmousedown="gameTouch('right')">▶</button>
        </div>
    </div>
    <div class="lb-wrap">
        <h2 class="lb-title">🏆 Top 10 Leaderboard</h2>
        <div id="game-leaderboard">${renderLeaderboard()}</div>
    </div>`;
}

async function navGame() {
    if (_game) { _game.stop(); _game = null; }
    currentView = 'game'; currentMeeting = null; currentSession = null;
    clearCountdown();
    updateHash('game');
    document.getElementById('gameBtn').classList.add('active');
    document.getElementById('standingsBtn').classList.remove('active');
    document.getElementById('ratingsBtn').classList.remove('active');
    updateBreadcrumb();
    setApp(renderGameHTML());
    await loadGameScript();
    requestAnimationFrame(() => {
        const canvas = document.getElementById('gameCanvas');
        if (!canvas || !window.F1Game) return;
        _game = new window.F1Game(canvas);
        _game.start();
    });
}

/* ─── VIEW: RATINGS ─────────────────────────────────────── */
let _ratingsDrivers = [];  // cached driver list for re-renders

function getRatingsAll(year) {
    try { return JSON.parse(localStorage.getItem(`f1_ratings_${year}`) || '{}'); } catch { return {}; }
}
function saveRatingScore(year, meetingKey, driverCode, score) {
    const all = getRatingsAll(year);
    if (!all[meetingKey]) all[meetingKey] = {};
    if (score === null) delete all[meetingKey][driverCode];
    else all[meetingKey][driverCode] = score;
    localStorage.setItem(`f1_ratings_${year}`, JSON.stringify(all));
}

function renderDriverRatingGrid(meetingKey) {
    if (!meetingKey || !_ratingsDrivers.length) return '<p class="ratings-hint">Select a race above to start rating.</p>';
    const raceRatings = getRatingsAll(currentYear)[meetingKey] || {};
    const rows = _ratingsDrivers.map(entry => {
        const d = entry.Driver;
        const team = entry.Constructors?.[0];
        const tc = CONSTRUCTOR_COLORS[team?.constructorId] || '#666666';
        const saved = raceRatings[d.code] ?? null;
        const btns = [1,2,3,4,5,6,7,8,9,10].map(n =>
            `<button class="rating-btn${saved === n ? ' active' : ''}" onclick="onRateDriver('${meetingKey}','${d.code}',${n})">${n}</button>`
        ).join('');
        const clearBtn = saved !== null
            ? `<button class="rating-clear-btn" onclick="onRateDriver('${meetingKey}','${d.code}',null)" title="Clear rating">✕</button>`
            : '';
        return `<div class="driver-rating-row">
            <div class="driver-rating-info">
                <span class="driver-num-badge" style="background:${tc}">${d.code || '?'}</span>
                <span class="driver-rating-name">${d.givenName} ${d.familyName}</span>
            </div>
            <div class="rating-btns">${btns}${clearBtn}</div>
        </div>`;
    }).join('');
    return `<div class="driver-rating-grid">${rows}</div>`;
}

function renderRatingsSeasonAvg() {
    const allRatings = getRatingsAll(currentYear);
    const avgMap = {};
    Object.values(allRatings).forEach(raceRatings => {
        Object.entries(raceRatings).forEach(([code, score]) => {
            if (!avgMap[code]) avgMap[code] = { total: 0, count: 0 };
            avgMap[code].total += score;
            avgMap[code].count++;
        });
    });
    const rated = _ratingsDrivers.filter(e => avgMap[e.Driver.code]);
    if (!rated.length) {
        return `<div class="empty-state">
            <span class="icon">⭐</span>
            <h3>No ratings yet</h3>
            <p>Head to "Rate Races" and score the drivers to see your averages here.</p>
        </div>`;
    }
    const sorted = [...rated].sort((a, b) => {
        const aA = avgMap[a.Driver.code], bA = avgMap[b.Driver.code];
        return (bA.total / bA.count) - (aA.total / aA.count);
    });
    const rows = sorted.map((entry, i) => {
        const d = entry.Driver;
        const team = entry.Constructors?.[0];
        const tc = CONSTRUCTOR_COLORS[team?.constructorId] || '#666666';
        const avg = avgMap[d.code];
        const avgVal = avg.total / avg.count;
        const avgStr = avgVal.toFixed(1);
        const scoreCls = avgVal >= 8.5 ? 'rating-score-high' : avgVal >= 6.5 ? '' : 'rating-score-low';
        return `<tr>
            <td><span class="pos-num">${i + 1}</span></td>
            <td><div class="driver-cell">
                <span class="driver-num-badge" style="background:${tc}">${d.code || '?'}</span>
                <div class="driver-name-block">
                    <div class="name">${d.givenName} ${d.familyName}</div>
                    <div class="acronym">${team?.name || ''}</div>
                </div>
            </div></td>
            <td class="standings-wins">${avg.count}</td>
            <td class="standings-points ${scoreCls}">${avgStr}</td>
        </tr>`;
    }).join('');
    return `<div class="results-wrap"><table class="results-table">
        <thead><tr><th>RANK</th><th>DRIVER</th><th>RATED</th><th>AVG ⭐</th></tr></thead>
        <tbody>${rows}</tbody>
    </table></div>`;
}

function renderRatings(meetings, driverStandings) {
    _ratingsDrivers = driverStandings;
    const raceOptions = `<option value="">— Select a race —</option>` +
        meetings.map(m => `<option value="${m.meeting_key}">${flag(m.country_code)} ${m.meeting_name}</option>`).join('');
    const ratingsCount = Object.keys(getRatingsAll(currentYear)).length;
    return `<div class="section-header">
        <h1>⭐ Driver Ratings</h1>
        <p class="section-subtitle">Your personal performance scores for each driver, each race</p>
    </div>
    <div class="ratings-explainer">
        <p>Rate each driver's performance after every race on a 1–10 scale. Your ratings are saved on this device and used to build your personal season rankings in the <strong>Season Averages</strong> tab.</p>
        <div class="ratings-export-row">
            <button class="ratings-export-btn" onclick="exportRatings()">📥 Export Ratings</button>
            <label class="ratings-import-btn">📤 Import Ratings<input type="file" accept=".json" onchange="importRatings(event)" hidden></label>
            ${ratingsCount ? `<span class="ratings-count">${ratingsCount} race${ratingsCount === 1 ? '' : 's'} rated</span>` : ''}
        </div>
    </div>
    <div class="standings-tabs">
        <button class="standings-tab active" onclick="showRatingsTab('rate',this)">Rate Races</button>
        <button class="standings-tab" onclick="showRatingsTab('season',this)">Season Averages</button>
    </div>
    <div id="ratings-rate" class="standings-panel">
        <div class="race-selector-wrap">
            <select id="ratingRaceSelect" class="race-select-dropdown" onchange="onRatingRaceChange(this.value)">
                ${raceOptions}
            </select>
        </div>
        <div id="rating-drivers-grid"><p class="ratings-hint">Select a race above to start rating.</p></div>
    </div>
    <div id="ratings-season" class="standings-panel" style="display:none">
        ${renderRatingsSeasonAvg()}
    </div>`;
}

window.showRatingsTab = function(tab, btn) {
    document.querySelectorAll('.standings-tab').forEach(b => b.classList.remove('active'));
    document.getElementById('ratings-rate').style.display   = tab === 'rate'   ? 'block' : 'none';
    document.getElementById('ratings-season').style.display = tab === 'season' ? 'block' : 'none';
    if (btn) btn.classList.add('active');
    if (tab === 'season') document.getElementById('ratings-season').innerHTML = renderRatingsSeasonAvg();
};
window.onRatingRaceChange = function(meetingKey) {
    document.getElementById('rating-drivers-grid').innerHTML = renderDriverRatingGrid(meetingKey);
};
window.onRateDriver = function(meetingKey, driverCode, score) {
    saveRatingScore(currentYear, meetingKey, driverCode, score);
    document.getElementById('rating-drivers-grid').innerHTML = renderDriverRatingGrid(meetingKey);
};
window.exportRatings = function() {
    const data = {};
    for (let y = 2023; y <= new Date().getFullYear(); y++) {
        const r = getRatingsAll(y);
        if (Object.keys(r).length) data[y] = r;
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `box-box-ratings-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
};
window.importRatings = function(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = JSON.parse(e.target.result);
            let imported = 0;
            Object.entries(data).forEach(([year, ratings]) => {
                if (typeof ratings === 'object' && ratings !== null) {
                    const existing = getRatingsAll(year);
                    const merged = { ...existing, ...ratings };
                    localStorage.setItem(`f1_ratings_${year}`, JSON.stringify(merged));
                    imported += Object.keys(ratings).length;
                }
            });
            alert(`Imported ratings for ${imported} race${imported === 1 ? '' : 's'}. Your existing ratings were preserved.`);
            navRatings();
        } catch {
            alert('Could not read that file. Please use a JSON file exported from Box Box.');
        }
    };
    reader.readAsText(file);
    event.target.value = '';
};

async function navRatings() {
    currentView    = 'ratings';
    currentMeeting = null;
    currentSession = null;
    clearCountdown();
    updateHash(`ratings/${currentYear}`);
    document.getElementById('ratingsBtn').classList.add('active');
    document.getElementById('standingsBtn').classList.remove('active');
    updateBreadcrumb();
    showLoading();
    try {
        const [meetingsRaw, driversData] = await Promise.all([
            apiFetch('meetings', { year: currentYear }),
            jolpicaFetch(`${currentYear}/driverStandings.json`),
        ]);
        const now = new Date();
        const meetings = (meetingsRaw || [])
            .filter(m => m.meeting_name && !/test/i.test(m.meeting_name) && new Date(m.date_end) < now)
            .sort((a, b) => new Date(a.date_start) - new Date(b.date_start));
        const driverStandings = driversData?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings || [];
        hideLoading();
        setApp(renderRatings(meetings, driverStandings));
    } catch (e) {
        hideLoading();
        setApp(renderError('Could not load ratings', e.message));
    }
}

/* ─── VIEW: STANDINGS ────────────────────────────────────── */
function renderStandings(driverStandings, constructorStandings, formMap = {}) {
    const noData = (!driverStandings || !driverStandings.length) &&
                   (!constructorStandings || !constructorStandings.length);

    if (noData) {
        return `<div class="section-header">
            <h1>🏆 ${currentYear} Championship Standings</h1>
        </div>
        <div class="empty-state">
            <span class="icon">🏁</span>
            <h3>No standings yet</h3>
            <p>Standings appear after the first race of the season is completed.</p>
        </div>`;
    }

    const driverRows = (driverStandings || []).map(entry => {
        const d = entry.Driver;
        const team = entry.Constructors?.[0];
        const tc = CONSTRUCTOR_COLORS[team?.constructorId] || '#666666';
        const pos = parseInt(entry.position);
        const posCls = pos <= 3 ? `pos-${pos}` : '';
        const natFlag = NATIONALITY_FLAGS[d.nationality] || '';
        const last5 = (formMap[d.driverId] || []).slice(-5);
        const formDots = last5.map(f => {
            let cls, label;
            if (f.dnf)       { cls = 'fdot-dnf';    label = 'DNF'; }
            else if (f.pos === 1) { cls = 'fdot-win'; label = 'P1'; }
            else if (f.pos <= 3)  { cls = 'fdot-podium'; label = `P${f.pos}`; }
            else if (f.pos <= 10) { cls = 'fdot-pts';    label = `P${f.pos}`; }
            else                  { cls = 'fdot-out';    label = `P${f.pos}`; }
            return `<span class="form-dot ${cls}" title="${label}"></span>`;
        }).join('');
        return `<tr>
            <td><span class="pos-num ${posCls}">${pos}</span></td>
            <td><div class="driver-cell">
                <span class="driver-num-badge" style="background:${tc}">${d.code || pos}</span>
                <div class="driver-name-block">
                    <div class="name">${natFlag} ${d.givenName} ${d.familyName}</div>
                    <div class="acronym">${d.permanentNumber ? '#' + d.permanentNumber : ''}</div>
                </div>
            </div></td>
            <td class="col-team"><div class="team-cell">
                <span class="team-stripe" style="background:${tc}"></span>
                <span class="team-label">${team?.name || '—'}</span>
            </div></td>
            <td class="form-cell col-form">${formDots || '<span class="form-none">—</span>'}</td>
            <td class="standings-wins">${entry.wins}</td>
            <td class="standings-points">${entry.points}</td>
        </tr>`;
    }).join('');

    const constructorRows = (constructorStandings || []).map(entry => {
        const c = entry.Constructor;
        const tc = CONSTRUCTOR_COLORS[c.constructorId] || '#666666';
        const pos = parseInt(entry.position);
        const posCls = pos <= 3 ? `pos-${pos}` : '';
        const natFlag = NATIONALITY_FLAGS[c.nationality] || '';
        return `<tr>
            <td><span class="pos-num ${posCls}">${pos}</span></td>
            <td><div class="team-cell" style="gap:12px">
                <span class="team-stripe" style="background:${tc};height:28px;width:4px;border-radius:2px"></span>
                <span style="font-weight:600;color:var(--text-primary)">${natFlag} ${c.name}</span>
            </div></td>
            <td class="standings-wins">${entry.wins}</td>
            <td class="standings-points">${entry.points}</td>
        </tr>`;
    }).join('');

    return `<div class="section-header">
        <h1>🏆 ${currentYear} Championship Standings</h1>
    </div>
    <div class="standings-tabs">
        <button class="standings-tab active" onclick="showStandingsTab('drivers',this)">Drivers</button>
        <button class="standings-tab" onclick="showStandingsTab('constructors',this)">Constructors</button>
    </div>
    <div id="standings-drivers" class="standings-panel">
        <div class="form-legend">
            <span class="form-legend-item"><span class="form-dot fdot-win"></span>Win</span>
            <span class="form-legend-item"><span class="form-dot fdot-podium"></span>Podium</span>
            <span class="form-legend-item"><span class="form-dot fdot-pts"></span>Points</span>
            <span class="form-legend-item"><span class="form-dot fdot-out"></span>Outside points</span>
            <span class="form-legend-item"><span class="form-dot fdot-dnf"></span>DNF</span>
        </div>
        <div class="results-wrap"><table class="results-table">
            <thead><tr><th>POS</th><th>DRIVER</th><th class="col-team">TEAM</th><th class="form-th col-form">FORM</th><th>WINS</th><th>POINTS</th></tr></thead>
            <tbody>${driverRows || '<tr><td colspan="5" class="no-data-cell">No data yet</td></tr>'}</tbody>
        </table></div>
    </div>
    <div id="standings-constructors" class="standings-panel" style="display:none">
        <div class="results-wrap"><table class="results-table">
            <thead><tr><th>POS</th><th>CONSTRUCTOR</th><th>WINS</th><th>POINTS</th></tr></thead>
            <tbody>${constructorRows || '<tr><td colspan="4" class="no-data-cell">No data yet</td></tr>'}</tbody>
        </table></div>
    </div>`;
}

window.showStandingsTab = function(tab, btn) {
    document.querySelectorAll('.standings-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.standings-panel').forEach(p => p.style.display = 'none');
    document.getElementById(`standings-${tab}`).style.display = 'block';
    if (btn) btn.classList.add('active');
};

/* ─── UI UTILITIES ───────────────────────────────────────── */
function showLoading() {
    document.getElementById('loading').style.display = 'flex';
    document.getElementById('app').innerHTML = '';
}
function hideLoading() {
    document.getElementById('loading').style.display = 'none';
}
function setApp(html) {
    document.getElementById('app').innerHTML = html;
}
function renderError(title, msg) {
    return `<div class="error-state">
        <span class="error-icon">⚠️</span>
        <div class="error-title">${title}</div>
        <div class="error-msg">${msg || 'Something went wrong. Please try again.'}</div>
    </div>`;
}

/* ─── BREADCRUMB ─────────────────────────────────────────── */
function updateBreadcrumb() {
    const nav     = document.getElementById('breadcrumb');
    const homeEl  = document.getElementById('breadcrumbHome');
    const meetEl  = document.getElementById('breadcrumbMeeting');
    const sessEl  = document.getElementById('breadcrumbSession');
    const sep2    = document.getElementById('breadcrumbSep2');

    homeEl.classList.remove('active');
    meetEl.classList.remove('active');
    sessEl.classList.remove('active');

    if (currentView === 'calendar') {
        nav.style.display = 'none';
        return;
    }
    if (currentView === 'standings' || currentView === 'ratings' || currentView === 'game') {
        nav.style.display = 'block';
        homeEl.textContent = `${currentYear} Season`;
        meetEl.textContent = currentView === 'ratings' ? 'Ratings' : currentView === 'game' ? 'Box Box Racer' : 'Standings';
        meetEl.classList.add('active');
        sessEl.style.display = 'none';
        sep2.style.display   = 'none';
        return;
    }
    nav.style.display = 'block';
    homeEl.textContent = `${currentYear} Season`;

    if (currentView === 'weekend') {
        meetEl.textContent = currentMeeting?.meeting_name || 'Race Weekend';
        meetEl.classList.add('active');
        sessEl.style.display = 'none';
        sep2.style.display   = 'none';
    } else {
        meetEl.textContent   = currentMeeting?.meeting_name || 'Race Weekend';
        sessEl.textContent   = currentSession?.session_name || 'Session';
        sessEl.style.display = 'inline';
        sep2.style.display   = 'inline';
        sessEl.classList.add('active');
    }
}

/* ─── COUNTDOWN ──────────────────────────────────────────── */
function shortSessionName(name) {
    if (!name) return '';
    if (/practice\s*1/i.test(name))              return 'FP1';
    if (/practice\s*2/i.test(name))              return 'FP2';
    if (/practice\s*3/i.test(name))              return 'FP3';
    if (/sprint\s*(quali|shoot)/i.test(name))    return 'SQ';
    if (/^sprint$/i.test(name.trim()))           return 'Sprint';
    if (/quali/i.test(name))                     return 'Quali';
    if (/^race$/i.test(name.trim()))             return 'Race';
    return name;
}

function clearCountdown() {
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
}

function startCountdown(targetMs) {
    clearCountdown();
    function tick() {
        const diff = targetMs - Date.now();
        const dEl  = document.getElementById('cd-days');
        if (!dEl) { clearCountdown(); return; }   // navigated away
        if (diff <= 0) {
            ['cd-days','cd-hours','cd-mins','cd-secs'].forEach(id => {
                document.getElementById(id).textContent = '0';
            });
            clearCountdown();
            return;
        }
        const days  = Math.floor(diff / 86400000);
        const hours = Math.floor((diff % 86400000) / 3600000);
        const mins  = Math.floor((diff % 3600000)  / 60000);
        const secs  = Math.floor((diff % 60000)    / 1000);
        dEl.textContent                                  = days;
        document.getElementById('cd-hours').textContent = String(hours).padStart(2,'0');
        document.getElementById('cd-mins').textContent  = String(mins).padStart(2,'0');
        document.getElementById('cd-secs').textContent  = String(secs).padStart(2,'0');
    }
    tick();
    countdownInterval = setInterval(tick, 1000);
}

window.selectCountdownSession = function(idx) {
    if (idx < 0 || idx >= cdSessions.length) return;
    cdCurrentIdx = idx;
    const s = cdSessions[idx];

    const nameEl = document.getElementById('cd-session-name');
    if (nameEl) nameEl.textContent = s.label;

    const whenEl = document.getElementById('cd-when');
    if (whenEl) {
        const tz      = resolvedTz();
        const date    = new Date(s.target);
        const dateStr = date.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short', timeZone: tz });
        const timeStr = fmtTimeTz(s.target, tz);
        const tzLbl   = tzShort(tz, date);
        whenEl.innerHTML = `${dateStr} · ${timeStr} <span class="tz-tag">${tzLbl}</span>`;
    }

    document.querySelectorAll('.cd-session-pill').forEach((pill, i) => {
        pill.classList.toggle('active', i === idx);
    });

    startCountdown(s.target);
};

/* ─── VIEW: CALENDAR ─────────────────────────────────────── */
function renderCalendar(meetings, cdInfo) {
    if (!meetings || meetings.length === 0) {
        return `<div class="empty-state">
            <span class="icon">🏁</span>
            <h3>No races found for ${currentYear}</h3>
            <p>The season data may not be available yet — try selecting a previous year.</p>
        </div>`;
    }

    const nextIdx = nextRaceIdx(meetings);

    let bannerHtml = '';
    if (cdInfo) {
        const tz      = resolvedTz();
        const date    = new Date(cdInfo.target);
        const dateStr = date.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short', timeZone: tz });
        const timeStr = fmtTimeTz(cdInfo.target, tz);
        const tzLbl   = tzShort(tz, date);
        const pills = (cdInfo.allSessions || []).length > 1
            ? `<div class="cd-session-pills">${
                (cdInfo.allSessions || []).map((s, i) =>
                    `<button class="cd-session-pill${i === 0 ? ' active' : ''}" onclick="selectCountdownSession(${i})">${s.shortName}</button>`
                ).join('')
              }</div>`
            : '';
        bannerHtml = `<div class="countdown-banner">
            <div class="countdown-info">
                <span class="countdown-tag">NEXT UP</span>
                ${pills}
                <span class="countdown-session-name" id="cd-session-name">${cdInfo.label}</span>
                <span class="countdown-when" id="cd-when">${dateStr} · ${timeStr} <span class="tz-tag">${tzLbl}</span></span>
            </div>
            <div class="countdown-timer">
                <div class="countdown-unit"><span id="cd-days">—</span><label>days</label></div>
                <div class="countdown-unit"><span id="cd-hours">—</span><label>hrs</label></div>
                <div class="countdown-unit"><span id="cd-mins">—</span><label>min</label></div>
                <div class="countdown-unit"><span id="cd-secs">—</span><label>sec</label></div>
            </div>
        </div>`;
    }

    /* Split meetings into completed and upcoming */
    const completed = [];
    const upcoming  = [];
    meetings.forEach((m, i) => {
        const st = meetingStatus(m);
        const isNext = (i === nextIdx);
        const obj = { m, i, st, isNext };
        if (st === 'completed') completed.push(obj);
        else upcoming.push(obj);
    });
    /* Results tab: reverse chronological (most recent first) */
    const completedSorted = [...completed].reverse();

    function buildCards(list) {
        return list.map(({ m, i, st, isNext }) => {
            const cardCls = st === 'completed' ? 'completed' : isNext ? 'next-race' : 'upcoming';
            const badgeCls = st === 'completed' ? 'completed' : isNext ? 'next' : 'upcoming';
            const badgeTxt = st === 'completed' ? 'Completed' : isNext ? 'Next Race' : 'Upcoming';
            return `<div class="race-card ${cardCls}" onclick="navWeekend(${m.meeting_key})">
                <div class="race-card-top">
                    <span class="round-badge">R${i + 1}</span>
                    <span class="status-badge ${badgeCls}">${badgeTxt}</span>
                </div>
                <span class="race-flag">${flag(m.country_code)}</span>
                <div class="race-name">${m.meeting_name || m.meeting_official_name || 'Grand Prix'}</div>
                <div class="circuit-name">📍 ${m.location || m.circuit_short_name || ''}</div>
                <div class="race-dates">📅 ${fmtDateRange(m.date_start, m.date_end)}</div>
            </div>`;
        }).join('');
    }

    const resultsCards  = completedSorted.length
        ? `<div class="calendar-grid">${buildCards(completedSorted)}</div>`
        : `<div class="empty-state"><span class="icon">🏁</span><h3>No results yet</h3><p>Completed races will appear here.</p></div>`;
    const upcomingCards = upcoming.length
        ? `<div class="calendar-grid">${buildCards(upcoming)}</div>`
        : `<div class="empty-state"><span class="icon">📅</span><h3>Season complete</h3><p>All races have been completed!</p></div>`;

    const isResults  = calendarTab === 'results';

    return bannerHtml + `<div class="section-header">
        <h1>${currentYear} Formula 1 Season</h1>
        <p>${meetings.length} Grands Prix · click a race to explore the weekend</p>
    </div>
    <div class="standings-tabs">
        <button class="standings-tab${isResults ? ' active' : ''}" onclick="switchCalendarTab('results',this)">Results (${completed.length})</button>
        <button class="standings-tab${!isResults ? ' active' : ''}" onclick="switchCalendarTab('upcoming',this)">Upcoming (${upcoming.length})</button>
    </div>
    <div id="calendar-results" class="standings-panel" style="display:${isResults ? 'block' : 'none'}">${resultsCards}</div>
    <div id="calendar-upcoming" class="standings-panel" style="display:${!isResults ? 'block' : 'none'}">${upcomingCards}</div>`;
}

window.switchCalendarTab = function(tab, btn) {
    calendarTab = tab;
    document.querySelectorAll('.standings-tabs .standings-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    document.getElementById('calendar-results').style.display  = tab === 'results'  ? 'block' : 'none';
    document.getElementById('calendar-upcoming').style.display  = tab === 'upcoming' ? 'block' : 'none';
};

/* ─── VIEW: WEEKEND ──────────────────────────────────────── */
function renderWeekend(meeting, sessions) {
    if (!sessions || sessions.length === 0) {
        return `<div class="empty-state">
            <span class="icon">📋</span>
            <h3>No session data yet</h3>
            <p>Session info for this weekend hasn't been published yet.</p>
        </div>`;
    }

    const sorted = [...sessions].sort((a, b) => new Date(a.date_start) - new Date(b.date_start));

    const rows = sorted.map(s => {
        const type      = s.session_type || s.session_name || '';
        const badgeCls  = sessionBadgeClass(s.session_type, s.session_name);
        const done      = sessionCompleted(s);
        const dotCls    = done ? 'dot-completed' : 'dot-upcoming';
        const statusTxt = done ? 'Completed' : 'Upcoming';
        const dateStr     = fmtDate(s.date_start);
        const sessionDate = new Date(s.date_start);
        const circuitTime = circuitLocalTime(s.date_start, s.gmt_offset);
        const selTz       = resolvedTz();
        const selTime     = fmtTimeTz(s.date_start, selTz);
        const selLabel    = tzShort(selTz, sessionDate);

        const timeDisplay = circuitTime
            ? `🕐 ${circuitTime} <span class="tz-tag">Local</span> · ${selTime} <span class="tz-tag">${selLabel}</span>`
            : `🕐 ${selTime} <span class="tz-tag">${selLabel}</span>`;

        return `<div class="session-card" onclick="navSession(${s.session_key}, ${meeting.meeting_key})">
            <div class="session-card-left">
                <span class="session-type-badge ${badgeCls}">${type}</span>
                <div>
                    <div class="session-name">${s.session_name}</div>
                    <div class="session-datetime">
                        📅 ${dateStr} · ${timeDisplay} ·
                        <span class="session-status-dot ${dotCls}"></span>${statusTxt}
                    </div>
                </div>
            </div>
            <span class="session-arrow">›</span>
        </div>`;
    }).join('');

    const ci = CIRCUIT_DATA[meeting.location] || CIRCUIT_DATA[meeting.circuit_short_name];
    const circuitCard = ci ? `
    <div class="circuit-card">
        <div class="circuit-card-header">🏁 Circuit Info</div>
        <div class="circuit-stats-grid">
            <div class="circuit-stat">
                <span class="cs-label">Circuit</span>
                <span class="cs-value">${ci.name}</span>
            </div>
            <div class="circuit-stat">
                <span class="cs-label">Length</span>
                <span class="cs-value">${ci.length} km</span>
            </div>
            <div class="circuit-stat">
                <span class="cs-label">Race Laps</span>
                <span class="cs-value">${ci.laps}</span>
            </div>
            <div class="circuit-stat">
                <span class="cs-label">Race Distance</span>
                <span class="cs-value">${(ci.length * ci.laps).toFixed(1)} km</span>
            </div>
            <div class="circuit-stat circuit-stat-wide">
                <span class="cs-label">Lap Record</span>
                <span class="cs-value">${ci.record} — ${ci.recordBy}</span>
            </div>
        </div>
    </div>` : '';

    return `<div class="section-header">
        <h1>${flag(meeting.country_code)} ${meeting.meeting_name || meeting.meeting_official_name}</h1>
        <div class="section-meta">
            <span>📍 ${meeting.location || meeting.circuit_short_name || ''}</span>
            <span>📅 ${fmtDateRange(meeting.date_start, meeting.date_end)}</span>
        </div>
    </div>
    ${circuitCard}
    <div class="sessions-list">${rows}</div>`;
}

/* ─── VIEW: SESSION RESULTS ──────────────────────────────── */
function renderSessionResults(session, drivers, positions, laps, stints, raceControl, pits, weather) {
    if (!drivers || drivers.length === 0) {
        return `<div class="section-header">
            <h1>${session.session_name}</h1>
        </div>
        <div class="empty-state">
            <span class="icon">🏎️</span>
            <h3>Results not yet available</h3>
            <p>Check back after the session has completed.</p>
        </div>`;
    }

    const isRace = /^(race|sprint)$/i.test(session.session_type || '');

    /* Build maps */
    const driverMap = {};
    drivers.forEach(d => { driverMap[d.driver_number] = d; });

    const stintsMap = {};
    (stints || []).forEach(s => {
        if (!stintsMap[s.driver_number]) stintsMap[s.driver_number] = [];
        stintsMap[s.driver_number].push(s);
    });

    const pitsMap = {};
    (pits || []).forEach(p => {
        if (!pitsMap[p.driver_number]) pitsMap[p.driver_number] = [];
        pitsMap[p.driver_number].push(p);
    });

    let results = [];

    /* ── RACE / SPRINT ── */
    if (isRace) {
        /* Final position = latest position entry per driver */
        const finalPos = {};
        (positions || []).forEach(p => {
            const key = p.driver_number;
            if (!finalPos[key] || new Date(p.date) > new Date(finalPos[key].date)) {
                finalPos[key] = p;
            }
        });

        /* Fastest lap = minimum lap_duration across all valid laps */
        let fastestLapDriver = null;
        let fastestLapTime   = Infinity;
        (laps || []).forEach(lap => {
            if (lap.lap_duration && lap.lap_duration > 0 && lap.lap_duration < fastestLapTime) {
                fastestLapTime   = lap.lap_duration;
                fastestLapDriver = lap.driver_number;
            }
        });

        Object.keys(driverMap).forEach(num => {
            const pos = finalPos[num];
            results.push({
                driver:    driverMap[num],
                position:  pos ? pos.position : 99,
                stints:    stintsMap[num] || [],
                pits:      pitsMap[num]   || [],
                penalties: penaltiesFor(raceControl, parseInt(num)),
            });
        });
        results.sort((a, b) => a.position - b.position);

        const header = `<div class="section-header">
            <h1>${session.session_name}</h1>
            <div class="section-meta">
                <span>📍 ${session.location || session.circuit_short_name || ''}</span>
                <span>📅 ${fmtDate(session.date_start)}</span>
            </div>
        </div>`;

        const rows = results.map(r => {
            const d          = r.driver;
            const tc         = teamColor(d.team_colour);
            const posStr     = r.position < 99 ? r.position : 'DNF';
            const posCls     = r.position <= 3 ? `pos-${r.position}` : '';
            const isFastest  = fastestLapDriver !== null &&
                               parseInt(d.driver_number) === parseInt(fastestLapDriver);
            const isFav      = String(d.driver_number) === favDriver;
            const fastBadge  = isFastest
                ? '<span class="fastest-lap-badge">⚡ FL</span>'
                : '';
            const pens       = r.penalties.length
                ? r.penalties.map(p => `<span class="penalty-tag">${p.message.replace('FIA STEWARDS: ','')}</span>`).join('<br style="margin:2px 0;">')
                : '<span class="no-val">—</span>';
            const trClass    = [isFastest ? 'fastest-lap-row' : '', isFav ? 'fav-driver-row' : ''].filter(Boolean).join(' ');

            return `<tr${trClass ? ` class="${trClass}"` : ''} data-drv="${d.driver_number}">
                <td class="fav-star-cell"><button class="fav-star-btn" onclick="toggleFavDriver(event,'${d.driver_number}')">${isFav ? '★' : '☆'}</button></td>
                <td><span class="pos-num ${posCls}">${posStr}</span></td>
                <td><div class="driver-cell">
                    <span class="driver-num-badge" style="background:${tc}">${d.driver_number}</span>
                    <div class="driver-name-block">
                        <div class="name">${d.first_name} ${d.last_name} ${fastBadge}</div>
                        <div class="acronym">${d.name_acronym}</div>
                    </div>
                </div></td>
                <td class="col-team"><div class="team-cell">
                    <span class="team-stripe" style="background:${tc}"></span>
                    <span class="team-label">${d.team_name}</span>
                </div></td>
                <td>${renderTyres(r.stints)}</td>
                <td class="col-pits">${renderPits(r.pits)}</td>
                <td class="col-penalties">${pens}</td>
            </tr>`;
        }).join('');

        return header + renderWeather(weather) + renderPositionChart(laps, drivers) + `<div class="results-wrap"><table class="results-table">
            <thead><tr>
                <th class="fav-star-th"></th><th>POS</th><th>DRIVER</th><th class="col-team">TEAM</th><th>TYRES</th><th class="col-pits">PITS</th><th class="col-penalties">PENALTIES</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table></div>`;

    /* ── QUALIFYING / PRACTICE / SPRINT SHOOTOUT ── */
    } else {
        /* Best lap per driver */
        const bestLap = {};
        (laps || []).forEach(lap => {
            if (!lap.lap_duration) return;
            const n = lap.driver_number;
            if (!bestLap[n] || lap.lap_duration < bestLap[n]) bestLap[n] = lap.lap_duration;
        });

        Object.keys(driverMap).forEach(num => {
            results.push({
                driver:    driverMap[num],
                bestLap:   bestLap[num] || null,
                stints:    stintsMap[num] || [],
                penalties: penaltiesFor(raceControl, parseInt(num)),
            });
        });
        /* Sort: fastest first; no-time drivers at the bottom */
        results.sort((a, b) => {
            if (!a.bestLap && !b.bestLap) return 0;
            if (!a.bestLap) return 1;
            if (!b.bestLap) return -1;
            return a.bestLap - b.bestLap;
        });

        const fastest = results[0]?.bestLap;

        const header = `<div class="section-header">
            <h1>${session.session_name}</h1>
            <div class="section-meta">
                <span>📍 ${session.location || session.circuit_short_name || ''}</span>
                <span>📅 ${fmtDate(session.date_start)}</span>
            </div>
        </div>`;

        /* Detect session type for cut lines */
        const isQualifying     = /^qualifying$/i.test(session.session_type || '');
        const isSprintShootout = /sprint.*(qual|shoot)/i.test(
            (session.session_type || '') + ' ' + (session.session_name || '')
        );
        const NCOLS = 8;

        const mkCutRow = (label, colour) =>
            `<tr class="quali-cut-row"><td colspan="${NCOLS}"><div class="quali-cut-content">` +
            `<div class="quali-cut-rule quali-cut-rule-${colour}"></div>` +
            `<span class="quali-cut-pill quali-cut-pill-${colour}">${label}</span>` +
            `<div class="quali-cut-rule quali-cut-rule-${colour}"></div>` +
            `</div></td></tr>`;

        let rows = '';
        results.forEach((r, i) => {
            const d       = r.driver;
            const tc      = teamColor(d.team_colour);
            const pos     = i + 1;
            const posCls  = pos <= 3 ? `pos-${pos}` : '';
            const isFav   = String(d.driver_number) === favDriver;
            const timeStr = r.bestLap ? `<span class="lap-time">${fmtLap(r.bestLap)}</span>` : '<span class="no-val">No time</span>';
            const gap     = (r.bestLap && fastest && pos > 1) ? fmtGap(r.bestLap - fastest) : null;
            const gapStr  = pos === 1 ? '<span class="no-val">—</span>'
                           : gap ? `<span class="lap-gap">${gap}</span>` : '<span class="no-val">—</span>';

            /* For qualifying, show the tyre used on the quickest lap (last stint) */
            const lastStint = r.stints[r.stints.length - 1];
            const tyreCell  = lastStint
                ? `<div class="tyre-strat">
                    <span class="tyre-dot tyre-${(lastStint.compound||'UNKNOWN').toUpperCase()}"
                          title="${lastStint.compound}">
                        ${TYRE_LETTER[(lastStint.compound||'UNKNOWN').toUpperCase()] || '?'}
                    </span>
                   </div>`
                : '<span class="no-val">—</span>';

            const pens = r.penalties.length
                ? r.penalties.map(p => `<span class="penalty-tag">${p.message.replace('FIA STEWARDS: ','')}</span>`).join('<br style="margin:2px 0;">')
                : '<span class="no-val">—</span>';

            rows += `<tr${isFav ? ' class="fav-driver-row"' : ''} data-drv="${d.driver_number}">
                <td class="fav-star-cell"><button class="fav-star-btn" onclick="toggleFavDriver(event,'${d.driver_number}')">${isFav ? '★' : '☆'}</button></td>
                <td><span class="pos-num ${posCls}">${pos}</span></td>
                <td><div class="driver-cell">
                    <span class="driver-num-badge" style="background:${tc}">${d.driver_number}</span>
                    <div class="driver-name-block">
                        <div class="name">${d.first_name} ${d.last_name}</div>
                        <div class="acronym">${d.name_acronym}</div>
                    </div>
                </div></td>
                <td class="col-team"><div class="team-cell">
                    <span class="team-stripe" style="background:${tc}"></span>
                    <span class="team-label">${d.team_name}</span>
                </div></td>
                <td>${timeStr}</td>
                <td class="col-gap">${gapStr}</td>
                <td>${tyreCell}</td>
                <td class="col-penalties">${pens}</td>
            </tr>`;

            /* ── Session cut lines ── */
            if (isQualifying) {
                if (pos === 10 && results.length > 10) rows += mkCutRow('ELIMINATED IN Q2', 'amber');
                if (pos === 15 && results.length > 15) rows += mkCutRow('ELIMINATED IN Q1', 'red');
            } else if (isSprintShootout) {
                if (pos === 6 && results.length > 6)  rows += mkCutRow('ELIMINATED IN SQ2', 'amber');
                if (pos === 8 && results.length > 8)  rows += mkCutRow('ELIMINATED IN SQ1', 'red');
            }
        });

        return header + renderWeather(weather) + `<div class="results-wrap"><table class="results-table">
            <thead><tr>
                <th class="fav-star-th"></th><th>POS</th><th>DRIVER</th><th class="col-team">TEAM</th>
                <th>BEST LAP</th><th class="col-gap">GAP</th><th>TYRE</th><th class="col-penalties">PENALTIES</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table></div>`;
    }
}

/* ─── NAVIGATION ─────────────────────────────────────────── */
async function navCalendar() {
    currentView    = 'calendar';
    currentMeeting = null;
    currentSession = null;
    clearCountdown();
    updateHash('');
    const sBtn = document.getElementById('standingsBtn');
    if (sBtn) sBtn.classList.remove('active');
    updateBreadcrumb();
    showLoading();
    try {
        const meetings = await getMeetings(currentYear);

        /* Find the next upcoming session for the countdown */
        let cdInfo    = null;
        const nextIdx = nextRaceIdx(meetings);
        if (nextIdx >= 0) {
            const nextMtg = meetings[nextIdx];
            try {
                const sessions = await getSessions(nextMtg.meeting_key);
                const now      = Date.now();
                const upcoming = sessions
                    .filter(s => new Date(s.date_start).getTime() > now)
                    .sort((a, b) => new Date(a.date_start) - new Date(b.date_start));
                if (upcoming.length > 0) {
                    cdSessions   = upcoming.map(s => ({
                        target:    new Date(s.date_start).getTime(),
                        label:     `${nextMtg.meeting_name} · ${s.session_name}`,
                        shortName: shortSessionName(s.session_name),
                    }));
                    cdCurrentIdx = 0;
                    cdInfo = { ...cdSessions[0], allSessions: cdSessions };
                } else if (nextIdx + 1 < meetings.length) {
                    /* All sessions in the live meeting are done — count to next meeting */
                    const after = meetings[nextIdx + 1];
                    cdInfo = {
                        target: new Date(after.date_start).getTime(),
                        label:  after.meeting_name,
                    };
                }
            } catch {
                /* Sessions unavailable — fall back to meeting start */
                const t = new Date(nextMtg.date_start).getTime();
                if (t > Date.now()) cdInfo = { target: t, label: nextMtg.meeting_name };
            }
        }

        hideLoading();
        setApp(renderCalendar(meetings, cdInfo));
        if (cdInfo) startCountdown(cdInfo.target);
    } catch (e) {
        hideLoading();
        setApp(renderError('Could not load calendar', e.message));
    }
}

async function navWeekend(meetingKey) {
    currentView = 'weekend';
    clearCountdown();
    updateHash(`weekend/${meetingKey}/${currentYear}`);
    showLoading();
    try {
        const [meetings, sessions] = await Promise.all([
            getMeetings(currentYear),
            getSessions(meetingKey),
        ]);
        currentMeeting = meetings.find(m => m.meeting_key === meetingKey)
                      || { meeting_key: meetingKey, meeting_name: 'Race Weekend' };
        currentSession = null;
        updateBreadcrumb();
        hideLoading();
        setApp(renderWeekend(currentMeeting, sessions));
    } catch (e) {
        hideLoading();
        setApp(renderError('Could not load race weekend', e.message));
    }
}

async function navSession(sessionKey, meetingKey) {
    currentView = 'session';
    clearCountdown();
    updateHash(`session/${meetingKey}/${sessionKey}/${currentYear}`);
    showLoading();
    try {
        /* Ensure we have meeting + session objects */
        if (!currentMeeting || currentMeeting.meeting_key !== meetingKey) {
            const [meetings, sessions] = await Promise.all([
                getMeetings(currentYear),
                getSessions(meetingKey),
            ]);
            currentMeeting = meetings.find(m => m.meeting_key === meetingKey);
            currentSession = sessions.find(s => s.session_key === sessionKey);
        } else {
            const sessions = await getSessions(meetingKey);
            currentSession = sessions.find(s => s.session_key === sessionKey);
        }
        if (!currentSession) {
            hideLoading();
            setApp(renderError('Session not found', 'This session may not exist or data is unavailable.'));
            return;
        }
        updateBreadcrumb();

        const isRace = /^(race|sprint)$/i.test(currentSession?.session_type || '');

        /* Fetch in parallel — always get laps (fastest lap for races, timing for quali/practice) */
        const [drivers, stints, rc, positions, laps, pits, weather] = await Promise.all([
            getDrivers(sessionKey),
            getStints(sessionKey),
            getRaceControl(sessionKey),
            isRace ? getPositions(sessionKey) : Promise.resolve([]),
            getLaps(sessionKey),
            isRace ? getPits(sessionKey) : Promise.resolve([]),
            getWeather(sessionKey),
        ]);

        hideLoading();
        const html = renderSessionResults(
            currentSession,
            drivers,
            positions,
            laps,
            stints,
            rc,
            pits,
            weather
        );
        setApp(html);
        setupPositionChart();
    } catch (e) {
        hideLoading();
        setApp(renderError('Could not load session results', e.message));
    }
}

async function navStandings() {
    currentView    = 'standings';
    currentMeeting = null;
    currentSession = null;
    clearCountdown();
    updateHash(`standings/${currentYear}`);
    document.getElementById('standingsBtn').classList.add('active');
    document.getElementById('ratingsBtn').classList.remove('active');
    document.getElementById('gameBtn').classList.remove('active');
    updateBreadcrumb();
    showLoading();
    try {
        const [driversData, constructorsData, resultsData] = await Promise.all([
            jolpicaFetch(`${currentYear}/driverStandings.json`),
            jolpicaFetch(`${currentYear}/constructorStandings.json`),
            jolpicaFetch(`${currentYear}/results.json?limit=100`),
        ]);
        const driverStandings      = driversData?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings || [];
        const constructorStandings = constructorsData?.MRData?.StandingsTable?.StandingsLists?.[0]?.ConstructorStandings || [];
        const formMap = {};
        (resultsData?.MRData?.RaceTable?.Races || []).forEach(race => {
            (race.Results || []).forEach(r => {
                const id = r.Driver.driverId;
                if (!formMap[id]) formMap[id] = [];
                // positionText is a number ("1"–"20") for any classified finisher,
                // "R" for retired, "D" for disqualified — more reliable than status strings
                const dnf = isNaN(parseInt(r.positionText));
                formMap[id].push({ pos: parseInt(r.position), dnf });
            });
        });
        hideLoading();
        setApp(renderStandings(driverStandings, constructorStandings, formMap));
    } catch (e) {
        hideLoading();
        setApp(renderError('Could not load standings', e.message));
    }
}

/* ─── YEAR SELECTOR ──────────────────────────────────────── */
function changeYear(delta) {
    const newYear = currentYear + delta;
    const thisYear = new Date().getFullYear();
    if (newYear < 2023 || newYear > thisYear) return;
    currentYear = newYear;
    document.getElementById('currentYearDisplay').textContent = currentYear;
    document.getElementById('prevYear').disabled = (currentYear <= 2023);
    document.getElementById('nextYear').disabled = (currentYear >= thisYear);
    if (currentView === 'standings') { navStandings(); }
    else if (currentView === 'ratings') { navRatings(); }
    else if (currentView === 'game') { navGame(); }
    else { navCalendar(); }
}

document.getElementById('prevYear').addEventListener('click', () => changeYear(-1));
document.getElementById('nextYear').addEventListener('click', () => changeYear(+1));

/* ─── BREADCRUMB CLICKS ──────────────────────────────────── */
function goCalendar() {
    document.getElementById('standingsBtn').classList.remove('active');
    document.getElementById('ratingsBtn').classList.remove('active');
    document.getElementById('gameBtn').classList.remove('active');
    if (_game) { _game.stop(); _game = null; }
    navCalendar();
}
document.getElementById('logoHome').addEventListener('click', goCalendar);
document.getElementById('breadcrumbHome').addEventListener('click', goCalendar);
document.getElementById('standingsBtn').addEventListener('click', navStandings);
document.getElementById('ratingsBtn').addEventListener('click', navRatings);
document.getElementById('gameBtn').addEventListener('click', navGame);
document.getElementById('breadcrumbMeeting').addEventListener('click', () => {
    if (currentMeeting) navWeekend(currentMeeting.meeting_key);
});

/* ─── THEME TOGGLE ───────────────────────────────────────── */
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('f1-theme', theme);
}

document.getElementById('themeToggle').addEventListener('click', function () {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    applyTheme(isDark ? 'light' : 'dark');
});

/* ─── TIMEZONE SELECTOR ──────────────────────────────────── */
function applyTimezone(tz) {
    currentTimezone = tz;
    localStorage.setItem('f1-tz', tz);
    const sel = document.getElementById('tzSelect');
    if (sel) sel.value = tz;
}

document.getElementById('tzSelect').addEventListener('change', function () {
    applyTimezone(this.value);
    /* Re-render the current view — data is already cached, so no network requests */
    if (currentView === 'weekend' && currentMeeting) {
        navWeekend(currentMeeting.meeting_key);
    } else if (currentView === 'calendar') {
        navCalendar();
    } else if (currentView === 'session' && currentSession) {
        navSession(currentSession.session_key, currentMeeting.meeting_key);
    }
});

/* ─── HAMBURGER MENU ─────────────────────────────────────── */
(function initHamburger() {
    const btn = document.getElementById('hamburgerBtn');
    const headerRight = document.querySelector('.header-right');
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = headerRight.classList.toggle('menu-open');
        btn.classList.toggle('open', open);
        document.body.style.overflow = open ? 'hidden' : '';
    });
    /* Close menu when a nav item is clicked */
    headerRight.querySelectorAll('.header-nav-item').forEach(item => {
        item.addEventListener('click', () => {
            headerRight.classList.remove('menu-open');
            btn.classList.remove('open');
            document.body.style.overflow = '';
        });
    });
})();

/* ─── INIT ───────────────────────────────────────────────── */
(function init() {
    const thisYear = new Date().getFullYear();
    currentYear = thisYear;
    document.getElementById('currentYearDisplay').textContent = currentYear;
    document.getElementById('prevYear').disabled = (currentYear <= 2023);
    document.getElementById('nextYear').disabled = (currentYear >= thisYear);
    applyTheme(localStorage.getItem('f1-theme') || 'light');
    applyTimezone(localStorage.getItem('f1-tz') || 'auto');
    routeFromHash();
})();
