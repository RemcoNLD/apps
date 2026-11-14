// EVailability (formerly "Ionity route") – Cloudflare Worker proxy
//
// Endpoints
//   GET  /                      health check: shows which secrets are set
//   GET  /geocode?q=Venlo       address search -> [{label, lat, lon}]
//   POST /plan                  {from:[lon,lat], to:[lon,lat], corridorKm?:5, brands?:["ionity","fastned",…]}
//                               -> route + chargers of those brands along it (detour minutes only when cached)
//   POST /status                {stations:[{id, lat, lon, country, brand}]}
//                               -> live availability per station (NL, DE, AT)
//   POST /detours               {items:[{id, lat, lon, a:[lon,lat], b:[lon,lat]}]} (max 20)
//                               -> detour minutes per charger (a, b: route points 3 km before and after it)
//   GET  /brands                the brands the app can show (key, name, colour)
//   GET  /logo/<brand>          the brand's site icon, fetched from its website and kept 7 days in KV
//   GET  /debug/brands          which Open Charge Map operators each brand matches
//   POST /alternatives          {from, to, tune?} -> up to 3 route options (roads, cities, time, Ionity count)
//   GET  /admin/usage           usage per data source (header Authorization: Bearer <ADMIN_TOKEN>)
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
//   ADMIN_TOKEN   password for the usage page (admin.html)
// Optional KV binding
//   USAGE         keeps the usage counts per day (without it they live in memory only)
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

// ---------------------------------------------------------------- brands
// ocm:  matches Open Charge Map operator titles (to find the operator IDs)
// live: matches operator/owner names in the live sources (NDW, MobiData BW, E-Control)
// evse: matches the start of a charger's EVSE ID ("DE*IOY*…"), a second way to recognise it
// site: the brand's website, for its icon
const BRANDS = [
  { key: "ionity", name: "Ionity", color: "#2b2e83", ocm: /ionity/i, live: /ionity/i, evse: /^[A-Z]{2}\*?IO[NY]\*?/i, site: "ionity.eu" },
  { key: "fastned", name: "Fastned", color: "#ffd200", ocm: /fastned/i, live: /fastned/i, evse: /^[A-Z]{2}\*?FLA\*?/i, site: "fastnedcharging.com" },
  { key: "tesla", name: "Tesla", color: "#e31937", ocm: /tesla/i, live: /tesla/i, evse: /^[A-Z]{2}\*?(TSL|TES)\*?/i, site: "tesla.com" },
  { key: "enbw", name: "EnBW", color: "#000099", ocm: /\benbw\b/i, live: /\benbw\b/i, evse: /^DE\*?EBW\*?/i, site: "enbw.com" },
  { key: "aral", name: "Aral pulse", color: "#0064aa", ocm: /\baral\b/i, live: /\baral\b/i, evse: /^DE\*?(ARL|ARP)\*?/i, site: "aral.de" },
  { key: "shell", name: "Shell Recharge", color: "#dd1d21", ocm: /shell|newmotion/i, live: /shell|newmotion/i, evse: /^[A-Z]{2}\*?(TNM|SHL|SRS)\*?/i, site: "shell.com" },
  // TotalEnergies in every country: NL/BE/DE/FR run as "TotalEnergies Charging Services", "Total EV Charge",
  // "TotalEnergies (FR)", "TotalEnergies Marketing Deutschland" etc. EVSE IDs: xx*TCB (Benelux, FR, DE), FR*HPC (French HPC).
  { key: "total", name: "TotalEnergies", color: "#ed0000", ocm: /\btotal\s*(energies|ev\s*charge)?\b/i, live: /\btotal\s*(energies|ev\s*charge)?\b/i, evse: /^(?:[A-Z]{2}\*?(?:TCB|TOT)|FR\*?HPC)\*?/i, site: "totalenergies.com" },
  { key: "electra", name: "Electra", color: "#00a6a0", ocm: /\belectra\b/i, live: /\belectra\b/i, evse: /^FR\*?ELC\*?/i, site: "go-electra.com" },
  { key: "izivia", name: "Izivia", color: "#00a0dc", ocm: /izivia|corri.?door/i, live: /izivia|corri.?door/i, evse: /^FR\*?(IZI|CDO)\*?/i, site: "izivia.com" },
  { key: "powerdot", name: "Powerdot", color: "#6a2c91", ocm: /power ?dot/i, live: /power ?dot/i, evse: /^[A-Z]{2}\*?PWD\*?/i, site: "powerdot.eu" },
  { key: "allego", name: "Allego", color: "#ff6a13", ocm: /allego/i, live: /allego/i, evse: /^[A-Z]{2}\*?ALL\*?/i, site: "allego.eu" },
];
const BRAND = Object.fromEntries(BRANDS.map((b) => [b.key, b]));
const brandOf = (key) => BRAND[key] || BRAND.ionity;
// Only fast chargers: everything below this is left out for the other brands.
const FAST_KW = 50;

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
  if (memo.size > 3000) memo.delete(memo.keys().next().value);
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
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Access",
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

// ---------------------------------------------------------------- usage counting
// Counts calls per data source and keeps the quota OpenRouteService reports with each answer.
// Saved to KV (binding USAGE) at most every 2 minutes, to stay well within KV's free write limit.
const USAGE_FLUSH_MS = 2 * 60 * 1000;
const usage = { pending: {}, ors: {}, orsHeaders: {}, lastFlush: Date.now(), kvWrites: 0 };
const today = () => new Date().toISOString().slice(0, 10);
function countCall(source, n = 1) { usage.pending[source] = (usage.pending[source] || 0) + n; }
// Every KV read counts against the free plan's 100,000 a day, so it's counted like a call.
function kvGet(env, key) { countCall("KV reads"); return env.USAGE.get(key); }

function orsService(url) {
  const m = String(url).match(/\/v2\/(directions|matrix|isochrones)|\/pelias\/v1\/(search|reverse|autocomplete)/);
  return m ? (m[1] || `geocode/${m[2]}`) : null;
}
function noteQuota(url, res) {
  const svc = orsService(url);
  if (!svc) return;
  // Keep whatever quota-like headers the service sends, to see what it reports.
  const seen = {};
  for (const [k, v] of res.headers) if (/rate|limit|quota|remaining|reset/i.test(k)) seen[k] = v;
  usage.orsHeaders[svc] = { headers: seen, status: res.status, at: new Date().toISOString() };
  const h = (...names) => { for (const n of names) { const v = res.headers.get(n); if (v != null) return v; } return null; };
  const limit = h("x-ratelimit-limit", "ratelimit-limit", "x-rate-limit-limit");
  const remaining = h("x-ratelimit-remaining", "ratelimit-remaining", "x-rate-limit-remaining");
  if (limit == null && remaining == null) return;
  const reset = h("x-ratelimit-reset", "ratelimit-reset", "x-rate-limit-reset");
  usage.ors[svc] = {
    limit: limit != null ? Number(limit) : null,
    remaining: remaining != null ? Number(remaining) : null,
    reset: reset != null ? Number(reset) : null, // as ORS reports it (epoch seconds)
    at: new Date().toISOString(),
  };
}

async function readUsageDay(env, day) {
  if (!env.USAGE) return null;
  try { return JSON.parse((await kvGet(env, `usage:${day}`)) || "null"); } catch { return null; }
}
async function flushUsage(env, force = false) {
  if (!env.USAGE) return;
  if (!force && Date.now() - usage.lastFlush < USAGE_FLUSH_MS) return;
  const pending = usage.pending, ors = usage.ors;
  if (!Object.keys(pending).length && !Object.keys(ors).length) return;
  usage.pending = {}; usage.lastFlush = Date.now();
  const day = today();
  const rec = (await readUsageDay(env, day)) || { day, calls: {}, ors: {} };
  for (const [k, n] of Object.entries(pending)) rec.calls[k] = (rec.calls[k] || 0) + n;
  for (const [k, v] of Object.entries(ors)) if (!rec.ors[k] || rec.ors[k].at < v.at) rec.ors[k] = v;
  rec.orsHeaders = { ...(rec.orsHeaders || {}), ...usage.orsHeaders };
  rec.calls["KV writes"] = (rec.calls["KV writes"] || 0) + 1;
  try {
    await env.USAGE.put(`usage:${day}`, JSON.stringify(rec), { expirationTtl: 40 * 24 * 3600 });
  } catch (e) {
    // Put the counts back so they're not lost.
    for (const [k, n] of Object.entries(pending)) countCall(k, n);
    console.log("Usage save failed", e.message);
  }
}

