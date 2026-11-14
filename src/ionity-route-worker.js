// Ionity route planner – Cloudflare Worker proxy (phase 1)
//
// Endpoints
//   GET  /                      health check: shows which secrets are set
//   GET  /geocode?q=Venlo       address search -> [{label, lat, lon}]
//   POST /plan                  {from:[lon,lat], to:[lon,lat], corridorKm?:5}
//                               -> route + Ionity stations along it, with detour minutes
//   POST /status                {stations:[{id, lat, lon, country}]}
//                               -> live availability per station (NL only in phase 1)
//   GET  /debug/ndw?lat=&lon=   raw Dutch (NDW) data around a point, to tune the parser
//   GET  /debug/ocm-operator    shows which Open Charge Map operator ID is used for Ionity
//   GET  /debug/ocm-ionity      Ionity sites Open Charge Map knows in a box (default: NL)
//   GET  /debug/at?lat=&lon=    raw answer from the Austrian charging register (E-Control)
//   GET  /debug/de?lat=&lon=    raw German answer (MobiData BW OCPDB, AFIR data) plus what we parse from it
//
// Secrets (Cloudflare > Worker > Settings > Variables and Secrets)
//   ORS_API_KEY   OpenRouteService / HeiGIT key
//   OCM_API_KEY   Open Charge Map key
//   ECONTROL_API_KEY  Austrian charging register (E-Control) key
// Optional plain variable
//   OCM_IONITY_OPERATOR_ID   only needed if the automatic lookup fails

const ORS_BASE = "https://api.heigit.org/openrouteservice/v2";
const PELIAS_BASE = "https://api.heigit.org/pelias/v1";
const OCM_BASE = "https://api.openchargemap.io/v3";
const NDW_BBOX = "https://dotnl.ndw.nu/api/rest/geojson/dynamic-road-status/charge-point-data/v1/features";
const ECONTROL_BASE = "https://api.e-control.at/charge/1.0";
// Germany: Open ChargePoint DataBase run by MobiData BW (NVBW). It bundles the AFIR reports
// of operators Germany-wide (Ionity via Eco-Movement), CC0, no key needed.
const OCPDB_LOCATIONS = "https://api.mobidata-bw.de/ocpdb/api/public/v1/locations";
// The E-Control API key is tied to the domains registered with it, checked via the Referer header.
const ECONTROL_REFERER = "https://remconld.github.io/";

// A known Ionity site in Open Charge Map (Ionity Wenningstedt, OCM-301661),
// used to look up Ionity's operator ID automatically.
const OCM_KNOWN_IONITY_POI = 301661;

const ALLOWED_ORIGINS = [
  "https://remconld.github.io",
  "null", // a file opened directly from your laptop
];

const STATUS_TTL_MS = 60 * 1000;
const LIVE_COUNTRIES = new Set(["NL", "AT", "DE"]);
const MAX_DE_LOOKUPS = 12; // Germany: the next 12 sites on the route
const MAX_AT_LOOKUPS = 4; // each Austrian search returns a lot of data; only the next few sites
const MAX_STATUS_LOOKUPS = 30; // stays well under the free plan's outgoing-request limit

// Best-effort in-memory cache. (The Cache API does not work on workers.dev addresses.)
const memo = new Map();
function memoGet(key) {
  const hit = memo.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) { memo.delete(key); return undefined; }
  return hit.value;
}
function memoSet(key, value, ttlMs) {
  memo.set(key, { value, expires: Date.now() + ttlMs });
  if (memo.size > 500) memo.delete(memo.keys().next().value);
}

// ---------------------------------------------------------------- HTTP plumbing

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed =
    ALLOWED_ORIGINS.includes(origin) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(request) },
  });
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function fetchJson(url, init = {}, label = "upstream") {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new HttpError(502, `${label} returned ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); }
  catch { throw new HttpError(502, `${label} did not return JSON`); }
}

// ---------------------------------------------------------------- geometry helpers

const R_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

function haversineKm([lon1, lat1], [lon2, lat2]) {
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(a));
}

// Local flat projection (km) around a reference latitude: fine for short distances.
function toXY([lon, lat], refLat) {
  return [toRad(lon) * R_KM * Math.cos(toRad(refLat)), toRad(lat) * R_KM];
}

function pointSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx, y = a[1] + t * dy;
  return { t, dist: Math.hypot(p[0] - x, p[1] - y) };
}

// Douglas–Peucker: returns the indices to keep (tolerance in km).
function simplifyIndices(coords, tolKm) {
  const n = coords.length;
  if (n <= 2) return coords.map((_, i) => i);
  const refLat = coords[0][1];
  const xy = coords.map((c) => toXY(c, refLat));
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = pointSegment(xy[i], xy[s], xy[e]).dist;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx !== -1 && maxD > tolKm) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

// Google encoded polyline (precision 5), input as [lon, lat].
function encodePolyline(coords) {
  let out = "", prevLat = 0, prevLon = 0;
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lon, lat] of coords) {
    const la = Math.round(lat * 1e5), lo = Math.round(lon * 1e5);
    out += enc(la - prevLat) + enc(lo - prevLon);
    prevLat = la; prevLon = lo;
  }
  return out;
}

// Cumulative km and minutes for every route coordinate.
// Minutes come from the ORS step durations, spread over each step by distance.
function cumulativeProfile(coords, segments) {
  const n = coords.length;
  const km = new Float64Array(n);
  for (let i = 1; i < n; i++) km[i] = km[i - 1] + haversineKm(coords[i - 1], coords[i]);
  const min = new Float64Array(n);
  const steps = (segments || []).flatMap((s) => s.steps || []);
  let filled = 0;
  for (const st of steps) {
    const [a, b] = st.way_points || [];
    if (a == null || b == null || b <= a) continue;
    const stepKm = km[b] - km[a];
    const base = min[a];
    for (let i = a + 1; i <= b; i++) {
      const frac = stepKm > 0 ? (km[i] - km[a]) / stepKm : (i - a) / (b - a);
      min[i] = base + (st.duration / 60) * frac;
    }
    filled = Math.max(filled, b);
  }
  for (let i = filled + 1; i < n; i++) min[i] = min[filled];
  return { km, min };
}

// Where along the route a point lies: index, km and minutes along, and km off the route.
function projectOnRoute(point, route) {
  const { coords, km, min } = route;
  const refLat = point[1];
  const p = toXY(point, refLat);
  let best = { dist: Infinity, i: 0, t: 0 };
  let a = toXY(coords[0], refLat);
  for (let i = 0; i < coords.length - 1; i++) {
    const b = toXY(coords[i + 1], refLat);
    const r = pointSegment(p, a, b);
    if (r.dist < best.dist) best = { dist: r.dist, i, t: r.t };
    a = b;
  }
  const { i, t } = best;
  return {
    index: i,
    offRouteKm: best.dist,
    alongKm: km[i] + t * (km[i + 1] - km[i]),
    alongMin: min[i] + t * (min[i + 1] - min[i]),
  };
}

// Route coordinate roughly `deltaKm` before (negative) or after (positive) a given km.
function pointAtKm(route, targetKm) {
  const { coords, km } = route;
  const k = Math.max(0, Math.min(km[km.length - 1], targetKm));
  let lo = 0, hi = km.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (km[mid] < k) lo = mid + 1; else hi = mid; }
  return coords[lo];
}

// ---------------------------------------------------------------- external services

function orsHeaders(env) {
  return { "Authorization": env.ORS_API_KEY, "Content-Type": "application/json", "Accept": "application/json, application/geo+json" };
}

async function geocode(env, q) {
  try {
    const url = `${PELIAS_BASE}/search?text=${encodeURIComponent(q)}&size=5`;
    const data = await fetchJson(url, { headers: orsHeaders(env) }, "Geocoder");
    const hits = (data.features || []).map((f) => ({
      label: f.properties?.label || f.properties?.name || q,
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
    }));
    if (hits.length) return hits;
  } catch (_) { /* fall back to Nominatim below */ }
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`;
  const data = await fetchJson(url, {
    headers: { "User-Agent": "ionity-route personal app (github.com/RemcoNLD)" },
  }, "Nominatim");
  return data.map((d) => ({ label: d.display_name, lat: +d.lat, lon: +d.lon }));
}

async function getRoute(env, points) {
  const data = await fetchJson(`${ORS_BASE}/directions/driving-car/geojson`, {
    method: "POST",
    headers: orsHeaders(env),
    body: JSON.stringify({ coordinates: points, instructions: true }),
  }, "Routing");
  const f = data.features?.[0];
  if (!f) throw new HttpError(502, "Routing returned no route");
  const coords = f.geometry.coordinates;
  const segments = f.properties?.segments || [];
  const { km, min } = cumulativeProfile(coords, segments);
  const steps = segments.flatMap((s) => s.steps || []);
  // With a via point there are two segments; the via is where the first one ends.
  const firstEnd = segments.length > 1 ? segments[0].steps?.at(-1)?.way_points?.[1] : null;
  return {
    coords, km, min, steps,
    viaKm: firstEnd != null ? km[firstEnd] : null,
    distanceKm: (f.properties?.summary?.distance || 0) / 1000,
    durationMin: (f.properties?.summary?.duration || 0) / 60,
  };
}

// ---------------------------------------------------------------- road numbers

// Pulls a road number out of a street name, e.g. "A 2" -> "A2", "E 19;A 1" -> "E19", "B 179" -> "B179".
// Takes the first one in the name, which usually follows local signage.
function roadRef(name) {
  if (!name || name === "-") return null;
  const m = String(name).match(/\b([AERSMBN])\s?(\d{1,3}[a-z]?)\b/);
  if (m) return `${m[1]}${m[2]}`;
  const de = String(name).match(/autobahn\s?(\d{1,3})\b/i); // "Bundesautobahn 3"
  return de ? `A${de[1]}` : null;
}

// The sequence of numbered roads along the route, with where each starts and ends (km).
function roadsAlong(route) {
  const parts = [];
  for (const st of route.steps) {
    const [a, b] = st.way_points || [];
    if (a == null || b == null) continue;
    const ref = roadRef(st.name);
    if (!ref) continue;
    const from = route.km[a], to = route.km[b];
    const last = parts[parts.length - 1];
    if (last && last.ref === ref && from - last.toKm < 3) last.toKm = to; // same road, short gap (junction)
    else parts.push({ ref, fromKm: from, toKm: to });
  }
  return parts
    .filter((p) => p.toKm - p.fromKm >= 5) // skip short connectors
    .map((p) => ({ ref: p.ref, fromKm: Math.round(p.fromKm * 10) / 10, toKm: Math.round(p.toKm * 10) / 10 }));
}

// The numbered road the route is on at a given coordinate index.
// If the step there has no number (a slip road, a service area), look at steps within 1 km;
// otherwise return nothing rather than a road the station isn't on.
function roadAtIndex(route, index) {
  const at = route.km[index] ?? 0;
  let best = null, bestGap = Infinity;
  for (const st of route.steps) {
    const [a, b] = st.way_points || [];
    if (a == null || b == null) continue;
    const ref = roadRef(st.name);
    if (!ref) continue;
    const gap = index >= a && index <= b ? 0 : Math.min(Math.abs(route.km[a] - at), Math.abs(route.km[b] - at));
    if (gap < bestGap) { bestGap = gap; best = ref; }
  }
  return bestGap <= 1 ? best : null;
}

async function ionityOperatorId(env) {
  if (env.OCM_IONITY_OPERATOR_ID) return Number(env.OCM_IONITY_OPERATOR_ID);
  const cached = memoGet("ocm-ionity-id");
  if (cached) return cached;
  const url = `${OCM_BASE}/poi/?output=json&chargepointid=${OCM_KNOWN_IONITY_POI}&compact=true&verbose=false&key=${env.OCM_API_KEY}`;
  const data = await fetchJson(url, {}, "Open Charge Map");
  const id = data?.[0]?.OperatorID;
  if (!id) throw new HttpError(502, "Could not find Ionity's operator ID in Open Charge Map");
  memoSet("ocm-ionity-id", id, 24 * 3600 * 1000);
  return id;
}

// Ionity sites inside a box: [minLon, minLat, maxLon, maxLat]
async function ionityInBox(env, box) {
  const operatorId = await ionityOperatorId(env);
  const [minLon, minLat, maxLon, maxLat] = box.map((v) => v.toFixed(5));
  const url = `${OCM_BASE}/poi/?output=json&compact=false&verbose=false&maxresults=500` +
    `&operatorid=${operatorId}` +
    `&boundingbox=(${maxLat},${minLon}),(${minLat},${maxLon})&key=${env.OCM_API_KEY}`;
  return fetchJson(url, {}, "Open Charge Map");
}

// Cut the route into pieces of ~150 km, search a box around each piece,
// then keep only sites within the corridor (checked again in handlePlan).
async function ionityAlongRoute(env, route, corridorKm) {
  const marginLat = corridorKm / 111;
  const pieces = [];
  let start = 0;
  for (let i = 1; i < route.coords.length; i++) {
    if (route.km[i] - route.km[start] >= 150 || i === route.coords.length - 1) {
      pieces.push([start, i]);
      start = i;
    }
  }
  const seen = new Map();
  for (const [a, b] of pieces.slice(0, 12)) {
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (let i = a; i <= b; i++) {
      const [lon, lat] = route.coords[i];
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    }
    const marginLon = corridorKm / (111 * Math.cos(toRad((minLat + maxLat) / 2)));
    const pois = await ionityInBox(env, [minLon - marginLon, minLat - marginLat, maxLon + marginLon, maxLat + marginLat]);
    for (const p of pois) seen.set(p.ID, p);
  }
  return [...seen.values()];
}

// Detour in minutes = A->S + S->B - A->B, with A and B on the route 3 km before and after the station.
async function detours(env, route, stations) {
  const result = new Map();
  const chunkSize = 8; // 24 locations per matrix call
  for (let c = 0; c < stations.length; c += chunkSize) {
    const chunk = stations.slice(c, c + chunkSize);
    const locations = [], sources = [], destinations = [];
    chunk.forEach((s, k) => {
      const A = pointAtKm(route, s.alongKm - 3);
      const B = pointAtKm(route, s.alongKm + 3);
      locations.push(A, [s.lon, s.lat], B);
      sources.push(3 * k, 3 * k + 1);
      destinations.push(3 * k + 1, 3 * k + 2);
    });
    try {
      const m = await fetchJson(`${ORS_BASE}/matrix/driving-car`, {
        method: "POST",
        headers: orsHeaders(env),
        body: JSON.stringify({ locations, sources, destinations, metrics: ["duration"] }),
      }, "Matrix");
      chunk.forEach((s, k) => {
        // rows: 2k = A, 2k+1 = S ; columns: 2k = S, 2k+1 = B
        const AS = m.durations?.[2 * k]?.[2 * k];
        const SB = m.durations?.[2 * k + 1]?.[2 * k + 1];
        const AB = m.durations?.[2 * k]?.[2 * k + 1];
        if ([AS, SB, AB].every((v) => typeof v === "number")) {
          result.set(s.id, Math.max(0, Math.round((AS + SB - AB) / 60)));
        }
      });
    } catch (e) {
      console.log("Matrix failed", e.message);
    }
  }
  return result;
}

// ---------------------------------------------------------------- live status (NL)

// NDW GeoJSON: properties.cpo_id ("IOY" for Ionity), properties.operator_name,
// properties.availabilities[] = {available, total, power_type, connector_type, power_max}
function looksLikeIonity(feature) {
  const p = feature.properties || {};
  return p.cpo_id === "IOY" || p.cpo_id === "ION" || /ionity/i.test(p.operator_name || "");
}

// Sums the DC entries (Ionity is DC-only, but this keeps AC out if it ever appears).
function extractCounts(feature) {
  const list = feature.properties?.availabilities || [];
  const valid = list.filter((e) => typeof e.total === "number" && typeof e.available === "number");
  if (!valid.length) return null;
  const dc = valid.filter((e) => String(e.power_type || "").toUpperCase() === "DC");
  const use = dc.length ? dc : valid;
  return {
    available: use.reduce((n, e) => n + e.available, 0),
    total: use.reduce((n, e) => n + e.total, 0),
    maxKw: Math.max(...use.map((e) => (e.power_max || 0) / 1000)) || null,
    lastUpdated: feature.properties?.last_updated || null,
  };
}

// In OCPI, a location's last_updated changes whenever one of its chargers changes status.
// Chargers in use change status regularly; chargers that are out of order stay put.
// So "nothing free and nothing changed for hours" most likely means offline.
const OFFLINE_AFTER_MIN = 180;
function classify(counts) {
  const t = Date.parse(counts.lastUpdated || "");
  const ageMin = Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 60000)) : null;
  let state;
  if (counts.available > 0) state = "free";
  else if (ageMin !== null && ageMin > OFFLINE_AFTER_MIN) state = "likely_offline";
  else state = "full";
  return { state, ageMin };
}