async function handleUsage(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!env.ADMIN_TOKEN) throw new HttpError(503, "ADMIN_TOKEN is not set in the Worker");
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) throw new HttpError(401, "Wrong password");
  await flushUsage(env, true);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const rec = await readUsageDay(env, d);
    if (rec) days.push(rec);
  }
  return json(request, {
    stored: !!env.USAGE,
    today: today(),
    days,
    // Not saved yet (or no KV): this copy of the Worker's own tally since it started.
    unsaved: { calls: usage.pending, ors: usage.ors },
    orsHeaders: { ...((days[0] && days[0].orsHeaders) || {}), ...usage.orsHeaders },
  });
}

async function fetchJson(url, init = {}, label = "upstream") {
  countCall(label);
  const res = await fetch(url, init);
  noteQuota(url, res);
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
    headers: { "User-Agent": "evailability personal app (github.com/RemcoNLD)" },
  }, "Nominatim");
  return data.map((d) => ({ label: d.display_name, lat: +d.lat, lon: +d.lon }));
}

// The routing service looks for a road within 350 m of each point by default. A GPS fix in a
// car park, a building or off a private road can be further away than that, so allow 5 km.
const SNAP_RADIUS_M = 5000;
const snapRadii = (points) => points.map(() => SNAP_RADIUS_M);

async function getRoute(env, points) {
  const data = await fetchJson(`${ORS_BASE}/directions/driving-car/geojson`, {
    method: "POST",
    headers: orsHeaders(env),
    body: JSON.stringify({ coordinates: points, radiuses: snapRadii(points), instructions: true, extra_info: ["countryinfo"] }),
  }, "Routing");
  const f = data.features?.[0];
  if (!f) throw new HttpError(502, "Routing returned no route");
  const coords = f.geometry.coordinates;
  const segments = f.properties?.segments || [];
  const { km, min } = cumulativeProfile(coords, segments);
  const steps = segments.flatMap((s) => s.steps || []);
  // With a via point there are two segments; the via is where the first one ends.
  const ends = segments.slice(0, -1).map((sg) => sg.steps?.at(-1)?.way_points?.[1]).filter((i) => i != null);
  const firstEnd = ends.length ? ends[0] : null;
  // Which country each part of the route is in (routing service's own country IDs).
  const countrySegs = f.properties?.extras?.countryinfo?.values || [];
  return {
    coords, km, min, steps, countrySegs, idIso: {},
    viaKm: firstEnd != null ? km[firstEnd] : null,
    viaKms: ends.map((i) => km[i]), // one per via point, in order
    distanceKm: (f.properties?.summary?.distance || 0) / 1000,
    durationMin: (f.properties?.summary?.duration || 0) / 60,
  };
}

// ---------------------------------------------------------------- road numbers

// Pulls a road number out of a street name, e.g. "A 2" -> "A2", "E 19;A 1" -> "E19", "B 179" -> "B179".
// Takes the first one in the name, which usually follows local signage.
// Motorways that change number at a border: "NL:A12" continues as "DE:A3", and so on.
const BORDER_CONTINUATIONS = [
  ["NL:A1", "DE:A30"], ["NL:A12", "DE:A3"], ["NL:A67", "DE:A40"], ["NL:A74", "DE:A61"], ["NL:A76", "DE:A4"],
  ["NL:A77", "DE:A57"], ["NL:A7", "DE:A280"], ["NL:A16", "BE:E19"], ["NL:A58", "BE:E34"], ["NL:A4", "BE:A12"],
  ["NL:A2", "BE:E25"], ["NL:A67", "BE:E34"], ["BE:E40", "DE:A44"], ["BE:A3", "DE:A44"], ["BE:E42", "DE:A60"],
  ["BE:E411", "LU:A6"], ["BE:A4", "LU:A6"], ["BE:E19", "FR:A2"], ["BE:A7", "FR:A2"], ["BE:E17", "FR:A22"],
  ["BE:A14", "FR:A22"], ["BE:E40", "FR:A16"], ["BE:A18", "FR:A16"], ["LU:A3", "FR:A31"], ["LU:A13", "DE:A8"],
  ["LU:A1", "DE:A64"], ["DE:A6", "FR:A320"], ["DE:A5", "FR:A36"], ["DE:A5", "CH:A2"], ["DE:A8", "AT:A1"],
  ["DE:A3", "AT:A8"], ["DE:A93", "AT:A12"], ["DE:A7", "AT:B179"], ["DE:A96", "AT:A14"],
];
const CONTINUES = new Map();
for (const [a, b] of BORDER_CONTINUATIONS) {
  for (const [x, y] of [[a, b], [b, a]]) {
    const [cx, rx] = x.split(":"), [cy, ry] = y.split(":");
    CONTINUES.set(`${cx}:${rx}>${cy}`, ry);
  }
}
// Very rough [minLon, minLat, maxLon, maxLat] per country, only to choose between candidates.
const BOXES = {
  NL: [3.3, 50.75, 7.25, 53.6], BE: [2.5, 49.5, 6.4, 51.5], LU: [5.7, 49.45, 6.55, 50.2], DE: [5.8, 47.2, 15.1, 55.1],
  AT: [9.5, 46.4, 17.2, 49.05], CH: [5.9, 45.8, 10.5, 47.8], FR: [-5, 42, 8.25, 51.1],
};
function inBox(iso, [lon, lat]) {
  const b = BOXES[iso];
  return !!b && lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
}
function countryIdAt(route, index) {
  for (const [a, b, id] of route.countrySegs || []) if (index >= a && index <= b) return id;
  return null;
}
const isoAt = (route, index) => route.idIso?.[countryIdAt(route, index)] || null;
// The routing service keeps a road's name past a border (NL A12 carries on as "A12" in Germany).
// Give the number the road has in the country at this index, or nothing if unknown.
function refAt(route, ref, fromIndex, toIndex) {
  const fromId = countryIdAt(route, fromIndex), toId = countryIdAt(route, toIndex);
  if (!ref || fromId === toId || fromId == null || toId == null) return ref;
  const fromIso = route.idIso[fromId], toIso = route.idIso[toId];
  if (!toIso) return null;                       // other country, unknown which: show nothing rather than a wrong number
  if (fromIso) return CONTINUES.get(`${fromIso}:${ref}>${toIso}`) || null;
  // Start country unknown (no charger there): any known continuation into this country.
  for (const [k, v] of CONTINUES) if (k.endsWith(`:${ref}>${toIso}`) && !k.startsWith(`${toIso}:`)) return v;
  return null;
}
// Learn which routing-country ID is which ISO country from the chargers (they carry ISO codes).
function learnCountries(route, points) {
  const votes = {};
  for (const { index, iso } of points) {
    const id = countryIdAt(route, index);
    if (id == null || !iso) continue;
    votes[id] = votes[id] || {};
    votes[id][iso] = (votes[id][iso] || 0) + 1;
  }
  for (const [id, v] of Object.entries(votes)) route.idIso[id] = Object.entries(v).sort((a, b) => b[1] - a[1])[0][0];
  // A country without chargers on the route: a road crossing the border tells which it is
  // ("A12" running into Germany can only have come from the Netherlands).
  for (const st of route.steps || []) {
    const [a, b] = st.way_points || [];
    const ref = roadRef(st.name);
    if (a == null || b == null || !ref) continue;
    const ia = countryIdAt(route, Math.min(a + 1, b)), ib = countryIdAt(route, Math.max(b - 1, a));
    if (ia == null || ib == null || ia === ib) continue;
    const [known, unknown, dir] = route.idIso[ia] && !route.idIso[ib] ? [route.idIso[ia], ib, "from"]
      : !route.idIso[ia] && route.idIso[ib] ? [route.idIso[ib], ia, "to"] : [null];
    if (!known) continue;
    const cands = new Set();
    for (const k of CONTINUES.keys()) {
      const [x, rest] = k.split(":"), [r, y] = rest.split(">");
      if (r !== ref) continue;
      if (dir === "to" && y === known) cands.add(x);   // unknown -> known
      if (dir === "from" && x === known) cands.add(y); // known -> unknown
    }
    let pick = [...cands];
    if (pick.length > 1) {
      // Same number from two directions (A12 into Germany: from NL or AT). Rough boxes settle it.
      const seg = (route.countrySegs || []).find(([, , id]) => id === unknown);
      const c = seg && route.coords?.[Math.round((seg[0] + seg[1]) / 2)];
      if (c) pick = pick.filter((iso) => inBox(iso, c));
    }
    if (pick.length === 1) route.idIso[unknown] = pick[0];
  }
}

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
    const ref0 = roadRef(st.name);
    if (!ref0) continue;
    // Split the step where it crosses a border.
    const pieces = [];
    for (const [sa, sb] of route.countrySegs || []) {
      if (sb <= a || sa >= b) continue;
      const from = Math.max(a, sa), to = Math.min(b, sb);
      if (to > from) pieces.push([from, to]);
    }
    if (!pieces.length) pieces.push([a, b]);
    for (const [x, y] of pieces) {
      const mid = Math.round((x + y) / 2); // border indices belong to both sides; look in the middle
      const iso = isoAt(route, mid);
      const ref = refAt(route, ref0, Math.min(a + 1, b), mid);
      if (!ref) continue;
      const from = route.km[x], to = route.km[y];
      const last = parts[parts.length - 1];
      if (last && last.ref === ref && from - last.toKm < 3) last.toKm = to; // same road, short gap (junction)
      else parts.push({ ref, country: iso, fromKm: from, toKm: to });
    }
  }
  return parts
    .filter((p) => p.toKm - p.fromKm >= 5) // skip short connectors
    .map((p) => ({ ref: p.ref, country: p.country, fromKm: Math.round(p.fromKm * 10) / 10, toKm: Math.round(p.toKm * 10) / 10 }));
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
    const ref = refAt(route, roadRef(st.name), Math.min(a + 1, b), index);
    if (!ref) continue;
    const gap = index >= a && index <= b ? 0 : Math.min(Math.abs(route.km[a] - at), Math.abs(route.km[b] - at));
    if (gap < bestGap) { bestGap = gap; best = ref; }
  }
  return bestGap <= 1 ? best : null;
}

// Open Charge Map operator IDs per brand, looked up by name once a day (and kept 7 days in KV,
// so a fresh copy of the Worker doesn't have to download the whole list again).
async function brandOperators(env) {
  const cached = memoGet("ocm-operators");
  if (cached) return cached;
  let ref = null;
  if (env.USAGE) {
    try { ref = JSON.parse((await kvGet(env, "ocm-ref-v2")) || "null"); } catch { ref = null; }
  }
  if (!ref) {
    const data = await fetchJson(`${OCM_BASE}/referencedata/?output=json&key=${env.OCM_API_KEY}`, {}, "Open Charge Map");
    ref = {
      ops: (data.Operators || []).map((o) => [o.ID, o.Title || ""]),
      countries: Object.fromEntries((data.Countries || []).map((c) => [c.ID, c.ISOCode])),
    };
    if (env.USAGE && ref.ops.length) {
      try { await env.USAGE.put("ocm-ref-v2", JSON.stringify(ref), { expirationTtl: 7 * 24 * 3600 }); countCall("KV writes"); } catch (_) {}
    }
  }
  const ops = ref.ops;
  const byBrand = {};
  for (const b of BRANDS) byBrand[b.key] = ops.filter(([, t]) => b.ocm.test(t)).map(([id, t]) => ({ id, title: t }));
  if (env.OCM_IONITY_OPERATOR_ID) byBrand.ionity = [{ id: Number(env.OCM_IONITY_OPERATOR_ID), title: "IONITY (set by hand)" }];
  if (!byBrand.ionity.length) {
    // Fallback: read Ionity's operator ID off a known Ionity site.
    const url = `${OCM_BASE}/poi/?output=json&chargepointid=${OCM_KNOWN_IONITY_POI}&compact=true&verbose=false&key=${env.OCM_API_KEY}`;
    const id = (await fetchJson(url, {}, "Open Charge Map"))?.[0]?.OperatorID;
    if (!id) throw new HttpError(502, "Could not find Ionity's operator ID in Open Charge Map");
    byBrand.ionity = [{ id, title: "IONITY (via a known site)" }];
  }
  const idToBrand = {};
  for (const [k, list] of Object.entries(byBrand)) for (const o of list) idToBrand[o.id] ??= k;
  const out = { byBrand, idToBrand, countries: ref.countries || {} };
  memoSet("ocm-operators", out, 24 * 3600 * 1000);
  return out;
}

// Is any connector a fast (DC) one? Unknown power counts only when the level says DC fast.
function isFastPoi(p) {
  return (p.Connections || []).some((c) =>
    (c.PowerKW || 0) >= FAST_KW || (c.PowerKW == null && (c.LevelID === 3 || c.CurrentTypeID === 30)));
}

// Charger sites of the given brands inside a box: [minLon, minLat, maxLon, maxLat]
// Open Charge Map blocks bursts of requests (HTTP 429). So: remember answers for an hour
// (charger locations hardly change), pause briefly between calls, and retry once when blocked.
let ocmLastCall = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sitesInBox(env, box, brands = ["ionity"]) {
  const { byBrand, idToBrand, countries } = await brandOperators(env);
  const ids = [...new Set(brands.flatMap((k) => (byBrand[k] || []).map((o) => o.id)))].sort((a, b) => a - b);
  if (!ids.length) return [];
  // Round outward to 0.05° so nearby lookups (route options, rerouting) reuse the same answer.
  const r = (v, up) => (up ? Math.ceil(v * 20) : Math.floor(v * 20)) / 20;
  const [minLon, minLat, maxLon, maxLat] = [r(box[0]), r(box[1]), r(box[2], true), r(box[3], true)];
  const key = `ocm2:${ids.join(",")}:${minLon},${minLat},${maxLon},${maxLat}`;
  const cached = memoGet(key);
  if (cached !== undefined) return cached;
  // Also kept a day in KV, already trimmed: a fresh copy of the Worker then doesn't download
  // and parse thousands of chargers again (that is what runs out of the free plan's CPU and memory).
  if (env.USAGE) {
    try {
      const kv = JSON.parse((await kvGet(env, key)) || "null");
      if (kv) { memoSet(key, kv, 60 * 60 * 1000); return kv; }
    } catch (_) {}
  }
  // compact=true leaves out the repeated reference data (operator, country objects…): far less to parse.
  const url = `${OCM_BASE}/poi/?output=json&compact=true&verbose=false&maxresults=2000` +
    `&operatorid=${ids.join(",")}` +
    `&boundingbox=(${maxLat},${minLon}),(${minLat},${maxLon})&key=${env.OCM_API_KEY}`;
  for (let attempt = 0; ; attempt++) {
    const wait = 250 - (Date.now() - ocmLastCall);
    if (wait > 0) await sleep(wait);
    ocmLastCall = Date.now();
    try {
      const data = await fetchJson(url, {}, "Open Charge Map");
      // Keep only what the app uses, in the same shape as before.
      const list = [];
      for (const p of Array.isArray(data) ? data : []) {
        const brand = idToBrand[p.OperatorID];
        if (!brand || (brand !== "ionity" && !isFastPoi(p))) continue;
        const a = p.AddressInfo || {};
        list.push({
          ID: p.ID, OperatorID: p.OperatorID, NumberOfPoints: p.NumberOfPoints || null, _brand: brand,
          AddressInfo: {
            Title: a.Title, AddressLine1: a.AddressLine1, Town: a.Town, Latitude: a.Latitude, Longitude: a.Longitude,
            Country: { ISOCode: a.Country?.ISOCode || countries[a.CountryID] || null },
          },
          Connections: (p.Connections || []).map((c) => ({ PowerKW: c.PowerKW ?? null })),
        });
      }
      memoSet(key, list, 60 * 60 * 1000);
      if (env.USAGE) {
        try { await env.USAGE.put(key, JSON.stringify(list), { expirationTtl: 24 * 3600 }); countCall("KV writes"); } catch (_) {}
      }
      return list;
    } catch (e) {
      if (attempt < 2 && /returned 429/.test(e.message)) { await sleep(1500 * (attempt + 1)); continue; }
      if (/returned 429/.test(e.message)) {
        throw new HttpError(503, "Open Charge Map is busy (too many requests). Please try again in a minute.");
      }
      throw e;
    }
  }
}
const ionityInBox = (env, box) => sitesInBox(env, box, ["ionity"]);

// Cut the route into pieces of ~150 km, search a box around each piece,
// then keep only sites within the corridor (checked again in handlePlan).
async function sitesAlongRoute(env, route, corridorKm, brands = ["ionity"]) {
  const marginLat = corridorKm / 111;
  const pieces = [];
  let start = 0;
  for (let i = 1; i < route.coords.length; i++) {
    if (route.km[i] - route.km[start] >= 250 || i === route.coords.length - 1) {
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
    const pois = await sitesInBox(env, [minLon - marginLon, minLat - marginLat, maxLon + marginLon, maxLat + marginLat], brands);
    for (const p of pois) seen.set(p.ID, p);
  }
  return [...seen.values()];
}
const ionityAlongRoute = (env, route, corridorKm) => sitesAlongRoute(env, route, corridorKm, ["ionity"]);

// Detour in minutes = A->S + S->B - A->B, with A and B on the route 3 km before and after the station.
// Detour per charger and driving direction, remembered for 6 hours: replanning, rerouting and
// switching route options then don't use the (scarce: 500 a day) matrix quota again.
function detourKeyAB(id, a, b) {
  const bearing = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI + 360) % 360;
  return `det2:${id}:${Math.round(bearing / 45) % 8}`;
}
const detourItem = (route, s) => ({
  id: s.id, lat: s.lat, lon: s.lon,
  a: pointAtKm(route, s.alongKm - 3), b: pointAtKm(route, s.alongKm + 3),
});