async function ndwFeaturesNear(lat, lon, dLat = 0.004, dLon = 0.006) {
  const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((v) => v.toFixed(6)).join(",");
  const data = await fetchJson(`${NDW_BBOX}?bbox=${bbox}`, { headers: { Accept: "application/json" } }, "NDW");
  return data.features || [];
}

// ---------------------------------------------------------------- live status (AT)

// E-Control: a search returns sites around a point, each with points[] and a status per charger.
async function atStatus(station, env) {
  if (!env.ECONTROL_API_KEY) return null;
  const url = `${ECONTROL_BASE}/search?latitude=${station.lat}&longitude=${station.lon}`;
  const sites = await fetchJson(url, {
    headers: { Accept: "application/json", Apikey: env.ECONTROL_API_KEY, Referer: ECONTROL_REFERER },
  }, "E-Control");
  const ionity = (Array.isArray(sites) ? sites : [])
    .filter((x) => x.operatorId === "IOY" || /ionity/i.test(`${x.operatorName} ${x.label}`))
    .map((x) => ({ x, d: haversineKm([x.location?.lon, x.location?.lat], [station.lon, station.lat]) }))
    .filter((e) => Number.isFinite(e.d) && e.d < 1)
    .sort((a, b) => a.d - b.d);
  if (!ionity.length) return null;
  const points = (ionity[0].x.points || []).filter((p) => !["REMOVED", "PLANNED"].includes(p.status));
  if (!points.length) return null;
  const count = (...st) => points.filter((p) => st.includes(p.status)).length;
  const available = count("AVAILABLE");
  const offline = count("OUTOFORDER", "INOPERATIVE");
  const inUse = count("CHARGING", "BLOCKED", "RESERVED");
  const known = available + offline + inUse;
  const state = available > 0 ? "free"
    : known === 0 ? null                       // every charger "UNKNOWN"
    : offline === known ? "likely_offline"     // reported broken, not guessed
    : "full";
  return {
    available: known ? available : null,
    total: points.length,
    offline,
    maxKw: Math.max(...points.map((p) => p.capacityKw || 0)) || null,
    state,
    source: "E-Control",
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- live status (DE)

const isIonityEvse = (e) => /^DE\*?IO[NY]\*?/i.test(String(e.evse_id || e.uid || "").replace(/\s/g, ""));
const isIonityLoc = (l) =>
  /ionity/i.test(`${l.operator?.name || ""} ${l.owner?.name || ""} ${l.suboperator?.name || ""} ${l.name || ""}`) ||
  (l.evses || []).some(isIonityEvse);

async function deLocationsNear(lat, lon, radius = 400) {
  const url = `${OCPDB_LOCATIONS}?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&radius=${radius}&limit=50`;
  const data = await fetchJson(url, { headers: { Accept: "application/json" } }, "MobiData BW");
  return Array.isArray(data) ? data : (data.items || []);
}

// Summarise the Ionity chargers around one site. The same charger can be reported twice
// (operator feed and the federal register); merge by EVSE ID and prefer a live status.
function summariseDe(locations, station) {
  const ion = locations.filter(isIonityLoc);
  const byId = new Map();
  for (const l of ion) {
    const lon = l.coordinates?.longitude ?? l.coordinates?.lon, lat = l.coordinates?.latitude ?? l.coordinates?.lat;
    if (haversineKm([Number(lon), Number(lat)], [station.lon, station.lat]) > 0.6) continue;
    for (const e of l.evses || []) {
      if (["REMOVED", "PLANNED"].includes(e.status)) continue;
      const id = String(e.evse_id || e.uid || `${l.id}-${byId.size}`).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      const live = e.status && !["STATIC", "UNKNOWN"].includes(e.status);
      const prev = byId.get(id);
      if (prev && prev.live) continue;
      const kw = Math.max(0, ...(e.connectors || []).map((c) => (c.max_electric_power || 0) / 1000));
      byId.set(id, { status: e.status, live, kw, at: e.last_updated || l.last_updated || null });
    }
  }
  let points = [...byId.values()];
  if (!points.length) return null;
  const fast = points.filter((p) => p.kw >= 50);
  if (fast.length) points = fast; // count the fast chargers only, if the site has any
  const withLive = points.filter((p) => p.live);
  if (withLive.length) points = withLive; // register-only duplicates would inflate the total
  const count = (...st) => points.filter((p) => p.live && st.includes(p.status)).length;
  const available = count("AVAILABLE");
  const offline = count("OUTOFORDER", "INOPERATIVE");
  const inUse = count("CHARGING", "BLOCKED", "RESERVED");
  const known = available + offline + inUse;
  const state = known === 0 ? null
    : available > 0 ? "free"
    : offline === known ? "likely_offline"
    : "full";
  return {
    available: known ? available : null,
    total: points.length,
    offline,
    maxKw: Math.round(Math.max(...points.map((p) => p.kw))) || null,
    state,
    source: "MobiData BW (AFIR)",
    checkedAt: new Date().toISOString(),
  };
}

async function deStatus(station) {
  return summariseDe(await deLocationsNear(station.lat, station.lon), station);
}

async function liveStatus(station, env) {
  if (!LIVE_COUNTRIES.has(station.country)) return null;
  if (station.country === "DE") {
    const key = `status:${station.id}`;
    const cached = memoGet(key);
    if (cached !== undefined) return cached;
    let status = null;
    try { status = await deStatus(station); } catch (e) { console.log("MobiData BW failed", station.id, e.message); }
    memoSet(key, status, STATUS_TTL_MS);
    return status;
  }
  if (station.country === "AT") {
    const key = `status:${station.id}`;
    const cached = memoGet(key);
    if (cached !== undefined) return cached;
    let status = null;
    try { status = await atStatus(station, env); } catch (e) { console.log("E-Control failed", station.id, e.message); }
    memoSet(key, status, STATUS_TTL_MS);
    return status;
  }
  const key = `status:${station.id}`;
  const cached = memoGet(key);
  if (cached !== undefined) return cached;
  let status = null;
  try {
    const features = (await ndwFeaturesNear(station.lat, station.lon)).filter(looksLikeIonity);
    if (features.length) {
      features.sort((a, b) =>
        haversineKm(a.geometry.coordinates, [station.lon, station.lat]) -
        haversineKm(b.geometry.coordinates, [station.lon, station.lat]));
      const counts = extractCounts(features[0]);
      status = counts
        ? { ...counts, ...classify(counts), source: "NDW", checkedAt: new Date().toISOString() }
        : { available: null, total: null, source: "NDW", note: "found, but counts not recognised", checkedAt: new Date().toISOString() };
    }
  } catch (e) {
    console.log("NDW failed", station.id, e.message);
  }
  memoSet(key, status, STATUS_TTL_MS);
  return status;
}

async function statusForMany(stations, env) {
  const out = {};
  // Stations arrive in route order, so these are the ones you reach first.
  const nl = stations.filter((s) => s.country === "NL").slice(0, MAX_STATUS_LOOKUPS);
  const at = stations.filter((s) => s.country === "AT").slice(0, MAX_AT_LOOKUPS);
  const de = stations.filter((s) => s.country === "DE").slice(0, MAX_DE_LOOKUPS);
  const list = [...nl, ...de, ...at];
  for (let i = 0; i < list.length; i += 5) { // max 5 at a time (NDW allows 10 per second)
    const batch = list.slice(i, i + 5);
    const res = await Promise.all(batch.map((s) => liveStatus(s, env)));
    batch.forEach((s, k) => { out[s.id] = res[k]; });
  }
  for (const s of stations) if (!(s.id in out)) out[s.id] = null;
  return out;
}

// ---------------------------------------------------------------- handlers

async function handlePlan(request, env) {
  const body = await request.json().catch(() => ({}));
  const { from, to, via } = body;
  const corridorKm = Math.min(Math.max(Number(body.corridorKm) || 5, 1), 15);
  const valid = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  if (!valid(from) || !valid(to)) throw new HttpError(400, "Send from and to as [lon, lat]");
  if (via != null && !valid(via)) throw new HttpError(400, "Send via as [lon, lat]");

  const route = await getRoute(env, via ? [from, via, to] : [from, to]);
  const pois = await ionityAlongRoute(env, route, corridorKm);

  let stations = pois.map((p) => {
    const a = p.AddressInfo || {};
    const proj = projectOnRoute([a.Longitude, a.Latitude], route);
    const maxKw = Math.max(0, ...(p.Connections || []).map((c) => c.PowerKW || 0));
    return {
      id: `ocm-${p.ID}`,
      name: a.Title || "Ionity",
      address: [a.AddressLine1, a.Town].filter(Boolean).join(", "),
      country: a.Country?.ISOCode || null,
      lat: a.Latitude,
      lon: a.Longitude,
      maxKw: maxKw || null,
      points: p.NumberOfPoints || null,
      road: roadAtIndex(route, proj.index),
      alongKm: Math.round(proj.alongKm * 10) / 10,
      alongMin: Math.round(proj.alongMin),
      offRouteKm: Math.round(proj.offRouteKm * 10) / 10,
    };
  });
  stations = stations.filter((s) => s.offRouteKm <= corridorKm);
  stations.sort((a, b) => a.alongKm - b.alongKm);

  const det = await detours(env, route, stations);
  const status = await statusForMany(stations, env);
  stations = stations.map((s) => ({ ...s, detourMin: det.has(s.id) ? det.get(s.id) : null, status: status[s.id] }));

  // Send a lighter route to the app (about 25 m precision), with km and minutes per point.
  const keep = simplifyIndices(route.coords, 0.025);
  return json(request, {
    route: {
      distanceKm: Math.round(route.distanceKm * 10) / 10,
      durationMin: Math.round(route.durationMin),
      viaKm: route.viaKm != null ? Math.round(route.viaKm * 10) / 10 : null,
      roads: roadsAlong(route),
      // A sample of the raw street names, to check the road numbers come through in each country
      debugNames: [...new Set(route.steps.filter((s) => s.distance > 2000).map((s) => s.name))].slice(0, 25),
      coords: keep.map((i) => [+route.coords[i][0].toFixed(5), +route.coords[i][1].toFixed(5)]),
      km: keep.map((i) => Math.round(route.km[i] * 100) / 100),
      min: keep.map((i) => Math.round(route.min[i] * 10) / 10),
    },
    stations,
    generatedAt: new Date().toISOString(),
  });
}

async function handleStatus(request, env) {
  const body = await request.json().catch(() => ({}));
  const stations = Array.isArray(body.stations) ? body.stations : [];
  return json(request, { status: await statusForMany(stations, env), checkedAt: new Date().toISOString() });
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(request) });

  if (path === "/" && request.method === "GET") {
    return json(request, {
      ok: true,
      service: "ionity-route proxy",
      secrets: { ORS_API_KEY: !!env.ORS_API_KEY, OCM_API_KEY: !!env.OCM_API_KEY },
    });
  }
  if (path === "/geocode" && request.method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) throw new HttpError(400, "Add ?q=<place>");
    return json(request, { results: await geocode(env, q) });
  }
  if (path === "/plan" && request.method === "POST") return handlePlan(request, env);
  if (path === "/status" && request.method === "POST") return handleStatus(request, env);

  if (path === "/debug/ndw" && request.method === "GET") {
    const lat = Number(url.searchParams.get("lat")), lon = Number(url.searchParams.get("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new HttpError(400, "Add ?lat=..&lon=..");
    const features = await ndwFeaturesNear(lat, lon);
    return json(request, {
      count: features.length,
      ionity: features.filter(looksLikeIonity).map((f) => ({ parsed: extractCounts(f), raw: f })),
      firstOther: features.find((f) => !looksLikeIonity(f)) || null,
    });
  }
  if (path === "/debug/ocm-ionity" && request.method === "GET") {
    // Default box: the Netherlands. Override with ?box=minLon,minLat,maxLon,maxLat
    const box = (url.searchParams.get("box") || "3.3,50.7,7.3,53.6").split(",").map(Number);
    if (box.length !== 4 || !box.every(Number.isFinite)) throw new HttpError(400, "box=minLon,minLat,maxLon,maxLat");
    const pois = await ionityInBox(env, box);
    return json(request, {
      count: pois.length,
      sites: pois.map((p) => ({
        id: p.ID,
        name: p.AddressInfo?.Title,
        town: p.AddressInfo?.Town,
        country: p.AddressInfo?.Country?.ISOCode,
        lat: p.AddressInfo?.Latitude,
        lon: p.AddressInfo?.Longitude,
      })),
    });
  }
  if (path === "/debug/at" && request.method === "GET") {
    // Raw answer from the Austrian charging register (E-Control) around a point.
    // Extra query parameters (e.g. &radius=2) are passed through unchanged.
    if (!env.ECONTROL_API_KEY) throw new HttpError(500, "ECONTROL_API_KEY is not set");
    const params = new URLSearchParams(url.searchParams);
    if (!params.has("latitude")) params.set("latitude", params.get("lat") || "48.2");
    if (!params.has("longitude")) params.set("longitude", params.get("lon") || "16.37");
    params.delete("lat"); params.delete("lon");
    const base = `${ECONTROL_BASE}/search?${params}`;
    const key = env.ECONTROL_API_KEY;
    const attempts = [
      { how: "header Apikey", url: base, headers: { Apikey: key } },
      { how: "header X-Api-Key", url: base, headers: { "X-Api-Key": key } },
      { how: "query apikey", url: `${base}&apikey=${encodeURIComponent(key)}`, headers: {} },
      { how: "header Authorization", url: base, headers: { Authorization: key } },
    ];
    const tried = [];
    for (const a of attempts) {
      const res = await fetch(a.url, {
        headers: { Accept: "application/json", Referer: ECONTROL_REFERER, ...a.headers },
      });
      const text = await res.text();
      tried.push({ how: a.how, status: res.status, start: text.slice(0, 200) });
      if (res.ok) {
        let body;
        try { body = JSON.parse(text); } catch { body = text.slice(0, 20000); }
        return json(request, { works: a.how, tried, body });
      }
    }
    return json(request, { works: null, tried }, 502);
  }
  if (path === "/debug/de" && request.method === "GET") {
    const lat = Number(url.searchParams.get("lat")), lon = Number(url.searchParams.get("lon"));
    if (!url.searchParams.has("lat")) {
      // No point given: test the Ionity sites Open Charge Map knows around Cologne and the Ruhr.
      const pois = (await ionityInBox(env, [6.4, 50.6, 7.6, 51.6])).slice(0, 6);
      const out = [];
      for (const p of pois) {
        const st = { lat: p.AddressInfo.Latitude, lon: p.AddressInfo.Longitude };
        let parsed = null, error = null;
        try { parsed = await deStatus(st); } catch (e) { error = e.message; }
        out.push({ name: p.AddressInfo.Title, ...st, parsed, error });
      }
      return json(request, { tested: out.length, withLive: out.filter((o) => o.parsed?.state).length, sites: out });
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new HttpError(400, "Add ?lat=..&lon=..");
    const radius = Math.min(Number(url.searchParams.get("radius")) || 400, 5000);
    const locs = await deLocationsNear(lat, lon, radius);
    return json(request, {
      count: locs.length,
      parsed: summariseDe(locs, { lat, lon }),
      ionity: locs.filter(isIonityLoc),
      others: locs.filter((l) => !isIonityLoc(l)).map((l) => ({ name: l.name, operator: l.operator?.name, source: l.source })),
    });
  }
  if (path === "/debug/ocm-operator" && request.method === "GET") {
    return json(request, { ionityOperatorId: await ionityOperatorId(env) });
  }
  throw new HttpError(404, "Unknown endpoint");
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      console.log("Error", status, e.message);
      return json(request, { error: e.message }, status);
    }
  },
};