// Only what's already known: planning doesn't spend matrix quota. The app asks for the
// rest (POST /detours) when those chargers come into view.
function cachedDetours(route, stations) {
  const result = new Map();
  for (const s of stations) {
    const it = detourItem(route, s);
    const hit = memoGet(detourKeyAB(it.id, it.a, it.b));
    if (hit !== undefined) result.set(s.id, hit);
  }
  return result;
}
// A detour as remembered: {min, toMin, toKm}. min = extra minutes; toMin/toKm = the drive from
// route point A (3 km before) to the charger itself, so the app can show the real way there.

// items: [{id, lat, lon, a:[lon,lat], b:[lon,lat]}]
async function detourItems(env, items) {
  const result = new Map();
  const todo = [];
  for (const it of items) {
    const hit = memoGet(detourKeyAB(it.id, it.a, it.b));
    if (hit !== undefined) result.set(it.id, hit); else todo.push(it);
  }
  // One matrix call computes every source x destination pair: 2n x 2n for n chargers.
  // 20 chargers = 1,600 pairs, well under the public limit of 3,500.
  const chunkSize = 20;
  for (let c = 0; c < todo.length; c += chunkSize) {
    const chunk = todo.slice(c, c + chunkSize);
    const locations = [], sources = [], destinations = [];
    chunk.forEach((it, k) => {
      locations.push(it.a, [it.lon, it.lat], it.b);
      sources.push(3 * k, 3 * k + 1);
      destinations.push(3 * k + 1, 3 * k + 2);
    });
    try {
      const m = await fetchJson(`${ORS_BASE}/matrix/driving-car`, {
        method: "POST",
        headers: orsHeaders(env),
        body: JSON.stringify({ locations, sources, destinations, metrics: ["duration", "distance"] }),
      }, "Matrix");
      chunk.forEach((it, k) => {
        // rows: 2k = A, 2k+1 = S ; columns: 2k = S, 2k+1 = B
        const AS = m.durations?.[2 * k]?.[2 * k];
        const SB = m.durations?.[2 * k + 1]?.[2 * k + 1];
        const AB = m.durations?.[2 * k]?.[2 * k + 1];
        const ASm = m.distances?.[2 * k]?.[2 * k]; // metres
        if ([AS, SB, AB].every((v) => typeof v === "number")) {
          const d = {
            min: Math.max(0, Math.round((AS + SB - AB) / 60)),
            toMin: Math.round(AS / 6) / 10,
            toKm: typeof ASm === "number" ? Math.round(ASm / 100) / 10 : null,
          };
          result.set(it.id, d);
          memoSet(detourKeyAB(it.id, it.a, it.b), d, 6 * 3600 * 1000);
        }
      });
    } catch (e) {
      console.log("Matrix failed", e.message);
    }
  }
  return result;
}
const detours = (env, route, stations) => detourItems(env, stations.map((s) => detourItem(route, s)));

// ---------------------------------------------------------------- live status (NL)

// NDW GeoJSON: properties.cpo_id ("IOY" for Ionity), properties.operator_name,
// properties.availabilities[] = {available, total, power_type, connector_type, power_max}
function featureIsBrand(feature, brand) {
  const p = feature.properties || {};
  const names = `${p.operator_name || ""} ${p.owner_name || ""} ${p.suboperator_name || ""}`;
  return brand.live.test(names) || brand.evse.test(`${p.country_code || "XX"}*${p.cpo_id || ""}*`) ||
    brand.evse.test(String(feature.id || "").replace(/^([A-Z]{2})-([A-Z0-9]{3})-.*/, "$1*$2*"));
}
const looksLikeIonity = (feature) => featureIsBrand(feature, BRAND.ionity);

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
// When things last changed, as far as the source tells: NDW only knows when the site last changed.
function ndwTimes(counts) {
  const at = counts.lastUpdated || null;
  return { changedAt: at, fullSince: counts.available === 0 ? at : null };
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

// "Ohligser Heide West" vs "... Ost": names that point to different sides of the road.
const SIDE_WORDS = /\b(nord|north|süd|sued|south|ost|east|west|richtung\s+\S+)\b/gi;
function oppositeSides(a, b) {
  const wa = (String(a).match(SIDE_WORDS) || []).map((w) => w.toLowerCase()).sort().join("|");
  const wb = (String(b).match(SIDE_WORDS) || []).map((w) => w.toLowerCase()).sort().join("|");
  return wa !== wb && (wa || wb) !== "";
}

// E-Control: a search returns sites around a point, each with points[] and a status per charger.
async function atStatus(station, env, brand = BRAND.ionity) {
  if (!env.ECONTROL_API_KEY) return null;
  const url = `${ECONTROL_BASE}/search?latitude=${station.lat}&longitude=${station.lon}`;
  const sites = await fetchJson(url, {
    headers: { Accept: "application/json", Apikey: env.ECONTROL_API_KEY, Referer: ECONTROL_REFERER },
  }, "E-Control");
  const mine = (Array.isArray(sites) ? sites : [])
    .filter((x) => brand.live.test(`${x.operatorName || ""} ${x.label || ""}`) || brand.evse.test(`AT*${x.operatorId || ""}*`))
    .map((x) => ({ x, d: haversineKm([x.location?.lon, x.location?.lat], [station.lon, station.lat]) }))
    .filter((e) => Number.isFinite(e.d) && e.d < 1)
    .sort((a, b) => a.d - b.d);
  if (!mine.length) return null;
  // Some places have two sites of the brand side by side (e.g. Nassereith). Count those together,
  // but not a site whose name says it is on the other side of the road (Nord/Süd, Ost/West).
  const nearest = mine[0];
  const nearby = mine.filter((e) => e === nearest ||
    (e.d <= nearest.d + 0.3 && !oppositeSides(`${nearest.x.label} ${nearest.x.name || ""}`, `${e.x.label} ${e.x.name || ""}`)));
  let points = nearby.flatMap((e) => e.x.points || []).filter((p) => !["REMOVED", "PLANNED"].includes(p.status));
  const fastAt = points.filter((p) => (p.capacityKw || 0) >= FAST_KW);
  if (fastAt.length) points = fastAt; // count the fast chargers only, if the site has any
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
  const ts = (p) => Date.parse(p.lastUpdated || p.last_updated || p.statusTimestamp || p.timestamp || "");
  const changedMs = points.map(ts).filter(Number.isFinite).reduce((a, b) => Math.max(a, b), 0) || null;
  const takenMs = points.filter((p) => ["CHARGING", "BLOCKED", "RESERVED"].includes(p.status)).map(ts)
    .filter(Number.isFinite).reduce((a, b) => Math.max(a, b), 0) || null;
  return {
    available: known ? available : null,
    total: points.length,
    offline,
    maxKw: Math.max(...points.map((p) => p.capacityKw || 0)) || null,
    state,
    changedAt: changedMs ? new Date(changedMs).toISOString() : null,
    fullSince: state === "full" && takenMs ? new Date(takenMs).toISOString() : null,
    source: "E-Control",
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- live status (DE)

const isBrandEvse = (e, brand) => brand.evse.test(String(e.evse_id || e.uid || "").replace(/\s/g, ""));
const isBrandLoc = (l, brand) =>
  brand.live.test(`${l.operator?.name || ""} ${l.owner?.name || ""} ${l.suboperator?.name || ""} ${l.name || ""}`) ||
  (l.evses || []).some((e) => isBrandEvse(e, brand));
const isIonityLoc = (l) => isBrandLoc(l, BRAND.ionity);

async function deLocationsNear(lat, lon, radius = 400) {
  const url = `${OCPDB_LOCATIONS}?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&radius=${radius}&limit=50`;
  const data = await fetchJson(url, { headers: { Accept: "application/json" } }, "MobiData BW");
  return Array.isArray(data) ? data : (data.items || []);
}

// Summarise the Ionity chargers around one site. The same charger can be reported twice
// (operator feed and the federal register); merge by EVSE ID and prefer a live status.
function summariseDe(locations, station, brand = BRAND.ionity) {
  const dist = (l) => haversineKm(
    [Number(l.coordinates?.longitude ?? l.coordinates?.lon), Number(l.coordinates?.latitude ?? l.coordinates?.lat)],
    [station.lon, station.lat]);
  const ion = locations.filter((l) => isBrandLoc(l, brand)).map((l) => ({ l, d: dist(l) })).filter((x) => x.d <= 0.6);
  if (!ion.length) return null;
  // Motorway sites often have one site per side (e.g. "West" and "Ost"), a few hundred metres apart.
  // Keep only the entries close to the nearest one, so the other side is not counted in.
  const nearest = Math.min(...ion.map((x) => x.d));
  const byId = new Map();
  for (const { l, d } of ion) {
    if (d > nearest + 0.08) continue;
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
  const fast = points.filter((p) => p.kw >= FAST_KW);
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
  // Per charger: when its status last changed. Full since = the last one that got taken.
  const latest = (list) => list.map((p) => Date.parse(p.at || "")).filter(Number.isFinite).reduce((a, b) => Math.max(a, b), 0) || null;
  const changed = latest(points.filter((p) => p.live));
  const takenAt = latest(points.filter((p) => p.live && ["CHARGING", "BLOCKED", "RESERVED"].includes(p.status)));
  return {
    available: known ? available : null,
    total: points.length,
    offline,
    maxKw: Math.round(Math.max(...points.map((p) => p.kw))) || null,
    state,
    changedAt: changed ? new Date(changed).toISOString() : null,
    fullSince: state === "full" && takenAt ? new Date(takenAt).toISOString() : null,
    source: "MobiData BW (AFIR)",
    checkedAt: new Date().toISOString(),
  };
}

async function deStatus(station, brand = BRAND.ionity) {
  return summariseDe(await deLocationsNear(station.lat, station.lon), station, brand);
}

async function liveStatus(station, env) {
  if (!LIVE_COUNTRIES.has(station.country)) return null;
  const brand = brandOf(station.brand);
  const key = `status:${station.id}`;
  const cached = memoGet(key);
  if (cached !== undefined) return cached;
  let status = null;
  if (station.country === "DE") {
    try { status = await deStatus(station, brand); } catch (e) { console.log("MobiData BW failed", station.id, e.message); }
  } else if (station.country === "AT") {
    try { status = await atStatus(station, env, brand); } catch (e) { console.log("E-Control failed", station.id, e.message); }
  } else {
    try {
      const features = (await ndwFeaturesNear(station.lat, station.lon)).filter((f) => featureIsBrand(f, brand));
      if (features.length) {
        features.sort((a, b) =>
          haversineKm(a.geometry.coordinates, [station.lon, station.lat]) -
          haversineKm(b.geometry.coordinates, [station.lon, station.lat]));
        const counts = extractCounts(features[0]);
        status = counts
          ? { ...counts, ...classify(counts), ...ndwTimes(counts), source: "NDW", checkedAt: new Date().toISOString() }
          : { available: null, total: null, source: "NDW", note: "found, but counts not recognised", checkedAt: new Date().toISOString() };
      }
    } catch (e) {
      console.log("NDW failed", station.id, e.message);
    }
  }
  if (status && status.state) {
    try { status = { ...status, ...(await observe(env, station.id, status.state)) }; } catch (_) {}
  }
  memoSet(key, status, STATUS_TTL_MS);
  return status;
}

// What this app has seen itself: since when the current state holds, and when it was last full.
// Only written to KV when the state changes (a few times an hour at most per charger).
async function observe(env, id, nowState) {
  const key = `hist:${id}`;
  let h = memoGet(key);
  if (h === undefined && env.USAGE) {
    try { h = JSON.parse((await kvGet(env, key)) || "null"); } catch { h = null; }
  }
  const now = new Date().toISOString();
  if (!h || h.state !== nowState) {
    const next = {
      state: nowState,
      since: h ? now : null, // first sighting: we don't know since when
      lastFullAt: h?.state === "full" ? now : h?.lastFullAt || null,
    };
    h = next;
    if (env.USAGE) {
      try { await env.USAGE.put(key, JSON.stringify(h), { expirationTtl: 2 * 24 * 3600 }); countCall("KV writes"); } catch (_) {}
    }
  }
  memoSet(key, h, 24 * 3600 * 1000);
  return { seenSince: h.since, lastFullAt: nowState === "full" ? now : h.lastFullAt };
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
  // via: one point [lon, lat] or a list of up to 3 points
  const vias = via == null ? [] : valid(via) ? [via] : Array.isArray(via) ? via : null;
  if (!vias || vias.length > 3 || !vias.every(valid)) throw new HttpError(400, "Send via as [lon, lat] or a list of up to 3 of them");

  const brands = [...new Set((Array.isArray(body.brands) ? body.brands : ["ionity"]).filter((k) => BRAND[k]))];
  if (!brands.length) brands.push("ionity");

  const route = await getRoute(env, [from, ...vias, to]);
  const pois = await sitesAlongRoute(env, route, corridorKm, brands);
  learnCountries(route, pois.map((p) => ({
    index: projectOnRoute([p.AddressInfo?.Longitude, p.AddressInfo?.Latitude], route).index,
    iso: p.AddressInfo?.Country?.ISOCode,
  })));

  let stations = pois.map((p) => {
    const a = p.AddressInfo || {};
    const proj = projectOnRoute([a.Longitude, a.Latitude], route);
    const maxKw = Math.max(0, ...(p.Connections || []).map((c) => c.PowerKW || 0));
    return {
      id: `ocm-${p.ID}`,
      brand: p._brand || "ionity",
      name: a.Title || brandOf(p._brand).name,
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

  // Detours only from what's cached: the app asks for the rest (and for live status)
  // for the chargers it shows. With many brands, asking for everything would waste quota.
  const det = cachedDetours(route, stations);
  // Only the first few (the ones on screen right after planning); the app fetches the rest itself.
  const first = stations.slice(0, 8);
  const status = await statusForMany(first, env);
  const checked = new Set(first.filter((s) => status[s.id] != null || !LIVE_COUNTRIES.has(s.country)).map((s) => s.id));
  stations = stations.map((s) => {
    const out = { ...s, status: status[s.id] ?? null, statusChecked: checked.has(s.id) };
    if (det.has(s.id)) { const d = det.get(s.id); out.detourMin = d.min; out.toMin = d.toMin; out.toKm = d.toKm; }
    return out;
  });

  // Send a lighter route to the app (about 25 m precision), with km and minutes per point.
  const keep = simplifyIndices(route.coords, 0.025);
  return json(request, {
    route: {
      distanceKm: Math.round(route.distanceKm * 10) / 10,
      durationMin: Math.round(route.durationMin),
      viaKm: route.viaKm != null ? Math.round(route.viaKm * 10) / 10 : null,
      viaKms: (route.viaKms || []).map((k) => Math.round(k * 10) / 10),
      roads: roadsAlong(route),
      // A sample of the raw street names, to check the road numbers come through in each country
      borders: (route.countrySegs || []).map(([a, b, id]) => ({ fromKm: Math.round(route.km[a]), toKm: Math.round(route.km[b]), id, iso: route.idIso[id] || null })),
      debugNames: [...new Set(route.steps.filter((s) => s.distance > 2000).map((s) => s.name))].slice(0, 25),
      coords: keep.map((i) => [+route.coords[i][0].toFixed(5), +route.coords[i][1].toFixed(5)]),
      km: keep.map((i) => Math.round(route.km[i] * 100) / 100),
      min: keep.map((i) => Math.round(route.min[i] * 10) / 10),
    },
    stations,
    brands,
    generatedAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------- route options

// The routing service only gives alternatives below 100 km, so we make our own: plan through
// points left and right of the fastest route, keep the ones that use different main roads.
const ALT_DEFAULTS = { fractions: [0.33, 0.66], offsetKm: 40, maxSlower: 1.25, mainRoadKm: 30 };

// Big cities, so a card says "Frankfurt" rather than the village at the junction.
const MAJOR_CITIES = [ // [tier (1 = largest), name, lat, lon]
  [1,'Amsterdam',52.37,4.90], [1,'Rotterdam',51.92,4.48], [1,'Den Haag',52.08,4.30], [2,'Utrecht',52.09,5.12],
  [2,'Eindhoven',51.44,5.47], [2,'Groningen',53.22,6.57], [2,'Tilburg',51.56,5.09], [2,'Almere',52.37,5.21],
  [2,'Breda',51.59,4.78], [2,'Nijmegen',51.84,5.86], [2,'Arnhem',51.98,5.91], [3,'Enschede',52.22,6.89],
  [3,'Zwolle',52.51,6.09], [3,'Amersfoort',52.16,5.39], [3,'Apeldoorn',52.21,5.97], [3,"'s-Hertogenbosch",51.69,5.30],
  [3,'Maastricht',50.85,5.69], [3,'Venlo',51.37,6.17], [3,'Heerlen',50.89,5.98], [1,'Brussels',50.85,4.35],
  [1,'Antwerp',51.22,4.40], [2,'Ghent',51.05,3.72], [2,'Liège',50.63,5.57], [2,'Charleroi',50.41,4.44],
  [3,'Namur',50.47,4.87], [3,'Leuven',50.88,4.70], [3,'Hasselt',50.93,5.34], [3,'Bruges',51.21,3.22],
  [3,'Mons',50.45,3.95], [3,'Arlon',49.68,5.81], [2,'Luxembourg',49.61,6.13], [1,'Berlin',52.52,13.40],
  [1,'Hamburg',53.55,9.99], [1,'Munich',48.14,11.58], [1,'Cologne',50.94,6.96], [1,'Frankfurt',50.11,8.68],
  [1,'Stuttgart',48.78,9.18], [1,'Düsseldorf',51.23,6.78], [1,'Dortmund',51.51,7.47], [1,'Essen',51.46,7.01],
  [1,'Leipzig',51.34,12.37], [1,'Bremen',53.08,8.80], [1,'Dresden',51.05,13.74], [1,'Hannover',52.37,9.73],
  [1,'Nuremberg',49.45,11.08], [2,'Duisburg',51.43,6.76], [2,'Bochum',51.48,7.22], [2,'Wuppertal',51.26,7.15],
  [2,'Bielefeld',52.02,8.53], [2,'Bonn',50.74,7.10], [2,'Münster',51.96,7.63], [2,'Mannheim',49.49,8.47],
  [2,'Karlsruhe',49.01,8.40], [2,'Augsburg',48.37,10.90], [2,'Wiesbaden',50.08,8.24], [2,'Mönchengladbach',51.19,6.44],
  [2,'Gelsenkirchen',51.51,7.10], [2,'Aachen',50.78,6.08], [2,'Braunschweig',52.27,10.52], [2,'Kiel',54.32,10.13],
  [2,'Chemnitz',50.83,12.92], [2,'Halle',51.48,11.97], [2,'Magdeburg',52.13,11.63], [2,'Freiburg',47.99,7.85],
  [2,'Krefeld',51.33,6.56], [2,'Mainz',50.00,8.27], [2,'Lübeck',53.87,10.69], [2,'Erfurt',50.98,11.03],
  [2,'Oberhausen',51.47,6.85], [2,'Rostock',54.09,12.10], [2,'Kassel',51.31,9.48], [3,'Hagen',51.36,7.47],
  [3,'Potsdam',52.39,13.06], [3,'Saarbrücken',49.24,7.00], [3,'Hamm',51.68,7.82], [3,'Ludwigshafen',49.48,8.44],
  [3,'Oldenburg',53.14,8.21], [3,'Osnabrück',52.28,8.05], [3,'Leverkusen',51.03,6.98], [3,'Darmstadt',49.87,8.65],
  [3,'Heidelberg',49.40,8.69], [3,'Regensburg',49.01,12.10], [3,'Paderborn',51.72,8.75], [3,'Ingolstadt',48.77,11.43],
  [3,'Würzburg',49.79,9.95], [3,'Ulm',48.40,9.99], [3,'Heilbronn',49.14,9.22], [3,'Pforzheim',48.89,8.70],
  [3,'Wolfsburg',52.42,10.79], [3,'Göttingen',51.54,9.93], [3,'Koblenz',50.36,7.59], [3,'Trier',49.75,6.64],
  [3,'Kaiserslautern',49.44,7.77], [3,'Siegen',50.87,8.02], [3,'Gießen',50.58,8.68], [3,'Fulda',50.55,9.68],
  [3,'Bamberg',49.89,10.89], [3,'Bayreuth',49.95,11.58], [3,'Passau',48.57,13.43], [3,'Rosenheim',47.86,12.12],
  [3,'Kempten',47.73,10.31], [3,'Memmingen',47.99,10.18], [3,'Hanau',50.13,8.92], [3,'Aschaffenburg',49.97,9.15],
  [3,'Erlangen',49.59,11.00], [3,'Offenburg',48.47,7.94], [3,'Lindau',47.55,9.68], [1,'Vienna',48.21,16.37],
  [2,'Graz',47.07,15.44], [2,'Linz',48.31,14.29], [2,'Salzburg',47.81,13.04], [2,'Innsbruck',47.27,11.39],
  [3,'Klagenfurt',46.62,14.31], [3,'Villach',46.61,13.85], [3,'Bregenz',47.50,9.75], [3,'Wels',48.16,14.03],
  [3,'Kufstein',47.58,12.17], [3,'Landeck',47.14,10.57], [3,'Imst',47.24,10.74], [1,'Paris',48.86,2.35],
  [1,'Lyon',45.76,4.84], [1,'Marseille',43.30,5.37], [2,'Lille',50.63,3.06], [2,'Strasbourg',48.58,7.75],
  [2,'Metz',49.12,6.18], [2,'Nancy',48.69,6.18], [2,'Reims',49.26,4.03], [2,'Mulhouse',47.75,7.34],
  [2,'Dijon',47.32,5.04], [3,'Valenciennes',50.36,3.52], [3,'Amiens',49.89,2.30], [3,'Besançon',47.24,6.02],
  [3,'Colmar',48.08,7.36], [3,'Calais',50.95,1.86], [3,'Dunkerque',51.03,2.38], [1,'Zürich',47.37,8.54],
  [2,'Basel',47.56,7.59], [2,'Bern',46.95,7.45], [2,'Geneva',46.20,6.15], [3,'Lausanne',46.52,6.63],
  [3,'Lucerne',47.05,8.31], [3,'St. Gallen',47.42,9.38], [3,'Chur',46.85,9.53], [3,'Bolzano',46.50,11.35],
  [2,'Verona',45.44,10.99], [1,'Milan',45.46,9.19],
];

const flatKm = ([lon1, lat1], [lon2, lat2]) =>
  Math.hypot((lon2 - lon1) * 111.3 * Math.cos(toRad((lat1 + lat2) / 2)), (lat2 - lat1) * 111.3);

// The best-known city near a point: nearest wins, but a bigger city counts as closer
// (a junction near Mainz stays Mainz; one between villages becomes Frankfurt).
function bigCityNear(p, maxKm = 25) {
  let best = null;
  for (const [tier, name, lat, lon] of MAJOR_CITIES) {
    const d = flatKm(p, [lon, lat]);
    if (d > maxKm) continue;
    const score = d * (tier === 1 ? 0.5 : tier === 2 ? 0.75 : 1);
    if (!best || score < best.score) best = { name, score };
  }
  return best?.name || null;
}

// Big cities a stretch of road passes close by, in driving order.
function bigCitiesAlong(route, fromKm, toKm) {
  const hits = new Map();
  for (let k = fromKm; k <= toKm + 2; k += 2) {
    const p = pointAtKm(route, Math.min(k, toKm));
    for (const [tier, name, lat, lon] of MAJOR_CITIES) {
      if (hits.has(name)) continue;
      const reach = tier === 1 ? 12 : tier === 2 ? 8 : 5; // ring roads pass big cities further out
      if (flatKm(p, [lon, lat]) <= reach) hits.set(name, k);
    }
  }
  return [...hits.entries()].sort((a, b) => a[1] - b[1]).map(([n]) => n);
}

// A cheap route (simplified geometry, no country info) only to discover a corridor.
async function roughRoute(env, points) {
  const data = await fetchJson(`${ORS_BASE}/directions/driving-car/geojson`, {
    method: "POST",
    headers: orsHeaders(env),
    body: JSON.stringify({ coordinates: points, radiuses: snapRadii(points), instructions: true, geometry_simplify: true }),
  }, "Routing");
  const f = data.features?.[0];
  if (!f) throw new HttpError(502, "Routing returned no route");
  const steps = (f.properties?.segments || []).flatMap((x) => x.steps || []);
  return {
    coords: f.geometry.coordinates, steps,
    distanceKm: (f.properties?.summary?.distance || 0) / 1000,
    durationMin: (f.properties?.summary?.duration || 0) / 60,
  };
}

// The main roads of a route in order (driven at least mainRoadKm), e.g. "A12>A3>A5".
function mainRoads(steps, mainRoadKm) {
  const km = new Map(), order = [];
  for (const st of steps) {
    const ref = roadRef(st.name);
    if (!ref || ref[0] === "E") continue; // E-numbers run alongside national numbers; skip them here
    if (!km.has(ref)) { km.set(ref, 0); order.push(ref); }
    km.set(ref, km.get(ref) + (st.distance || 0) / 1000);
  }
  return order.filter((r) => km.get(r) >= mainRoadKm).join(">");
}

// A point offKm to the left (+) or right (-) of the route, fraction f of the way along.
function offsetPoint(route, f, offKm) {
  const at = route.distanceKm * f;
  const [lon, lat] = pointAtKm(route, at);
  const a = pointAtKm(route, at - 10), b = pointAtKm(route, at + 10);
  const kx = 111 * Math.cos(toRad(lat)), ky = 111;
  const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky;
  const len = Math.hypot(dx, dy) || 1;
  // left normal of the driving direction
  return [lon + (-dy / len) * offKm / kx, lat + (dx / len) * offKm / ky];
}

// Where the detour route runs on a numbered main road closest to the help point: plan through
// that spot instead, so the chosen route has no side trip to a field somewhere.
function snapToMainRoad(rough, p) {
  let best = null, bestD = Infinity;
  for (const st of rough.steps) {
    const ref = roadRef(st.name);
    if (!ref || !/^[AESBN]/.test(ref)) continue;
    const [a, b] = st.way_points || [];
    for (let i = a; i <= b && i < rough.coords.length; i++) {
      const d = haversineKm(rough.coords[i], p);
      if (d < bestD) { bestD = d; best = rough.coords[i]; }
    }
  }
  return best;
}

async function placeName(env, [lon, lat]) {
  const key = `place:${lon.toFixed(2)},${lat.toFixed(2)}`;
  const cached = memoGet(key);
  if (cached !== undefined) return cached;
  let name = null;
  try {
    const url = `${PELIAS_BASE}/reverse?point.lat=${lat}&point.lon=${lon}&size=1&layers=locality,localadmin`;
    const data = await fetchJson(url, { headers: orsHeaders(env) }, "Geocoder");
    const p = data.features?.[0]?.properties;
    name = p?.locality || p?.localadmin || p?.name || null;
  } catch (_) { /* a card without a town name is fine */ }
  memoSet(key, name, 24 * 3600 * 1000);
  return name;
}

async function describeOption(env, route, via, pois, maxCities = 4) {
  learnCountries(route, pois.map((p) => ({
    index: projectOnRoute([p.AddressInfo?.Longitude, p.AddressInfo?.Latitude], route).index,
    iso: p.AddressInfo?.Country?.ISOCode,
  })));
  const parts = roadsAlong(route).filter((r, i, a) => r.ref !== a[i - 1]?.ref);
  // Per road: the big city where you join it (not for the first road: that's where you start),
  // then the big cities it passes. Only when no big city is near: the local town name.
  const lookups = [];
  parts.forEach((r, i) => {
    const long = r.toKm - r.fromKm >= 25;
    const join = i > 0 && long ? bigCityNear(pointAtKm(route, r.fromKm + 1)) : null;
    const along = long ? bigCitiesAlong(route, r.fromKm, r.toKm) : [];
    r.cities = [...new Set([join, ...along].filter(Boolean))].slice(0, 3);
    if (!r.cities.length && i > 0 && long && lookups.length < maxCities) lookups.push(i);
  });
  const names = await Promise.all(lookups.map((i) => placeName(env, pointAtKm(route, parts[i].fromKm + 1))));
  lookups.forEach((i, k) => { if (names[k]) parts[i].cities = [names[k]]; });
  const ionity = pois.filter((p) =>
    projectOnRoute([p.AddressInfo?.Longitude, p.AddressInfo?.Latitude], route).offRouteKm <= 5).length;
  return {
    via, ionity,
    distanceKm: Math.round(route.distanceKm),
    durationMin: Math.round(route.durationMin),
    roads: parts.map((r) => ({ ref: r.ref, country: r.country, cities: r.cities || [] })),
    signature: mainRoads(route.steps, ALT_DEFAULTS.mainRoadKm),
  };
}

async function handleAlternatives(request, env) {
  const body = await request.json().catch(() => ({}));
  const { from, to } = body;
  const valid = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  if (!valid(from) || !valid(to)) throw new HttpError(400, "Send from and to as [lon, lat]");
  const t = { ...ALT_DEFAULTS, ...(body.tune || {}) };

  const fastest = await getRoute(env, [from, to]);
  const baseSig = mainRoads(fastest.steps, t.mainRoadKm);

  // Try points left and right of the fastest route.
  const tries = [];
  for (const f of t.fractions) for (const side of [1, -1]) tries.push(offsetPoint(fastest, f, side * t.offsetKm));
  const rough = await Promise.all(tries.map((p) => roughRoute(env, [from, p, to]).then((r) => ({ r, p })).catch(() => null)));

  // Keep corridors that use different main roads and aren't much slower; best first.
  const seen = new Set([baseSig]);
  const picks = [];
  for (const x of rough.filter(Boolean).sort((a, b) => a.r.durationMin - b.r.durationMin)) {
    if (x.r.durationMin > fastest.durationMin * t.maxSlower) continue;
    const sig = mainRoads(x.r.steps, t.mainRoadKm);
    if (!sig || seen.has(sig)) continue;
    const via = snapToMainRoad(x.r, x.p);
    if (!via) continue;
    seen.add(sig);
    picks.push(via);
    if (picks.length >= 2) break;
  }

  // Plan the kept ones properly through the snapped point.
  const routes = await Promise.all(picks.map((v) => getRoute(env, [from, v, to]).then((r) => ({ r, v })).catch(() => null)));

  // Ionity sites per route, looked up in sections along each one (one big area gets cut short).
  const all = [{ r: fastest, v: null }, ...routes.filter(Boolean)];
  const found = new Map();
  for (const { r } of all) {
    try { for (const p of await ionityAlongRoute(env, r, 5)) found.set(p.ID, p); } catch (_) {}
  }
  const pois = [...found.values()];

  const options = [];
  for (const { r, v } of all) {
    if (v && r.durationMin > fastest.durationMin * t.maxSlower) continue;
    const o = await describeOption(env, r, v, pois);
    if (v && options.some((x) => x.signature === o.signature)) continue; // snapping made it the same road after all
    options.push(o);
  }
  return json(request, { options, tried: tries.length, generatedAt: new Date().toISOString() });
}

async function handleDetours(request, env) {
  const body = await request.json().catch(() => ({}));
  const ok = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  const items = (Array.isArray(body.items) ? body.items : [])
    .filter((it) => it && typeof it.id === "string" && Number.isFinite(it.lat) && Number.isFinite(it.lon) && ok(it.a) && ok(it.b))
    .slice(0, 20);
  const det = await detourItems(env, items);
  // detours: id -> extra minutes (as before); reach: id -> {toMin, toKm} from route point A to the charger.
  const detoursOut = {}, reach = {};
  for (const [id, d] of det) { detoursOut[id] = d.min; reach[id] = { toMin: d.toMin, toKm: d.toKm }; }
  return json(request, { detours: detoursOut, reach, checkedAt: new Date().toISOString() });
}

// ---------------------------------------------------------------- logos
// The brand's site icon, fetched once from its own website and kept 7 days in KV.
const LOGO_TTL_S = 7 * 24 * 3600;
function absUrl(href, base) { try { return new URL(href, base).href; } catch { return null; } }
async function findIcon(site) {
  const base = `https://${site}/`;
  const tries = [];
  try {
    const res = await fetch(base, { headers: { "User-Agent": "Mozilla/5.0 (evailability logo fetch)", Accept: "text/html" }, redirect: "follow" });
    countCall("Logo fetch");
    const html = (await res.text()).slice(0, 300000);
    const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
    const cands = [];
    for (const l of links) {
      const rel = (l.match(/rel=["']([^"']+)["']/i) || [])[1] || "";
      if (!/icon/i.test(rel)) continue;
      const href = (l.match(/href=["']([^"']+)["']/i) || [])[1];
      if (!href) continue;
      const sizes = (l.match(/sizes=["'](\d+)x\d+["']/i) || [])[1];
      const size = sizes ? Number(sizes) : /apple-touch/i.test(rel) ? 180 : 32;
      const url = absUrl(href, res.url || base);
      if (url) cands.push({ url, size, svg: /\.svg(\?|$)/i.test(url) });
    }
    // Small but sharp: prefer about 64 px, then larger, then smaller. SVG last (can be a mask icon).
    cands.sort((a, b) => (a.svg - b.svg) || Math.abs(Math.log((a.size || 32) / 64)) - Math.abs(Math.log((b.size || 32) / 64)));
    tries.push(...cands.map((c) => c.url));
  } catch (_) { /* the site may block us; try the usual places */ }
  tries.push(`${base}favicon.ico`, `https://www.google.com/s2/favicons?domain=${site}&sz=64`);
  for (const url of tries.slice(0, 5)) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (evailability logo fetch)" }, redirect: "follow" });
      countCall("Logo fetch");
      const type = (res.headers.get("Content-Type") || "").split(";")[0].trim();
      if (!res.ok || !/^image\//.test(type)) continue;
      const buf = await res.arrayBuffer();
      if (buf.byteLength < 100 || buf.byteLength > 200000) continue;
      return { type, buf, from: url };
    } catch (_) { /* next */ }
  }
  return null;
}
function toB64(buf) {
  let s = ""; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64) { const s = atob(b64); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }

async function handleLogo(request, env, key) {
  const brand = BRAND[key];
  if (!brand) throw new HttpError(404, "Unknown brand");
  const headers = (type) => ({ "Content-Type": type, "Cache-Control": `public, max-age=${LOGO_TTL_S}`, ...corsHeaders(request) });
  let rec = memoGet(`logo:${key}`);
  if (rec === undefined && env.USAGE) {
    try { rec = JSON.parse((await kvGet(env, `logo:${key}`)) || "null") ?? undefined; } catch { rec = undefined; }
  }
  if (rec === undefined) {
    const icon = await findIcon(brand.site);
    rec = icon ? { type: icon.type, b64: toB64(icon.buf), from: icon.from } : { none: true };
    if (env.USAGE) {
      // A miss is kept a day only, so a site that was down gets another chance.
      try { await env.USAGE.put(`logo:${key}`, JSON.stringify(rec), { expirationTtl: rec.none ? 24 * 3600 : LOGO_TTL_S }); countCall("KV writes"); } catch (_) {}
    }
  }
  memoSet(`logo:${key}`, rec, 3600 * 1000);
  if (rec.none) return new Response("No icon found", { status: 404, headers: { "Cache-Control": "public, max-age=3600", ...corsHeaders(request) } });
  return new Response(fromB64(rec.b64), { headers: headers(rec.type) });
}

async function handleStatus(request, env) {
  const body = await request.json().catch(() => ({}));
  const stations = Array.isArray(body.stations) ? body.stations : [];
  return json(request, { status: await statusForMany(stations, env), checkedAt: new Date().toISOString() });
}

// ---------------------------------------------------------------- access
// The app asks for an access code once. The check happens here, so the page source shows nothing
// about it: a 9-digit number that passes the "11-proef" (like a Dutch BSN). A right code gets a token
// (HMAC of a fixed text with a server-side secret); the app keeps it and sends it as X-Access.
// Changing ACCESS_SECRET (or, without it, OCM_API_KEY) signs everyone out.
const PUBLIC_PATHS = new Set(["/", "/unlock", "/brands", "/admin/usage"]);
function elfProef(code) {
  const d = String(code || "").replace(/[\s.\-]/g, "");
  if (!/^\d{9}$/.test(d) || /^0+$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(d[i]) * (9 - i);
  sum -= Number(d[8]);
  return sum % 11 === 0;
}
async function accessToken(env) {
  const cached = memoGet("access-token");
  if (cached) return cached;
  const secret = env.ACCESS_SECRET || env.OCM_API_KEY || "";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  // Fixed text from the app's old name. Changing it would sign every device out, so it stays.
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("ionity-route-access-v1"));
  const token = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  memoSet("access-token", token, 24 * 3600 * 1000);
  return token;
}
function sameText(a, b) { // compare without stopping at the first difference
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
async function hasAccess(request, env, url) {
  const given = request.headers.get("X-Access") || url.searchParams.get("access") || "";
  if (sameText(given, await accessToken(env))) return true;
  // The admin password works too (handy for opening /debug/… pages in a browser: ?access=<password>).
  return !!env.ADMIN_TOKEN && sameText(given, env.ADMIN_TOKEN);
}
async function handleUnlock(request, env) {
  // Max 5 tries per 10 minutes per address, so guessing takes a while.
  const ip = request.headers.get("CF-Connecting-IP") || "?";
  const key = `unlock:${ip}`;
  const tries = memoGet(key) || 0;
  if (tries >= 5) throw new HttpError(429, "Too many tries. Wait 10 minutes.");
  memoSet(key, tries + 1, 10 * 60 * 1000);
  const body = await request.json().catch(() => ({}));
  if (!elfProef(body.code)) {
    await sleep(800);
    throw new HttpError(403, "That code isn’t right.");
  }
  return json(request, { token: await accessToken(env) });
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(request) });
  if (path === "/unlock" && request.method === "POST") return handleUnlock(request, env);
  if (!PUBLIC_PATHS.has(path) && !path.startsWith("/logo/") && !(await hasAccess(request, env, url))) {
    throw new HttpError(401, "Access code needed");
  }

  if (path === "/" && request.method === "GET") {
    return json(request, {
      ok: true,
      service: "evailability proxy",
      secrets: { ORS_API_KEY: !!env.ORS_API_KEY, OCM_API_KEY: !!env.OCM_API_KEY },
    });
  }
  if (path === "/geocode" && request.method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) throw new HttpError(400, "Add ?q=<place>");
    return json(request, { results: await geocode(env, q) });
  }
  if (path === "/admin/usage" && request.method === "GET") return handleUsage(request, env);
  if (path === "/plan" && request.method === "POST") return handlePlan(request, env);
  if (path === "/status" && request.method === "POST") return handleStatus(request, env);
  if (path === "/alternatives" && request.method === "POST") return handleAlternatives(request, env);
  if (path === "/detours" && request.method === "POST") return handleDetours(request, env);
  if (path === "/brands" && request.method === "GET") {
    return json(request, { brands: BRANDS.map(({ key, name, color }) => ({ key, name, color })) });
  }
  if (path.startsWith("/logo/") && request.method === "GET") return handleLogo(request, env, path.slice(6).toLowerCase());
  if (path === "/debug/brands" && request.method === "GET") {
    const { byBrand } = await brandOperators(env);
    return json(request, { operators: byBrand });
  }

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
    let lat = Number(url.searchParams.get("lat")), lon = Number(url.searchParams.get("lon"));
    const name = (url.searchParams.get("name") || "").trim();
    if (name) {
      // Find the Ionity site by name in Open Charge Map (Germany), then look around it.
      const pois = await ionityInBox(env, [5.8, 47.2, 15.1, 55.1]);
      const hit = pois.find((p) => (p.AddressInfo?.Title || "").toLowerCase().includes(name.toLowerCase()));
      if (!hit) return json(request, { error: `No Ionity site named like "${name}" in Open Charge Map`, known: pois.length });
      const st = { lat: hit.AddressInfo.Latitude, lon: hit.AddressInfo.Longitude };
      const locs = await deLocationsNear(st.lat, st.lon, Math.min(Number(url.searchParams.get("radius")) || 2000, 5000));
      const near = (l) => Math.round(1000 * haversineKm(
        [Number(l.coordinates?.longitude ?? l.coordinates?.lon), Number(l.coordinates?.latitude ?? l.coordinates?.lat)], [st.lon, st.lat]));
      return json(request, {
        ocm: { title: hit.AddressInfo.Title, ...st },
        parsed: summariseDe(locs, st),
        ionity: locs.filter(isIonityLoc).map((l) => ({ name: l.name, operator: l.operator?.name, source: l.source, metres: near(l),
          evses: (l.evses || []).map((e) => `${e.evse_id || e.uid} ${e.status}`) })),
        fastOthers: locs.filter((l) => !isIonityLoc(l) && near(l) < 800)
          .map((l) => ({ name: l.name, operator: l.operator?.name, owner: l.owner?.name, source: l.source, metres: near(l),
            evses: (l.evses || []).slice(0, 3).map((e) => `${e.evse_id || e.uid} ${e.status}`) })),
      });
    }
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
  if (path === "/debug/detour" && request.method === "GET") {
    // /debug/detour?name=dietmannsried&from=47.99,10.18&to=47.72,10.31  (from/to as lat,lon)
    const name = (url.searchParams.get("name") || "").trim().toLowerCase();
    const ll = (k) => (url.searchParams.get(k) || "").split(",").map(Number);
    const [fLat, fLon] = ll("from"), [tLat, tLon] = ll("to");
    if (!name || ![fLat, fLon, tLat, tLon].every(Number.isFinite)) throw new HttpError(400, "Add ?name=..&from=lat,lon&to=lat,lon");
    const route = await getRoute(env, [[fLon, fLat], [tLon, tLat]]);
    const pois = await ionityAlongRoute(env, route, 5);
    const hit = pois.find((p) => (p.AddressInfo?.Title || "").toLowerCase().includes(name));
    if (!hit) return json(request, { error: "Not found along this route", found: pois.map((p) => p.AddressInfo?.Title) });
    const a = hit.AddressInfo, proj = projectOnRoute([a.Longitude, a.Latitude], route);
    const st = { id: "x", lat: a.Latitude, lon: a.Longitude, alongKm: proj.alongKm };
    const det = await detours(env, route, [st]);
    return json(request, {
      title: a.Title, lat: a.Latitude, lon: a.Longitude,
      offRouteKm: Math.round(proj.offRouteKm * 1000) / 1000,
      road: roadAtIndex(route, proj.index),
      detourMinRaw: det.get("x")?.min ?? null,
      reach: det.get("x") ? { toMin: det.get("x").toMin, toKm: det.get("x").toKm } : null,
    });
  }
  if (path === "/debug/ocm-operator" && request.method === "GET") {
    return json(request, { ionity: (await brandOperators(env)).byBrand.ionity });
  }
  throw new HttpError(404, "Unknown endpoint");
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "OPTIONS") countCall("Worker requests");
    // Save the tally after answering: straight away after planning (rare, many calls),
    // otherwise at most every 2 minutes. A new deploy discards anything not yet saved.
    const urgent = /^\/(plan|alternatives)/.test(new URL(request.url).pathname);
    try {
      return await route(request, env);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      console.log("Error", status, e.message);
      return json(request, { error: e.message }, status);
    } finally {
      ctx?.waitUntil?.(flushUsage(env, urgent).catch(() => {}));
    }
  },
};
