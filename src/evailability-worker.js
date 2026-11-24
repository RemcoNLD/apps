// EVailability (formerly "Ionity route") – Cloudflare Worker proxy
//
// Endpoints
//   GET  /                      health check: shows which secrets are set
//   GET  /geocode?q=Venlo       address search -> [{label, lat, lon}]
//   POST /plan                  {from:[lon,lat], to:[lon,lat], corridorKm?:5, brands?:["ionity","fastned",…],
//                               avoid?:[[[lon,lat],…],…], avoidSpans?:[[[lon,lat],[lon,lat]],…]}
//                               (avoid: small areas around closures the driver chose to avoid; avoidSpans: a point
//                               before and after each, used for routes over 150 km, see handlePlan)
//                               -> route + chargers of those brands along it (detour minutes only when cached)
//   POST /status                {stations:[{id, lat, lon, country, brand}]}
//   POST /fr-status             {stations:[{id, lat, lon, brand}]}  France (old app copies; 0.30+ get France from /status)
//   (POST /status also answers Portugal and France, from 5-minute snapshots made by GitHub jobs: pt-live.yml, fr-live.yml)
//   POST /be-status             {stations:[{id, lat, lon, brand}]}  Belgium: pins → index sites with their stall ids (no live call)
//   GET  /be-evse?id=<evse>     Belgium: one stall's live status (Eco-Movement; at most one call per 10 s, else retryAfterMs)
//   GET  /debug/be?id=<evse>    Belgium: raw Eco-Movement answer for one stall
//                               -> live availability per station (NL, DE, AT)
//   POST /detours               {items:[{id, lat, lon, a:[lon,lat], b:[lon,lat]}]} (max 20)
//                               -> detour minutes per charger (a, b: route points 3 km before and after it)
//   GET  /brands                the brands the app can show (key, name, colour)
//   GET  /logo/<brand>          the brand's site icon, fetched from its website and kept 7 days in KV
//   GET  /debug/brands          which Open Charge Map operators each brand matches
//   GET  /where?lat=&lon=       street and town at a point (for the location line off the main roads)
//   GET  /debug/route/<id>      a routing result kept by a /plan with debug:true (app in debug mode), 30 days in KV
//                               ?part=request|app|ors for one part (ors = the routing service's raw answer)
//   POST /alternatives          {from, to, tune?} -> up to 3 route options (roads, cities, time, Ionity count)
//   GET  /closures/schedule     hours between road-closure updates (read by the GitHub job .github/workflows/closures.yml)
//   POST /extra-sites           {pts:[[lon,lat],…] (max 150), brands} -> fast chargers of those brands within 1.5 km of the
//                               points from the country indexes (BE, FR, PT, DE incl. AT), for sites Open Charge Map misses
//   GET  /occupancy/config      public: occupancy on/off, followed brands and their name patterns (read by occupancy.yml)
//                               ?all=1: every brand (read by de-index.yml)
//   GET  /occupancy/at?part=     public: free/total at the followed brands' Austrian sites (E-Control), for occupancy.yml
//   GET  /occupancy?lat=&lon=&brand=  free chargers per 15 min over the last 8 days at the nearest followed site (branch occ)
//   GET  /admin/usage           usage per data source (header Authorization: Bearer <ADMIN_TOKEN>)
//   GET  /admin/timer           the 5-minute timer that starts GitHub jobs: its state (POST: check the GitHub App now)
//   GET  /admin/push            push notifications for the usage page: public key, subscriptions (POST: subscribe, unsubscribe, test)
//   GET  /admin/alerts          alert rules, targets with their state, open incidents and the log
//                               (POST: save-defaults, save-rule, ack, unack, resolve, clear-log); see "admin alerts"
//   GET  /admin/settings        switches and values set on the usage page (same header)
//   GET  /admin/users           access keys: label, status, dates, use per day (same header)
//   POST /admin/users           {action:"create", label} | {action:"regenerate"|"disable"|"enable"|"delete", id}
//                               | {action:"set", id, active?, debug?} (the switches in the list)
//   GET  /me                    who this key is: {name, debug, trial?} (debug: may use debug mode)
//   GET  /service-status        public: {notices: [{id, text}]} for the start screen: your own notice
//                               (setting serviceNotice) and, automatically, trouble at the route service
//   GET  /self-service          public: {mode: "off"|"requests"|"trial"} (the lock screen's request link)
//   POST /request               public: {email, name?, note?} → {pending, id, pickup} or, in trial mode, {token, …}
//   GET  /request/status?id=&t= public: the asking device's pickup: {status} and {token} once approved,
//                               or {status:"declined", reply} with Remco's note
//   POST /trial/extend          a trial key (X-Access) extends itself once: +1 day and +5 routes
//   POST /contact               {kind: "note"|"delete", text} from a key (X-Access) or a waiting request ({id, t}):
//                               a message for Remco on the Users page (text encrypted like emails)
//   POST /contact/cancel-delete a key (X-Access) takes back its open deletion request
//   POST /request/withdraw      {id, t}: the asking device withdraws its waiting request; it's deleted at once
//                               create/regenerate answer the new key once; only its hash is kept
//   POST /admin/settings        {settings:{key: value}} saves them (one KV write); empty value = default
//   GET  /debug/ndw?lat=&lon=   raw Dutch (NDW) data around a point, to tune the parser
//   GET  /debug/ocm-operator    shows which Open Charge Map operator ID is used for Ionity
//   GET  /debug/ocm-ionity      Ionity sites Open Charge Map knows in a box (default: NL)
//   GET  /debug/at?lat=&lon=    raw answer from the Austrian charging register (E-Control)
//   GET  /debug/de?lat=&lon=    raw German answer (MobiData BW OCPDB, AFIR data) plus what we parse from it
//   GET  /debug/fr-range[?part=&parts=&ids=]  France: does the national live file allow partial downloads (Range)?
//                               With part: fetches that piece only and looks for ids in it (CPU test)
//                               With whole=1: reads the whole file as a stream (CPU test for the free plan)
//
// Secrets (Cloudflare > Worker > Settings > Variables and Secrets)
//   ORS_API_KEY   OpenRouteService / HeiGIT key
//   OCM_API_KEY   Open Charge Map key
//   ECONTROL_API_KEY  Austrian charging register (E-Control) key
//   ADMIN_TOKEN   password for the usage page (admin.html)
//   ECO_BE_TOKEN  Eco-Movement Belgium DATEX II token (live status per stall)
//   GH_APP_KEY    private key (.pem) of the GitHub App "EVailability timer" (see "timer"; GH_APP_ID is in wrangler.toml)
// Optional KV binding
//   USAGE         keeps the usage counts per day (without it they live in memory only)
// Optional plain variable
//   OCM_IONITY_OPERATOR_ID   only needed if the automatic lookup fails (now also on the usage page, Settings)

// Bumped with each change to this file, shown in the app's debug line.
const WORKER_VERSION = "0.13.0"; // 0.x.y like the app: x = feature (per chat), y = deploys while working on it
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
  // Dutch networks (0.9.0), matched by operator name only (their EVSE prefixes aren't confirmed yet, so
  // evse never matches). Listed last, so an existing brand wins a shared name. Essent runs the former
  // bp pulse network in NL since Oct 2026 (owned by E.ON Drive Infrastructure); German bp sites are
  // "Aral pulse" and match aral first. Vattenfall InCharge was Nuon. Vattenfall and Eneco run many slow
  // street chargers too; those are left out by the fast filters (OCM level 3, NDW >= 50 kW).
  { key: "essent", name: "Essent", color: "#e4003b", ocm: /\bessent\b|\be\.?on drive|\bbp ?pulse\b/i, live: /\bessent\b|\be\.?on drive|\bbp ?pulse\b/i, evse: /(?!)/, site: "essent.nl" },
  { key: "vattenfall", name: "Vattenfall InCharge", color: "#2071b5", ocm: /vattenfall|\bincharge\b|\bnuon\b/i, live: /vattenfall|\bincharge\b|\bnuon\b/i, evse: /(?!)/, site: "vattenfall.nl" },
  { key: "eneco", name: "Eneco", color: "#3db54a", ocm: /\beneco\b/i, live: /\beneco\b/i, evse: /(?!)/, site: "eneco.nl" },
];
const BRAND = Object.fromEntries(BRANDS.map((b) => [b.key, b]));
const brandOf = (key) => BRAND[key] || BRAND.ionity;
// Only fast chargers: everything below this is left out for the other brands.
const FAST_KW = 50;
// The app's minimum charging power (50, 150 or 300 on the start screen), sent as minKw with every status
// call. Free counts then mean "free at your power": a 350 kW site's 50 kW chargers don't count when
// you asked for 150. Only when no stall of a site reaches minKw are its fast ones (>= 50 kW) counted.
const minKwOf = (v) => { const n = Math.round(Number(v)); return n >= FAST_KW && n <= 400 ? n : FAST_KW; };
function byPower(points, kwOf, minKw = FAST_KW) {
  const fast = points.filter((p) => (kwOf(p) || 0) >= FAST_KW);
  const base = fast.length ? fast : points;
  if (minKw <= FAST_KW) return base;
  const strong = base.filter((p) => (kwOf(p) || 0) >= minKw);
  return strong.length ? strong : base;
}

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
  constructor(status, message, reason, extra) { super(message); this.status = status; this.reason = reason; this.extra = extra; }
}

// ---------------------------------------------------------------- usage counting
// Counts calls per data source and keeps the quota OpenRouteService reports with each answer.
// Saved to KV (binding USAGE) at most every 2 minutes, to stay well within KV's free write limit.
const USAGE_FLUSH_MS = 2 * 60 * 1000;
const usage = { pending: {}, users: {}, qos: {}, ors: {}, orsHeaders: {}, slots: {}, lastFlush: Date.now(), kvWrites: 0 };
// 5-minute slots for the admin alerts (Worker 0.8.0): per slot (number = epoch ms / 5 min) the calls of the
// sources with a daily limit (c) and per service/endpoint [calls, failures, total ms] (q). Saved in the
// same usage record (no extra writes), only the last 3 hours, so the timer can see rates and windows.
const SLOT_MS = 5 * 60 * 1000, SLOT_KEEP = 36;
const SLOT_SOURCES = new Set(["Worker requests", "KV reads", "KV writes", "Routing", "Matrix", "Geocoder"]);
function slotOf(at = Date.now()) {
  const k = Math.floor(at / SLOT_MS);
  return usage.slots[k] || (usage.slots[k] = { c: {}, q: {} });
}
function mergeSlots(into, from) {
  for (const [k, v] of Object.entries(from || {})) {
    const t = into[k] || (into[k] = { c: {}, q: {} });
    for (const [s, n] of Object.entries(v.c || {})) t.c[s] = (t.c[s] || 0) + n;
    for (const [s, a] of Object.entries(v.q || {})) {
      const x = t.q[s] || (t.q[s] = [0, 0, 0]);
      x[0] += a[0]; x[1] += a[1]; x[2] += a[2] || 0;
    }
  }
  const min = Math.floor(Date.now() / SLOT_MS) - SLOT_KEEP;
  for (const k of Object.keys(into)) if (Number(k) < min) delete into[k];
  return into;
}
// Quality of service, per outside service and per endpoint of this Worker: calls, failures, total and
// slowest time, a time histogram and the last failure. Saved with the counts (no extra writes); the
// usage page shows it under "Service health".
const QOS_BUCKETS = [250, 500, 1000, 2000, 5000]; // ms; one more bucket for slower
function noteQos(key, ms, ok, status) {
  const q = usage.qos[key] || (usage.qos[key] = { n: 0, fail: 0, ms: 0, max: 0, b: [0, 0, 0, 0, 0, 0] });
  q.n++; q.ms += ms; q.max = Math.max(q.max, ms);
  q.b[QOS_BUCKETS.findIndex((x) => ms < x) === -1 ? 5 : QOS_BUCKETS.findIndex((x) => ms < x)]++;
  if (!ok) { q.fail++; q.lastFail = { at: Date.now(), status }; usage.failed = true; }
  const sq = slotOf().q, x = sq[key] || (sq[key] = [0, 0, 0]);
  x[0]++; if (!ok) x[1]++; x[2] += ms;
}
function mergeQos(into, q) {
  for (const [k, v] of Object.entries(q)) {
    const t = into[k] || (into[k] = { n: 0, fail: 0, ms: 0, max: 0, b: [0, 0, 0, 0, 0, 0] });
    t.n += v.n; t.fail += v.fail; t.ms += v.ms; t.max = Math.max(t.max, v.max);
    v.b.forEach((x, i) => { t.b[i] += x; });
    if (v.lastFail && (!t.lastFail || t.lastFail.at < v.lastFail.at)) t.lastFail = v.lastFail;
  }
}
// Requests per access key (user id), saved with the counts above, so no extra KV writes.
// Per key also its devices: a random id the app makes once per install (?d=), with the kind of device
// read from the browser (iPhone, iPad, Mac…). Shows on the Users page whether a key is passed around.
function countUser(id, device, kind) {
  const u = usage.users[id] || (usage.users[id] = { n: 0, last: 0 });
  u.n++; u.last = Date.now();
  if (device) { u.dev = u.dev || {}; u.dev[device] = { last: u.last, kind }; }
}
// Adds one tally {n, last, dev} into another (saving, putting back after a failed save, the Users page).
function mergeUser(into, u) {
  into.n += u.n; into.last = Math.max(into.last, u.last);
  for (const [d, v] of Object.entries(u.dev || {})) {
    into.dev = into.dev || {};
    if (!into.dev[d] || into.dev[d].last < v.last) into.dev[d] = v;
  }
}
function deviceKind(request) {
  const ua = request.headers.get("User-Agent") || "";
  return /iPad/.test(ua) ? "iPad" : /iPhone/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android"
    : /Macintosh/.test(ua) ? (/Mobile\//.test(ua) ? "iPad" : "Mac") : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Other";
}
const today = () => new Date().toISOString().slice(0, 10);
function countCall(source, n = 1) {
  usage.pending[source] = (usage.pending[source] || 0) + n;
  if (SLOT_SOURCES.has(source)) { const c = slotOf().c; c[source] = (c[source] || 0) + n; }
}
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
  const pending = usage.pending, ors = usage.ors, users = usage.users, qos = usage.qos, slots = usage.slots;
  if (!Object.keys(pending).length && !Object.keys(ors).length && !Object.keys(users).length && !Object.keys(qos).length) return;
  usage.pending = {}; usage.users = {}; usage.qos = {}; usage.slots = {}; usage.lastFlush = Date.now(); usage.failed = false;
  const day = today();
  const rec = (await readUsageDay(env, day)) || { day, calls: {}, ors: {} };
  for (const [k, n] of Object.entries(pending)) rec.calls[k] = (rec.calls[k] || 0) + n;
  for (const [k, v] of Object.entries(ors)) if (!rec.ors[k] || rec.ors[k].at < v.at) rec.ors[k] = v;
  rec.users = rec.users || {};
  for (const [id, u] of Object.entries(users)) mergeUser(rec.users[id] || (rec.users[id] = { n: 0, last: 0 }), u);
  rec.qos = rec.qos || {};
  mergeQos(rec.qos, qos);
  rec.slots = mergeSlots(rec.slots || {}, slots);
  rec.orsHeaders = { ...(rec.orsHeaders || {}), ...usage.orsHeaders };
  rec.calls["KV writes"] = (rec.calls["KV writes"] || 0) + 1;
  try {
    await env.USAGE.put(`usage:${day}`, JSON.stringify(rec), { expirationTtl: 40 * 24 * 3600 });
  } catch (e) {
    // Put the counts back so they're not lost.
    for (const [k, n] of Object.entries(pending)) countCall(k, n);
    for (const [id, u] of Object.entries(users)) mergeUser(usage.users[id] || (usage.users[id] = { n: 0, last: 0 }), u);
    mergeQos(usage.qos, qos);
    mergeSlots(usage.slots, slots);
    console.log("Usage save failed", e.message);
  }
}

function checkAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!env.ADMIN_TOKEN) throw new HttpError(503, "ADMIN_TOKEN is not set in the Worker");
  if (!sameText(auth, `Bearer ${env.ADMIN_TOKEN}`)) throw new HttpError(401, "Wrong password");
}

// ---------------------------------------------------------------- settings
// Switches and values that can be changed on the usage page, so there's no need to go to the
// Cloudflare dashboard. Kept in KV under "settings"; each Worker copy reads them at most once a
// minute, so a change takes effect within a minute. Not set = the Worker variable of the same
// meaning (if any), else the default. Secrets (API keys, passwords) stay in Cloudflare.
const SETTINGS = [
  { key: "paidUntil", type: "date", label: "Workers Paid until", def: () => "",
    help: "The last day of a Cloudflare Workers Paid period (Billing > Subscriptions, 'Ending on'). Until then: France updates by itself (every 2 minutes unless set below), a short pause after an error, more chargers ahead kept fresh, and the usage page shows the Paid allowances. After it everything returns to the free settings by itself. Empty: free plan." },
  { key: "serviceNotice", type: "text", label: "Notice on the start screen", def: () => "",
    help: "Shown at the top of the route planning screen for everyone, until you empty it. Trouble at the route service is announced there by itself (and goes away when it works again); this is for anything else, up to 200 characters." },
  { key: "selfService", type: "choice", options: ["off", "requests", "trial"], label: "Self-service keys", def: () => "off",
    help: "Off: the lock screen only asks for a key. Requests: people without a key can ask for one with their email; you approve them on the Users page. Trial: they get a trial key straight away (Netherlands only, slower updates, limited days and routes); a second trial on the same device or email becomes a request." },
  { key: "trialDays", type: "number", min: 1, max: 60, label: "Trial: days", def: () => 7,
    help: "How long a trial key works." },
  { key: "trialRoutes", type: "number", min: 1, max: 200, label: "Trial: routes", def: () => 10,
    help: "How many routes a trial key may plan." },
  { key: "trialPerDay", type: "number", min: 0, max: 100, label: "Trial: new trials per day", def: () => 5,
    help: "At most this many automatic trials a day (everyone together); after that people get a request instead." },
  { key: "legacyCode", type: "bool", label: "Old access code (11-proef)", def: () => true,
    help: "On: the old shared 9-digit code still opens the app, and devices that used it keep working. Switch off once everyone has a personal key (Users page); those devices then ask for a key." },
  { key: "frLive", type: "bool", label: "France live", def: (env) => env.FR_LIVE !== "off",
    help: "Off: French chargers show no live data. France comes from a 5-minute snapshot made by the GitHub job France live (fr-live.yml), started by the timer." },
  { key: "ndwDiscovery", type: "bool", label: "Netherlands: extra chargers from NDW", def: (env) => env.NDW_DISCOVERY !== "off",
    help: "Sites Open Charge Map doesn't have, found in NDW's live data along the route." },
  { key: "indexDiscovery", type: "bool", label: "Other countries: extra chargers from the indexes", def: () => true,
    help: "Sites Open Charge Map doesn't have, found in the country lists the Worker already keeps: Belgium, France and Portugal (their live-status indexes) and Germany with part of Austria (de-fast-sites.json, built weekly from MobiData BW by the GitHub job DE index). No calls to outside services, no KV writes." },
  { key: "ocmIonityOperatorId", type: "text", label: "Open Charge Map operator id for Ionity", def: (env) => env.OCM_IONITY_OPERATOR_ID || "",
    help: "Empty: found automatically. Only fill in if that lookup fails." },
  { key: "occupancy", type: "bool", label: "Occupancy through the day", def: () => true,
    help: "On: the GitHub job Occupancy (occupancy.yml) notes every 15 minutes how many chargers are free at the followed brands' sites (NL from NDW, DE from MobiData BW, AT from E-Control through the Worker, FR and PT from their snapshots) and keeps 8 days on the branch occ; the app's charger card shows today against the same day last week. No KV writes. Off: the timer stops starting it and the job writes nothing (the stored days stay)." },
  { key: "occupancyBrands", type: "text", label: "Occupancy: brands", def: () => "ionity, fastned",
    help: "Brand keys to follow, separated by commas (e.g. ionity, fastned, tesla), or all. More brands means more NDW calls per run (one small call per Dutch site area, or one full scan of NL once that is cheaper) and one MobiData BW call per brand for Germany; KV writes stay zero." },
  { key: "closuresHours", type: "choice", options: [6, 12, 24, 48], label: "Road closures: hours between updates", def: () => 12,
    help: "How often the GitHub job fetches planned closures (NL, DE). It wakes every 6 hours and skips until this much time has passed; Run workflow on GitHub always updates." },
];
let SET = null; // this request's settings (loaded at the start of each request, see route)
let SAVED = {};  // what's actually saved (incl. hidden keys such as frGapPlan)
async function loadSettings(env) {
  let saved = memoGet("settings");
  if (saved === undefined) {
    saved = {};
    try { if (env.USAGE) saved = JSON.parse((await kvGet(env, "settings")) || "{}"); } catch (_) {}
    memoSet("settings", saved, 60 * 1000);
  }
  const out = {};
  for (const d of SETTINGS) out[d.key] = saved[d.key] !== undefined && saved[d.key] !== "" ? saved[d.key] : d.def(env);
  SET = out;
  SAVED = saved;
  return { values: out, saved };
}
const setting = (env, key) => (SET || {})[key] ?? SETTINGS.find((d) => d.key === key)?.def(env);
// Workers Paid: on until (and including) the date set on the usage page, then free again by itself.
const paidUntil = (env) => String(setting(env, "paidUntil") || "");
const isPaid = (env) => { const u = paidUntil(env); return !!u && new Date().toISOString().slice(0, 10) <= u; };
// France timing per plan: on Paid a read costs nothing that matters, so no gap and a short pause.
const frGapDefault = (env) => (isPaid(env) ? 2 : 5);

async function handleSettings(request, env) {
  checkAdmin(request, env);
  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const given = body.settings || {};
    const { saved } = await loadSettings(env);
    const next = { ...saved };
    for (const d of SETTINGS) {
      if (!(d.key in given)) continue;
      let v = given[d.key];
      if (v === null || v === "") { delete next[d.key]; continue; } // back to the default
      if (d.type === "bool") v = v === true || v === "true" || v === "on";
      else if (d.type === "choice") {
        if (typeof d.options[0] === "number") v = Number(v);
        if (!d.options.includes(v)) throw new HttpError(400, `${d.label}: ${d.options.join(", ")}`);
      }
      else if (d.type === "date") {
        v = String(v).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, `${d.label}: a date like 2026-12-16`);
      }
      else if (d.type === "number") {
        v = Number(v);
        if (!Number.isFinite(v) || v < d.min || v > d.max) throw new HttpError(400, `${d.label}: ${d.min} to ${d.max}`);
      } else v = String(v).trim().slice(0, d.key === "serviceNotice" ? 200 : 100);
      next[d.key] = v;
      if (d.key === "frGapMin") next.frGapPlan = isPaid(env) ? "paid" : "free"; // the plan it was entered under
    }
    if (given.frGapMin === null || given.frGapMin === "") delete next.frGapPlan;
    await env.USAGE.put("settings", JSON.stringify(next));
    countCall("KV writes");
    memoSet("settings", next, 60 * 1000);
  }
  const { values, saved } = await loadSettings(env);
  return json(request, {
    settings: SETTINGS.map((d) => ({ key: d.key, type: d.type, label: d.label, help: d.help, min: d.min, max: d.max, options: d.options,
      value: d.key === "frGapMin" && saved.frGapMin !== undefined && (saved.frGapPlan || "paid") !== (isPaid(env) ? "paid" : "free") ? "" : values[d.key],
      default: d.key === "frGapMin" ? frGapDefault(env) : d.def(env),
      changed: d.key === "frGapMin" ? saved.frGapMin !== undefined && (saved.frGapPlan || "paid") === (isPaid(env) ? "paid" : "free") : saved[d.key] !== undefined })),
    note: "Other Worker copies pick up a change within a minute.",
  });
}

async function handleUsage(request, env) {
  checkAdmin(request, env);
  await flushUsage(env, true);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const rec = await readUsageDay(env, d);
    if (rec) { delete rec.slots; days.push(rec); } // the 5-minute slots are for the alerts only
  }
  // Workers Paid: Cloudflare's allowances are per billing period (a month ending on the "paid until"
  // date), so add up the days of the current period for Cloudflare's own counters.
  let period = null;
  if (isPaid(env)) {
    const to = paidUntil(env);
    const end = new Date(`${to}T00:00:00Z`);
    const from = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, end.getUTCDate())).toISOString().slice(0, 10);
    const sums = { "Worker requests": 0, "KV reads": 0, "KV writes": 0 };
    const todayKey = today();
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Math.min(Date.now(), end.getTime()); t += 86400000) {
      const d = new Date(t).toISOString().slice(0, 10);
      const rec = days.find((x) => x.day === d) || (await readUsageDay(env, d));
      for (const k of Object.keys(sums)) sums[k] += rec?.calls?.[k] || 0;
      if (d === todayKey) for (const k of Object.keys(sums)) sums[k] += usage.pending[k] || 0; // not saved yet
    }
    period = { from, to, calls: sums };
  }
  const openRequests = (await loadRequests(env)).filter((r) => r.status === "pending").length
    + (await loadMessages(env)).filter((m) => !m.done).length; // requests and messages waiting for Remco
  return json(request, {
    stored: !!env.USAGE,
    openRequests, // badge on the "Users & keys" link
    plan: { paid: isPaid(env), until: paidUntil(env) || null, period },
    today: today(),
    days,
    // Not saved yet (or no KV): this copy of the Worker's own tally since it started.
    unsaved: { calls: usage.pending, ors: usage.ors, qos: usage.qos },
    health: await loadHealth(env), // the route-service notice's state
    orsHeaders: { ...((days[0] && days[0].orsHeaders) || {}), ...usage.orsHeaders },
  });
}

// The Worker's env (bindings and secrets; the same for every request), for bookkeeping in fetchJson.
let ENV_NOW = null;
async function fetchJson(url, init = {}, label = "upstream") {
  // The routing service (openrouteservice) sometimes answers 500/502/503/504 for a moment ("There was
  // a problem proxying the request"): try again twice, after about 0.7 and 1.8 s, before giving up.
  const retries = label === "Routing" ? [700, 1800] : [];
  let res, text;
  for (let attempt = 0; ; attempt++) {
    countCall(label);
    const t0 = Date.now();
    try { res = await fetch(url, init); }
    catch (e) { noteQos(`svc:${label}`, Date.now() - t0, false, "network"); throw e; }
    // Worked = no server error, like the endpoints; a 4xx is the request's fault (e.g. no route between two
    // points), except a refused key (401/403) or being rate limited (429).
    noteQos(`svc:${label}`, Date.now() - t0, res.ok || (res.status < 500 && ![401, 403, 429].includes(res.status)), res.status);
    noteQuota(url, res);
    text = await res.text();
    if (res.ok || res.status < 500 || attempt >= retries.length) break;
    countCall(`${label} retried`);
    await sleep(retries[attempt]);
  }
  if (label === "Routing") noteRouteHealth(ENV_NOW, res.ok || res.status < 500).catch(() => {});
  if (!res.ok && label === "Routing" && res.status >= 500) {
    throw new HttpError(502, `The route service (openrouteservice) isn’t answering properly right now (${res.status}). It’s usually back within a few minutes; try again then.`);
  }
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
    // exact: an address, street or named spot, driven to as it is. A town or region isn't: as a via
    // point it's passed on the main road nearest to it, not through its centre.
    const hits = (data.features || []).map((f) => ({
      label: f.properties?.label || f.properties?.name || q,
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      exact: ["address", "street", "venue", "postalcode"].includes(f.properties?.layer),
    }));
    if (hits.length) return hits;
  } catch (_) { /* fall back to Nominatim below */ }
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`;
  const data = await fetchJson(url, {
    headers: { "User-Agent": "evailability personal app (github.com/RemcoNLD)" },
  }, "Nominatim");
  return data.map((d) => ({ label: d.display_name, lat: +d.lat, lon: +d.lon,
    exact: !["city", "town", "village", "municipality", "county", "state", "region", "suburb", "hamlet"].includes(d.addresstype) }));
}

// The routing service looks for a road within 350 m of each point by default. A GPS fix in a
// car park, a building or off a private road can be further away than that, so allow 5 km.
const SNAP_RADIUS_M = 5000;
const snapRadii = (points) => points.map(() => SNAP_RADIUS_M);

// Routes are kept 15 minutes per Worker copy, by their exact points: picking a route option plans
// through the same points the options were made with, so its route needn't be asked for again.
const ROUTE_TTL_MS = 15 * 60 * 1000;
// ---- Turn geometry for turn-by-turn: how much the road really turns at each step, worked out from
// the full route shape (the step types alone call a roundabout where you go straight a "keep left").
function pointBack(route, i, km) { // index about km before i
  let j = i;
  while (j > 0 && route.km[i] - route.km[j] < km) j--;
  return j;
}
function pointAhead(route, i, km) {
  let j = i;
  while (j < route.coords.length - 1 && route.km[j] - route.km[i] < km) j++;
  return j;
}
const signedTurn = (a, b) => ((b - a + 540) % 360) - 180; // + = right
function turnsOf(route) {
  const C = route.coords;
  const out = [];
  let prevName = "";
  for (const st of route.steps) {
    const name = st.name && st.name !== "-" ? st.name : "";
    if (!st.way_points) continue;
    if ([6, 11].includes(st.type)) { if (name) prevName = name; continue; }
    const i0 = st.way_points[0], i1 = st.way_points[1] ?? i0;
    const b0 = pointBack(route, i0, 0.06);
    const before = b0 < i0 ? bearingDeg(C[b0], C[i0]) : null;
    // After: for a roundabout from where you leave it, otherwise 150-250 m on.
    const from = st.type === 7 || st.type === 8 ? i1 : pointAhead(route, i0, 0.15);
    const to = pointAhead(route, from, 0.08);
    const after = to > from ? bearingDeg(C[from], C[to]) : null;
    const angle = before != null && after != null ? Math.round(signedTurn(before, after)) : null;
    // Roundabout-shaped (an untagged roundabout the routing service calls "keep left/right" or a slight
    // turn): within 200 m a right, then a long left, then a right (right-hand traffic). Since .97
    // stricter, after a curvy junction in Houten (Dampolder) showed as a roundabout: only for keep and
    // slight steps, at least 100° of left, and that left turn packed into 80 m (a roundabout is small;
    // a bend in the road is not).
    let flags = "";
    if ([4, 5, 12, 13].includes(st.type) && before != null) {
      let pos = 0, neg = 0, last = before, leftFrom = null, leftTo = null;
      const end = pointAhead(route, i0, 0.2);
      for (let i = i0; i < end; i++) {
        if (route.km[i + 1] - route.km[i] < 0.004) continue;
        const b = bearingDeg(C[i], C[i + 1]);
        const d = signedTurn(last, b);
        if (d > 0) pos += d;
        else if (d < 0) { neg -= d; if (leftFrom == null) leftFrom = route.km[i]; leftTo = route.km[i + 1]; }
        last = b;
      }
      const leftKm = leftFrom == null ? Infinity : leftTo - leftFrom;
      if (pos > 30 && neg >= 100 && pos + neg > 160 && leftKm <= 0.08) flags += "r";
    }
    out.push([Math.round(route.km[i0] * 100) / 100, st.type, name, st.exit_number || 0, angle, flags, prevName]);
    if (name) prevName = name;
  }
  return out;
}

// The routing service's raw answer per route object (kept only as long as the route itself is cached),
// so a /plan in debug mode can store it.
const rawRoute = new WeakMap();
async function getRouteCached(env, points, avoid = null, radii = null) {
  const key = `route:${JSON.stringify(points)}${avoid ? `:${JSON.stringify(avoid)}` : ""}${radii ? `:${radii.join(",")}` : ""}`;
  const hit = memoGet(key);
  if (hit) { countCall("Route from cache"); return hit; }
  const r = await getRoute(env, points, avoid, radii);
  memoSet(key, r, ROUTE_TTL_MS);
  return r;
}

// avoid: small areas the route must not pass (road closures the driver chose to avoid), as rings of [lon, lat].
async function getRoute(env, points, avoid = null, radii = null) {
  const req = { coordinates: points, radiuses: radii || snapRadii(points), instructions: true, extra_info: ["countryinfo", "waycategory"] };
  if (avoid?.length) req.options = { avoid_polygons: { type: "MultiPolygon", coordinates: avoid.map((ring) => [ring]) } };
  const data = await fetchJson(`${ORS_BASE}/directions/driving-car/geojson`, {
    method: "POST",
    headers: orsHeaders(env),
    body: JSON.stringify(req),
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
  // Where the route is on a motorway-class road ("highway" bit of waycategory), as [from, to] indexes.
  const highwaySegs = (f.properties?.extras?.waycategory?.values || []).filter(([, , v]) => (v & 1) === 1).map(([a, b]) => [a, b]);
  const out = {
    coords, km, min, steps, countrySegs, highwaySegs, idIso: {},
    viaKm: firstEnd != null ? km[firstEnd] : null,
    viaKms: ends.map((i) => km[i]), // one per via point, in order
    ends, // route index where each via point is reached
    distanceKm: (f.properties?.summary?.distance || 0) / 1000,
    durationMin: (f.properties?.summary?.duration || 0) / 60,
  };
  rawRoute.set(out, { points, data });
  return out;
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
  // A motorway, E, R(ing), S(chnellstraße), M, B(undesstraße), N(ational) or French D road.
  const m = String(name).match(/\b([AERSMBND])\s?(\d{1,4}[a-z]?)\b/);
  if (m) return `${m[1]}${m[2]}`;
  const de = String(name).match(/autobahn\s?(\d{1,3})\b/i); // "Bundesautobahn 3"
  return de ? `A${de[1]}` : null;
}

// The sequence of numbered roads along the route, with where each starts and ends (km).
function roadsAlong(route) {
  const parts = [];
  const steps = route.steps;
  for (let si = 0; si < steps.length; si++) {
    const st = steps[si];
    let [a, b] = st.way_points || [];
    if (a == null || b == null) continue;
    let ref0 = roadRef(st.name);
    if (!ref0) {
      // A step named after a local street that runs on onto a motorway without an instruction
      // ("De Staart" in Houten, then 26 km of A27 until the next turn): from where the route
      // gets onto the motorway, it's the motorway the next numbered step names.
      const hw = (route.highwaySegs || []).find(([ha, hb]) => hb > a && ha < b);
      const next = steps.slice(si + 1).find((x) => roadRef(x.name));
      if (!hw || !next || route.km[b] - route.km[Math.max(a, hw[0])] < 2) continue;
      a = Math.max(a, hw[0]);
      ref0 = roadRef(next.name);
    }
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
      if (ref[0] === "D" && iso !== "FR") continue; // D numbers only mean a road in France
      const from = route.km[x], to = route.km[y];
      const last = parts[parts.length - 1];
      if (last && last.ref === ref && from - last.toKm < 3) last.toKm = to; // same road, short gap (junction)
      else parts.push({ ref, country: iso, fromKm: from, toKm: to });
    }
  }
  return parts
    // Skip short connectors (a few km of motorway at an interchange), but keep every N or B road
    // of 1 km or more: they're short by nature and you want to see you'll use them (N3 at Dordrecht).
    // Per country: NL/BE/FR N, BE R (ring), AT/DE B, FR M (métropole) from 1 km; FR D from 2 km;
    // motorways (A, AT S, E) from 3 km (A16 between the A15 and the N3).
    .filter((p) => p.toKm - p.fromKm >= (/^[NBRM]/.test(p.ref) ? 1 : p.ref[0] === "D" ? 2 : 3))
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
  const ionityOp = Number(setting(env, "ocmIonityOperatorId"));
  if (ionityOp) byBrand.ionity = [{ id: ionityOp, title: "IONITY (set by hand)" }];
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
// Open Charge Map answers at most OCM_MAX sites per call. A brand with thousands of slow chargers
// (TotalEnergies runs Amsterdam's and Antwerp's street chargers) filled that cap with Dutch sites, so
// a long route lost everything further on (seen 16 Nov: only the Dutch part of a route to France).
// So: other brands are asked for fast (level 3) chargers only, Ionity on its own, and a box that still
// hits the cap is split into four, up to twice.
const OCM_MAX = 2000;
async function ocmBox(env, ids, box, fastOnly, idToBrand, countries, depth = 0) {
  const [minLon, minLat, maxLon, maxLat] = box;
  const url = `${OCM_BASE}/poi/?output=json&compact=true&verbose=false&maxresults=${OCM_MAX}` +
    `&operatorid=${ids.join(",")}${fastOnly ? "&levelid=3" : ""}` +
    `&boundingbox=(${maxLat},${minLon}),(${minLat},${maxLon})&key=${env.OCM_API_KEY}`;
  let data;
  for (let attempt = 0; ; attempt++) {
    const wait = 250 - (Date.now() - ocmLastCall);
    if (wait > 0) await sleep(wait);
    ocmLastCall = Date.now();
    try { data = await fetchJson(url, {}, "Open Charge Map"); break; }
    catch (e) {
      if (attempt < 2 && /returned 429/.test(e.message)) { await sleep(1500 * (attempt + 1)); continue; }
      if (/returned 429/.test(e.message)) throw new HttpError(503, "Open Charge Map is busy (too many requests). Please try again in a minute.");
      throw e;
    }
  }
  if (!Array.isArray(data)) data = [];
  if (data.length >= OCM_MAX && depth < 2) {
    countCall("OCM split box");
    const midLon = (minLon + maxLon) / 2, midLat = (minLat + maxLat) / 2;
    const parts = [[minLon, minLat, midLon, midLat], [midLon, minLat, maxLon, midLat], [minLon, midLat, midLon, maxLat], [midLon, midLat, maxLon, maxLat]];
    const out = [];
    for (const b of parts) out.push(...await ocmBox(env, ids, b, fastOnly, idToBrand, countries, depth + 1));
    return out;
  }
  // Keep only what the app uses, in the same shape as before.
  const list = [];
  for (const p of data) {
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
  return list;
}
async function sitesInBox(env, box, brands = ["ionity"]) {
  const { byBrand, idToBrand, countries } = await brandOperators(env);
  const idsOf = (keys) => [...new Set(keys.flatMap((k) => (byBrand[k] || []).map((o) => o.id)))].sort((a, b) => a - b);
  const ionityIds = brands.includes("ionity") ? idsOf(["ionity"]) : [];
  const otherIds = idsOf(brands.filter((k) => k !== "ionity")).filter((id) => !ionityIds.includes(id));
  if (!ionityIds.length && !otherIds.length) return [];
  // Round outward to 0.05° so nearby lookups (route options, rerouting) reuse the same answer.
  const r = (v, up) => (up ? Math.ceil(v * 20) : Math.floor(v * 20)) / 20;
  const rb = [r(box[0]), r(box[1]), r(box[2], true), r(box[3], true)];
  // ocm3: a new key, so the cut-short answers kept under the old key aren't used again.
  const key = `ocm3:${ionityIds.join(",")}|${otherIds.join(",")}:${rb.join(",")}`;
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
  const seen = new Map();
  if (ionityIds.length) for (const p of await ocmBox(env, ionityIds, rb, false, idToBrand, countries)) seen.set(p.ID, p);
  if (otherIds.length) for (const p of await ocmBox(env, otherIds, rb, true, idToBrand, countries)) seen.set(p.ID, p);
  const list = [...seen.values()];
  memoSet(key, list, 60 * 60 * 1000);
  if (env.USAGE) {
    try { await env.USAGE.put(key, JSON.stringify(list), { expirationTtl: 24 * 3600 }); countCall("KV writes"); } catch (_) {}
  }
  return list;
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
function extractCounts(feature, minKw = FAST_KW) {
  const list = feature.properties?.availabilities || [];
  const valid = list.filter((e) => typeof e.total === "number" && typeof e.available === "number");
  if (!valid.length) return null;
  const dc = valid.filter((e) => String(e.power_type || "").toUpperCase() === "DC");
  // A post often has a CCS and a CHAdeMO cable for one charging spot. Adding both counted one spot
  // twice (Fastned Hoezaar: 9 instead of 8). Count the CCS entries when there are any.
  const ccs = dc.filter((e) => /COMBO|CCS/i.test(String(e.connector_type || "")));
  const use = byPower(ccs.length ? ccs : dc.length ? dc : valid, (e) => (e.power_max || 0) / 1000, minKw);
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

// NDW refuses bursts (about 10 calls a second), so each Worker copy sends at most 3 at a time,
// spaced out a little. More chargers per round (Workers Paid) then take a moment longer, not fail.
let ndwActive = 0, ndwLastStart = 0;
const ndwWaiting = [];
async function ndwSlot() {
  while (ndwActive >= 3) await new Promise((r) => ndwWaiting.push(r));
  ndwActive++;
  const wait = ndwLastStart + 120 - Date.now();
  ndwLastStart = Math.max(Date.now(), ndwLastStart + 120);
  if (wait > 0) await sleep(wait);
}
function ndwDone() { ndwActive--; ndwWaiting.shift()?.(); }
async function ndwFeaturesNear(lat, lon, dLat = 0.004, dLon = 0.006) {
  const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((v) => v.toFixed(6)).join(",");
  await ndwSlot();
  try {
    const data = await fetchJson(`${NDW_BBOX}?bbox=${bbox}`, { headers: { Accept: "application/json" } }, "NDW");
    return data.features || [];
  } finally { ndwDone(); }
}

// ---------------------------------------------------------------- occupancy through the day (Worker 0.10.0)
// The GitHub job occupancy.yml notes every 15 minutes how many chargers are free at the followed brands'
// sites and keeps 8 days on the branch "occ", in tiles of 1 x 1 degree (t_<floor lat>_<floor lon>.json:
// {at, slotMin, sites: {key: {b, cc, tz, lat, lon, n, t, d: {date: 96 characters}}}}; 0-9, a-z = free,
// "." = no reading). Read like the France and Portugal snapshots: the branch's commit from git's ref
// list, then the raw file at that commit, at most once per 5 minutes per tile per Worker copy. No KV.
const OCC_KEEP_DAYS = 8;
const OCC_COUNTRIES = ["NL", "DE", "AT", "FR", "PT"]; // where the job takes readings (told to the app by /me)
const OCC_RAW_AT = (sha, tile) => `https://raw.githubusercontent.com/RemcoNLD/apps/${sha}/${tile}`;
function occBrands(env) {
  if (!setting(env, "occupancy")) return [];
  const raw = String(setting(env, "occupancyBrands") || "ionity, fastned").toLowerCase();
  if (raw.trim() === "all") return BRANDS.map((b) => b.key);
  const keys = raw.split(/[\s,;]+/).filter((k) => BRAND[k]);
  return keys.length ? [...new Set(keys)] : ["ionity"];
}
const occTileName = (lat, lon) => `t_${Math.floor(lat)}_${Math.floor(lon)}.json`;
async function occTile(tile) {
  const memo = memoGet(`occ:${tile}`);
  if (memo !== undefined) return memo;
  const promise = (async () => {
    countCall("Occupancy");
    const sha = await liveSha("occ");
    const res = await fetch(OCC_RAW_AT(sha, tile), { cf: { cacheTtl: 3600 } });
    if (res.status === 404) return null; // nothing followed in this tile
    if (!res.ok) throw new HttpError(502, `Occupancy: HTTP ${res.status}`);
    return await res.json();
  })();
  memoSet(`occ:${tile}`, promise, 5 * 60 * 1000);
  promise.catch(() => memoSet(`occ:${tile}`, undefined, 1));
  return promise;
}
async function handleOccupancy(request, env, url) {
  const lat = Number(url.searchParams.get("lat")), lon = Number(url.searchParams.get("lon"));
  const brand = String(url.searchParams.get("brand") || "ionity");
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new HttpError(400, "Add ?lat=&lon=&brand=");
  if (!occBrands(env).includes(brand)) return json(request, { ok: false, reason: "not followed" });
  // The site may sit just over a tile edge from the pin: look in every tile within ~700 m.
  const tiles = new Set();
  for (const dy of [-0.007, 0, 0.007]) for (const dx of [-0.01, 0, 0.01]) tiles.add(occTileName(lat + dy, lon + dx));
  let best = null, at = null, slotMin = 15;
  for (const t of tiles) {
    const data = await occTile(t);
    if (!data) continue;
    at = data.at; slotMin = data.slotMin || 15;
    for (const [key, s] of Object.entries(data.sites || {})) {
      if (s.b !== brand) continue;
      const d = haversineKm([s.lon, s.lat], [lon, lat]);
      if (d <= 0.6 && (!best || d < best.d)) best = { d, key, s };
    }
  }
  if (!best) return json(request, { ok: false, reason: "no data", at });
  const s = best.s;
  return json(request, { ok: true, at, slotMin, key: best.key, name: s.n, total: s.t, cc: s.cc, tz: s.tz, days: s.d });
}

// Austria for the occupancy job (Worker 0.12.0). E-Control's key is only a Worker secret, so the job
// asks here: GET /occupancy/at?part=N (public, like /occupancy/config: counts of public data only).
// Sites: the followed brands' Austrian sites from Open Charge Map (sitesInBox: kept a day in KV, so
// about one KV write a day). Per part at most OCC_AT_PART sites (each E-Control answer is large, as in
// MAX_AT_LOOKUPS), each part's answer kept 10 minutes per Worker copy, so repeated calls cost nothing.
const OCC_AT_BOX = [9.5, 46.35, 17.2, 49.05];
const OCC_AT_PART = 4;
async function occAtSites(env, brands) {
  const key = `occat:sites:${brands.join(",")}`;
  const memo = memoGet(key);
  if (memo !== undefined) return memo;
  const list = (await sitesInBox(env, OCC_AT_BOX, brands))
    .filter((p) => p.AddressInfo?.Country?.ISOCode === "AT" && Number.isFinite(p.AddressInfo?.Latitude))
    .map((p) => ({ id: p.ID, b: p._brand, lat: p.AddressInfo.Latitude, lon: p.AddressInfo.Longitude, n: p.AddressInfo.Title || "" }))
    .sort((a, b) => a.id - b.id);
  memoSet(key, list, 60 * 60 * 1000);
  return list;
}
async function handleOccupancyAt(request, env, url) {
  const brands = occBrands(env);
  if (!brands.length) return json(request, { ok: false, reason: "off" });
  if (!env.ECONTROL_API_KEY) return json(request, { ok: false, reason: "no E-Control key" });
  const part = Math.max(0, Math.floor(Number(url.searchParams.get("part")) || 0));
  const key = `occat:${brands.join(",")}:${part}`;
  const memo = memoGet(key);
  if (memo !== undefined) return json(request, await memo);
  const promise = (async () => {
    const all = await occAtSites(env, brands);
    const parts = Math.ceil(all.length / OCC_AT_PART);
    const mine = all.slice(part * OCC_AT_PART, (part + 1) * OCC_AT_PART);
    const sites = [];
    for (const s of mine) {
      let st = null;
      try { st = await atStatus({ lat: s.lat, lon: s.lon }, env, BRAND[s.b] || BRAND.ionity); }
      catch (e) { console.log("Occupancy AT failed", s.id, e.message); }
      if (st && st.available != null && st.total) sites.push({ ...s, free: st.available, total: st.total });
    }
    return { ok: true, at: new Date().toISOString(), part, parts, count: all.length, sites };
  })();
  memoSet(key, promise, 10 * 60 * 1000);
  promise.catch(() => memoSet(key, undefined, 1));
  return json(request, await promise);
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
  points = byPower(points, (p) => p.capacityKw, station.minKw); // fast ones only, at your power if any
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
  points = byPower(points, (p) => p.kw, station.minKw); // fast ones only, at your power if any
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

// ---------------------------------------------------------------- France (transport.data.gouv.fr)
// The national live file has no area or id query: always the whole country (~9.5 MB CSV,
// id_pdc_itinerance,etat_pdc,occupation_pdc,horodatage,…). Reading it whole costs ~20–30 ms CPU,
// more than the free plan allows per request. If the server allows Range requests, each Worker
// call can read one piece (~1 MB) instead; the app would ask for the pieces side by side.
const FR_DYNAMIC_URL = "https://transport.data.gouv.fr/resources/84098/download";
const FR_PIECE_OVERLAP = 2048; // bytes read past a piece's end, so its last line is complete

// Size of the file and whether Range works. Reads at most 1 kB of body.
async function frProbe() {
  countCall("PAN FR");
  const res = await fetch(FR_DYNAMIC_URL, { headers: { Range: "bytes=0-1023" } });
  const h = (k) => res.headers.get(k);
  const total = Number((h("content-range") || "").split("/")[1]) || null;
  let head = "";
  if (res.body) {
    const reader = res.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    head = new TextDecoder().decode((value || new Uint8Array()).subarray(0, 1024));
  }
  return {
    status: res.status,
    rangeWorks: res.status === 206 && !!total,
    total,
    finalUrl: res.url,
    redirected: res.redirected,
    headers: {
      "content-range": h("content-range"), "accept-ranges": h("accept-ranges"),
      "content-length": h("content-length"), "content-encoding": h("content-encoding"),
      "content-type": h("content-type"), "last-modified": h("last-modified"), etag: h("etag"),
      "cache-control": h("cache-control"), age: h("age"),
    },
    firstLines: head.split("\n").slice(0, 3),
  };
}

// One piece of the file: the lines that START inside bytes [start, end]. Returns rows for the wanted ids
// (the newest horodatage wins when an id appears twice) and how many lines were read.
async function frPiece(total, part, parts, ids, url = FR_DYNAMIC_URL) {
  const start = Math.floor((total * part) / parts);
  const end = Math.floor((total * (part + 1)) / parts) - 1;
  const from = Math.max(0, start - 1); // one byte early: tells whether `start` begins a line
  const to = Math.min(total - 1, end + FR_PIECE_OVERLAP);
  countCall("PAN FR");
  const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}` } });
  if (res.status !== 206) {
    res.body?.cancel?.().catch?.(() => {});
    throw new HttpError(502, `French live file: expected a partial answer (206), got ${res.status}`);
  }
  const text = await res.text();
  let pos = 0;
  if (start > 0) {
    const nl = text.indexOf("\n");
    pos = nl < 0 ? text.length : nl + 1; // `from` is start-1, so a line starting at `start` begins at index 1
  }
  const limit = end - from; // a line must start at or before this index (relative to `from`)
  const rows = {};
  let lines = 0, cut = false;
  while (pos <= limit && pos < text.length) {
    const nl = text.indexOf("\n", pos);
    if (nl < 0 && to < total - 1) { cut = true; break; } // a line longer than the overlap: shouldn't happen
    const lineEnd = nl < 0 ? text.length : nl;
    const comma = text.indexOf(",", pos);
    if (comma > pos && comma < lineEnd) {
      const id = text.slice(pos, comma);
      if (ids.has(id)) {
        const [etat, occupation, horodatage] = text.slice(comma + 1, lineEnd).replace(/\r$/, "").split(",");
        const prev = rows[id];
        if (!prev || String(horodatage) > String(prev.horodatage)) rows[id] = { etat, occupation, horodatage };
      }
    }
    lines++;
    pos = lineEnd + 1;
  }
  return { part, parts, bytes: { from, to, start, end }, lines, cut, rows };
}

// The whole live file, read as a stream (no Range needed): rows for the wanted ids, newest horodatage wins.
// Lean scan (about half the CPU of splitting every line): most lines belong to operators we don't
// show, so the first five characters (country + operator code) are checked first without making a
// string; only lines whose prefix is in the index are cut up.
const frKey5 = (t, p) => ((((t.charCodeAt(p + 2) * 128 + t.charCodeAt(p + 3)) * 128 + t.charCodeAt(p + 4)) * 128 + t.charCodeAt(p)) * 128 + t.charCodeAt(p + 1));
let frPrefixCache = null; // { ids, set }
async function frWhole(ids, url = FR_DYNAMIC_URL) {
  countCall("PAN FR");
  // Given up after 22 s (the app waits 30): a slow download then gets a proper message.
  const res = await fetch(url, { signal: AbortSignal.timeout(22000) }).catch((e) => {
    throw new HttpError(504, e.name === "TimeoutError" ? "The French live file is downloading slowly; try again later" : `French live file: ${e.message}`);
  });
  if (!res.ok || !res.body) throw new HttpError(502, `French live file: HTTP ${res.status}`);
  if (frPrefixCache?.ids !== ids) frPrefixCache = { ids, set: new Set([...ids].filter((id) => id.length > 5).map((id) => frKey5(id, 0))) };
  const prefixes = frPrefixCache.set;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const rows = {};
  let rest = "", lines = 0, bytes = 0;
  const scan = (text, last) => {
    let pos = 0, nl;
    for (;;) {
      nl = text.indexOf("\n", pos);
      if (nl < 0) { if (!last) break; nl = text.length; if (nl <= pos) break; }
      lines++;
      if (nl - pos > 6 && prefixes.has(frKey5(text, pos))) {
        const comma = text.indexOf(",", pos);
        if (comma > pos && comma < nl) {
          const id = text.slice(pos, comma);
          if (ids.has(id)) {
            const end = text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
            const [etat, occupation, horodatage] = text.slice(comma + 1, end).split(",");
            const prev = rows[id];
            if (!prev || String(horodatage) > String(prev.horodatage)) rows[id] = { etat, occupation, horodatage };
          }
        }
      }
      pos = nl + 1;
      if (pos >= text.length) break;
    }
    return pos >= text.length ? "" : text.slice(pos);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    rest = scan(rest + dec.decode(value, { stream: true }), false);
  }
  scan(rest + dec.decode(), true);
  return { bytes, lines, rows };
}

// France live status: the index (data/fr-fast-sites.json) places the sites; their state comes from the
// 5-minute snapshot below. frWhole() above (the old whole-file read) is only used by /debug/fr-range now.
const FR_INDEX_URL = "https://remconld.github.io/apps/data/fr-fast-sites.json"; // tools/build-fr-index.py
const FR_INDEX_MS = 24 * 3600 * 1000;
const FR_NOT_LIVE_MS = 24 * 3600 * 1000; // newest change at a site older than this: its data looks frozen
const FR_MATCH_KM = 0.6;   // Open Charge Map pin → index site of the same brand
const FR_NEARBY_KM = 1.2;  // sites sent back for the app's pin matching (like NDW's nearby)
const FR_MAX_STATIONS = 250;
const FR_CELL = 0.02;      // grid for the index, ~2 km

let frIndexState = null; // { at, promise }
async function frIndex() {
  if (frIndexState && Date.now() - frIndexState.at < FR_INDEX_MS) return frIndexState.promise;
  const promise = (async () => {
    countCall("PAN FR index");
    const res = await fetch(FR_INDEX_URL, { cf: { cacheTtl: 3600 } });
    if (!res.ok) throw new HttpError(502, `France index: HTTP ${res.status}`);
    const data = await res.json();
    const ids = new Set(), grid = new Map();
    const sites = data.sites.map(([brand, lat, lon, maxKw, name, pdcIds, pdcKw], i) => {
      for (const id of pdcIds) ids.add(id);
      // pdcKw: each point's power, same order as pdcIds (index from 17 Nov; older ones lack it).
      const site = { key: `fr${i}`, brand, lat, lon, maxKw, name, ids: pdcIds, kw: Array.isArray(pdcKw) ? pdcKw : null };
      const k = `${brand}|${Math.floor(lat / FR_CELL)}|${Math.floor(lon / FR_CELL)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(site);
      return site;
    });
    return { built: data.built, ids, grid, count: sites.length };
  })();
  frIndexState = { at: Date.now(), promise };
  promise.catch(() => { if (frIndexState?.promise === promise) frIndexState = null; });
  return promise;
}
function frSitesNear(index, brand, lat, lon, km) {
  const out = [];
  const cy = Math.floor(lat / FR_CELL), cx = Math.floor(lon / FR_CELL);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    for (const s of index.grid.get(`${brand}|${cy + dy}|${cx + dx}`) || []) {
      const d = haversineKm([s.lon, s.lat], [lon, lat]);
      if (d <= km) out.push({ s, d });
    }
  }
  return out.sort((a, b) => a.d - b.d);
}

// France live (Worker 0.4.0): a GitHub job (.github/workflows/fr-live.yml, tools/build-fr-status.py) reads
// the national file every 5 minutes and force-pushes a small fr-status.json to the branch "live-fr", like
// Portugal. The Worker only reads that (~180 kB, by commit id), so France updates by itself in /status,
// with no CPU spike (the whole-file read gave Error 1102) and no KV writes. The snapshot is the server's
// last known state: always there, with its own age (checkedAt = when the job read the file).
const FR_LIVE_URL = `https://raw.githubusercontent.com/RemcoNLD/apps/live-fr/fr-status.json`;
const FR_RAW_AT = (sha) => `https://raw.githubusercontent.com/RemcoNLD/apps/${sha}/fr-status.json`;
const FR_TOO_OLD_MS = 6 * 3600 * 1000; // older than this: the job is down; numbers would mislead
let frSnapState = null, frSnapLast = null; // frSnapLast: { sha, data } of the last snapshot read
async function frSnapshot() {
  if (frSnapState && Date.now() - frSnapState.at < PT_SNAPSHOT_MS) return frSnapState.promise;
  const promise = (async () => {
    countCall("FR live");
    let sha = null;
    try { sha = await liveSha("live-fr"); } catch (e) { console.log("France refs failed", e.message); }
    if (sha && frSnapLast?.sha === sha) return frSnapLast.data;
    const res = await fetch(sha ? FR_RAW_AT(sha) : FR_LIVE_URL, { cf: { cacheTtl: sha ? 3600 : 60 } });
    if (!res.ok) throw new HttpError(502, `France live: HTTP ${res.status}`);
    const data = await res.json();
    if (sha) frSnapLast = { sha, data };
    return data;
  })();
  frSnapState = { at: Date.now(), promise };
  // A failed read keeps the last good snapshot (last known) rather than nothing.
  promise.catch(() => { if (frSnapState?.promise === promise) frSnapState = frSnapLast ? { at: Date.now(), promise: Promise.resolve(frSnapLast.data) } : null; });
  return promise;
}

// One index site → counts. Letters per point (index order): F free, U in use, O out of order, ? unknown,
// - not in the live file (old ids stay in the static file; only points in the live file count).
function frSummary(site, snap, minKw = FAST_KW) {
  const base = { maxKw: site.maxKw, source: "transport.data.gouv.fr", checkedAt: snap.at };
  const rec = snap.s?.[site.key.slice(2)];
  if (!rec) return { ...base, available: null, total: null, note: "no live data for this site" };
  const [codes, ages] = rec;
  const atMs = Date.parse(snap.at);
  const all = [...codes].map((c, i) => ({ c, kw: site.kw?.[i], age: ages?.[i] })).filter((p) => p.c !== "-");
  const live = site.kw ? byPower(all, (p) => p.kw, minKw) : all;
  if (!live.length) return { ...base, available: null, total: null, note: "no live data for this site" };
  const time = (p) => (p.age == null ? null : atMs - p.age * 60000);
  const times = live.map(time).filter((t) => t != null);
  const newest = times.length ? Math.max(...times) : 0;
  const changedAt = newest ? new Date(newest).toISOString() : null;
  if (!newest || atMs - newest > FR_NOT_LIVE_MS) {
    return { ...base, available: null, total: null, changedAt, note: "live data looks frozen" };
  }
  // Out-of-order points stay in the total and come back as offline (grey outlined segments).
  const offline = live.filter((p) => p.c === "O").length;
  const free = live.filter((p) => p.c === "F").length;
  const known = live.filter((p) => p.c === "F" || p.c === "U").length;
  if (offline === live.length) return { ...base, available: 0, total: live.length, offline, state: "likely_offline", changedAt };
  if (!known) return { ...base, available: null, total: live.length, offline, changedAt, note: "occupation unknown" };
  const state = free ? "free" : "full";
  const taken = live.filter((p) => p.c === "U" || p.c === "?").map(time).filter((t) => t != null);
  return {
    ...base, available: free, total: live.length, offline, state, changedAt,
    fullSince: state === "full" && taken.length ? new Date(Math.max(...taken)).toISOString() : null,
  };
}

async function frStatusFor(stations, minKw = FAST_KW) {
  const out = {};
  if (!stations.length) return { status: out };
  let index, snap;
  try {
    [index, snap] = await Promise.all([frIndex(), frSnapshot()]);
  } catch (e) {
    console.log("France failed", e.message);
    for (const st of stations) out[st.id] = { failed: true, note: `lookup failed: ${String(e.message).slice(0, 80)}` };
    return { status: out };
  }
  const tooOld = !Date.parse(snap.at) || Date.now() - Date.parse(snap.at) > FR_TOO_OLD_MS;
  const sameIndex = !snap.index || snap.index === index.built; // site numbers only hold for the same index
  for (const st of stations.slice(0, FR_MAX_STATIONS)) {
    const kw = minKwOf(st.minKw ?? minKw);
    const brand = brandOf(st.brand).key;
    const near = frSitesNear(index, brand, Number(st.lat), Number(st.lon), FR_NEARBY_KM);
    if (!near.length || near[0].d > FR_MATCH_KM) { out[st.id] = null; continue; }
    if (tooOld || !sameIndex) {
      out[st.id] = { available: null, total: null, source: "transport.data.gouv.fr", checkedAt: snap.at, note: tooOld ? "live data out of date" : "index changed; next snapshot in a few minutes" };
      continue;
    }
    const main = near[0].s;
    out[st.id] = {
      ...frSummary(main, snap, kw), liveId: main.key, liveLat: main.lat, liveLon: main.lon,
      nearby: near.slice(0, 4).map(({ s }) => {
        const c = frSummary(s, snap, kw);
        return { id: s.key, lat: s.lat, lon: s.lon, name: s.name || null, available: c.available, total: c.total,
          offline: c.offline, maxKw: c.maxKw, state: c.state, changedAt: c.changedAt, fullSince: c.fullSince };
      }),
    };
  }
  return { status: out, checkedAt: snap.at, index: index.built };
}

// Portugal live status (MOBI.E / NAP Portugal, DATEX II, open access). The national status file is
// ~36-40 MB of XML, far beyond the free plan's ~10 ms CPU, so it is never read here: a GitHub Actions job
// (.github/workflows/pt-live.yml, tools/build-pt-status.py) reads it every 5 minutes and force-pushes a
// small pt-status.json (only the stalls of data/pt-fast-sites.json) to the repo's branch "live". Each
// Worker copy reads that file at most once a minute, so Portugal updates by itself like NL/DE/AT,
// with no KV writes and next to no CPU. checkedAt is the source's publication time, so the app ages it
// honestly (it allows Portugal more minutes before greying, PT_STALE_MS in the app).
const PT_INDEX_URL = "https://remconld.github.io/apps/data/pt-fast-sites.json"; // tools/build-pt-index.py
const PT_LIVE_URL = "https://raw.githubusercontent.com/RemcoNLD/apps/live/pt-status.json";
const PT_INDEX_MS = 24 * 3600 * 1000;
const PT_SNAPSHOT_MS = 60 * 1000;
const PT_TOO_OLD_MS = 30 * 60 * 1000; // snapshot older than this: the job or the feed is down, show nothing
const PT_MATCH_KM = 0.6, PT_NEARBY_KM = 1.2, PT_CELL = 0.02;
const PT_MAX_STATIONS = 120;

let ptIndexState = null;
async function ptIndex() {
  if (ptIndexState && Date.now() - ptIndexState.at < PT_INDEX_MS) return ptIndexState.promise;
  const promise = (async () => {
    countCall("PT index");
    const res = await fetch(PT_INDEX_URL, { cf: { cacheTtl: 3600 } });
    if (!res.ok) throw new HttpError(502, `Portugal index: HTTP ${res.status}`);
    const data = await res.json();
    const grid = new Map();
    for (const [id, brand, operator, lat, lon, maxKw, name, pointIds, pointKw] of data.sites) {
      const key = brandOfSite(brand, operator, name, pointIds);
      if (!key) continue; // an operator that isn't one of the app's brands (yet)
      const site = { key: id, brand: key, lat, lon, maxKw, name, kw: pointKw || [], n: pointIds.length };
      const k = `${key}|${Math.floor(lat / PT_CELL)}|${Math.floor(lon / PT_CELL)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(site);
    }
    return { built: data.built, grid };
  })();
  ptIndexState = { at: Date.now(), promise };
  promise.catch(() => { if (ptIndexState?.promise === promise) ptIndexState = null; });
  return promise;
}
// The index names a brand where the builder recognised one; otherwise the Worker's own patterns decide,
// so a brand added to BRANDS also works for Portugal before the next weekly index build.
function brandOfSite(brand, operator, name, pointIds) {
  if (brand && BRAND[brand]) return brand;
  for (const b of BRANDS) if ((pointIds || []).some((id) => b.evse.test(String(id)))) return b.key;
  const words = `${operator || ""} ${name || ""}`;
  for (const b of BRANDS) if (b.live.test(words)) return b.key;
  return null;
}
function ptSitesNear(index, brand, lat, lon, km) {
  const out = [];
  const cy = Math.floor(lat / PT_CELL), cx = Math.floor(lon / PT_CELL);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    for (const s of index.grid.get(`${brand}|${cy + dy}|${cx + dx}`) || []) {
      const d = haversineKm([s.lon, s.lat], [lon, lat]);
      if (d <= km) out.push({ s, d });
    }
  }
  return out.sort((a, b) => a.d - b.d);
}

let ptSnapState = null, ptSnapLast = null; // ptSnapLast: { sha, data } of the last snapshot read
// raw.githubusercontent.com caches a branch URL for up to 5 minutes and ignores query strings (measured
// 17 Nov: a new snapshot stayed invisible for minutes). A URL with the commit id is new for every push,
// so it is always fresh: read the branch's commit id from git's own ref list (~0.5 kB, never cached,
// no API rate limit), then the file at that commit, and only when the commit changed.
const PT_REFS_URL = "https://github.com/RemcoNLD/apps.git/info/refs?service=git-upload-pack";
const PT_RAW_AT = (sha) => `https://raw.githubusercontent.com/RemcoNLD/apps/${sha}/pt-status.json`;
// One ref list read serves both branches (live = Portugal, live-fr = France) for 20 s.
let refsState = null;
async function liveSha(branch) {
  if (!refsState || Date.now() - refsState.at > 20 * 1000) {
    const promise = fetch(PT_REFS_URL, { headers: { "User-Agent": "EVailability-Worker" } }).then((res) => {
      if (!res.ok) throw new Error(`refs HTTP ${res.status}`);
      return res.text();
    });
    refsState = { at: Date.now(), promise };
    promise.catch(() => { if (refsState?.promise === promise) refsState = null; });
  }
  const m = (await refsState.promise).match(new RegExp(`([0-9a-f]{40}) refs/heads/${branch}(?![\\w-])`));
  if (!m) throw new Error(`no ${branch} branch`);
  return m[1];
}
const ptLiveSha = () => liveSha("live");
async function ptSnapshot() {
  if (ptSnapState && Date.now() - ptSnapState.at < PT_SNAPSHOT_MS) return ptSnapState.promise;
  const promise = (async () => {
    countCall("PT live");
    let sha = null;
    try { sha = await ptLiveSha(); } catch (e) { console.log("Portugal refs failed", e.message); }
    if (sha && ptSnapLast?.sha === sha) return ptSnapLast.data; // nothing new since the last read
    const url = sha ? PT_RAW_AT(sha) : PT_LIVE_URL; // without the commit id: the (maybe older) branch copy
    const res = await fetch(url, { cf: { cacheTtl: sha ? 3600 : 60 } });
    if (!res.ok) throw new HttpError(502, `Portugal live: HTTP ${res.status}`);
    const data = await res.json();
    if (sha) ptSnapLast = { sha, data };
    return data;
  })();
  ptSnapState = { at: Date.now(), promise };
  promise.catch(() => { if (ptSnapState?.promise === promise) ptSnapState = null; });
  return promise;
}

// One index site → counts at the chosen power. Letters per point: F free, U in use, O out of order,
// ? unknown, - not in the live file (left out). Out-of-order stalls stay in the total (grey segments).
function ptSummary(site, snap, minKw = FAST_KW) {
  const base = { maxKw: site.maxKw, source: "MOBI.E / NAP Portugal", checkedAt: snap.pub };
  const rec = snap.s?.[site.key];
  if (!rec) return { ...base, available: null, total: null, note: "no live data for this site" };
  const [codes, ages] = rec;
  const pubMs = Date.parse(snap.pub);
  const all = [...codes].map((c, i) => ({ c, kw: site.kw[i], age: ages?.[i] })).filter((p) => p.c !== "-");
  const live = byPower(all, (p) => p.kw, minKw);
  if (!live.length) return { ...base, available: null, total: null, note: "no live data for this site" };
  const at = (p) => (p.age == null ? null : pubMs - p.age * 60000);
  const times = live.map(at).filter((t) => t != null);
  const changedAt = times.length ? new Date(Math.max(...times)).toISOString() : null;
  const offline = live.filter((p) => p.c === "O").length;
  const free = live.filter((p) => p.c === "F").length;
  const known = live.filter((p) => p.c === "F" || p.c === "U").length;
  if (offline === live.length) return { ...base, available: 0, total: live.length, offline, state: "likely_offline", changedAt };
  if (!known) return { ...base, available: null, total: live.length, offline, changedAt, note: "status unknown" };
  const state = free ? "free" : "full";
  const taken = live.filter((p) => p.c === "U").map(at).filter((t) => t != null);
  return {
    ...base, available: free, total: live.length, offline, state, changedAt,
    fullSince: state === "full" && taken.length ? new Date(Math.max(...taken)).toISOString() : null,
  };
}

// All Portuguese stations of one /status call from one snapshot read.
async function ptStatusFor(stations) {
  const out = {};
  if (!stations.length) return out;
  let index, snap;
  try {
    [index, snap] = await Promise.all([ptIndex(), ptSnapshot()]);
  } catch (e) {
    console.log("Portugal failed", e.message);
    for (const st of stations) out[st.id] = { failed: true, note: `lookup failed: ${String(e.message).slice(0, 80)}` };
    return out;
  }
  const tooOld = !Date.parse(snap.pub) || Date.now() - Date.parse(snap.pub) > PT_TOO_OLD_MS;
  for (const st of stations.slice(0, PT_MAX_STATIONS)) {
    const brand = brandOf(st.brand).key;
    const near = ptSitesNear(index, brand, Number(st.lat), Number(st.lon), PT_NEARBY_KM);
    if (!near.length || near[0].d > PT_MATCH_KM) { out[st.id] = null; continue; }
    if (tooOld) { out[st.id] = { available: null, total: null, source: "MOBI.E / NAP Portugal", checkedAt: snap.pub, note: "live data out of date" }; continue; }
    const main = near[0].s;
    out[st.id] = {
      ...ptSummary(main, snap, st.minKw), liveId: main.key, liveLat: main.lat, liveLon: main.lon,
      nearby: near.slice(0, 4).map(({ s }) => {
        const c = ptSummary(s, snap, st.minKw);
        return { id: s.key, lat: s.lat, lon: s.lon, name: s.name || null, available: c.available, total: c.total,
          offline: c.offline, maxKw: c.maxKw, state: c.state, changedAt: c.changedAt, fullSince: c.fullSince };
      }),
    };
  }
  return out;
}

// Belgium live status (Eco-Movement, DATEX II). The static index (tools/build-be-index.py) gives each
// site's fast DC stalls; live status exists only per stall (/datex2/v1/status/{evse_id}), and only one
// request every 10 s per IP is allowed across all endpoints (2 per minute per stall, per token). So
// Belgium is tap-only and stall by stall: /be-status matches the app's pins to index sites (no call to
// Eco-Movement), /be-evse asks one stall; the app paces them and fills the ring as answers come in.
const BE_INDEX_URL = "https://remconld.github.io/apps/data/be-fast-sites.json?v=3"; // bump v after a rebuild (Cloudflare caches it an hour)
const BE_STATUS_BASE = "https://nap-be.eco-movement.com/datex2/v1/status/";
const BE_GAP_MS = 10 * 1000;       // Eco-Movement: 1 request per 10 s per IP
const BE_EVSE_TTL_MS = 60 * 1000;  // a stall's answer is reused for a minute
const BE_MATCH_KM = 0.6, BE_ANY_KM = 0.3, BE_NEARBY_KM = 1.2, BE_MAX_STATIONS = 150, BE_CELL = 0.02;

let beIndexState = null;
async function beIndex() {
  if (beIndexState && Date.now() - beIndexState.at < 24 * 3600 * 1000) return beIndexState.promise;
  const promise = (async () => {
    countCall("BE index");
    const res = await fetch(BE_INDEX_URL, { cf: { cacheTtl: 3600 } });
    if (!res.ok) throw new HttpError(502, `Belgium index: HTTP ${res.status}`);
    const data = await res.json();
    const grid = new Map();
    data.sites.forEach(([brand, lat, lon, maxKw, name, evseIds, evseKw], i) => {
      // evseKw: each stall's power, same order as evseIds (once the index is rebuilt with it).
      const site = { key: `be${i}`, brand, lat, lon, maxKw, name, evseIds, kw: Array.isArray(evseKw) ? evseKw : null };
      for (const b of [brand, "*"]) { // "*": every operator, for the same-spot fallback
        const k = `${b}|${Math.floor(lat / BE_CELL)}|${Math.floor(lon / BE_CELL)}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(site);
      }
    });
    return { built: data.built, grid, count: data.sites.length };
  })();
  beIndexState = { at: Date.now(), promise };
  promise.catch(() => { if (beIndexState?.promise === promise) beIndexState = null; });
  return promise;
}
function beSitesNear(index, brand, lat, lon, km) {
  const out = [];
  const cy = Math.floor(lat / BE_CELL), cx = Math.floor(lon / BE_CELL);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    for (const s of index.grid.get(`${brand}|${cy + dy}|${cx + dx}`) || []) {
      const d = haversineKm([s.lon, s.lat], [lon, lat]);
      if (d <= km) out.push({ s, d });
    }
  }
  return out.sort((a, b) => a.d - b.d);
}
// Belgium's last known state (Worker 0.4.0), like ParkPilot's stored waiting times: every stall answer
// from Eco-Movement is kept in one KV record "be-last" = {evse: [kind, checkedAt, raw]}, written only when
// a stall's state changes or its stored value is over 30 minutes old (10 until Worker 0.5.0), so a tap's answers outlive the
// 60-second memory cache and every Worker copy. /be-status sends them with each site, so a new route
// (or a replan) shows the stalls' last known state at once; the app greys it by its age.
const BE_LAST_KEY = "be-last";
const BE_LAST_REWRITE_MS = 30 * 60 * 1000; // 0.5.0: was 10 min; the app (0.31) checks the next Belgian site every 10 min, so an unchanged stall would be rewritten every round
const BE_LAST_KEEP_MS = 7 * 24 * 3600 * 1000;
let beLastState = null; // { at, data } — read at most once a minute per Worker copy
async function beLast(env, fresh = false) {
  if (!env?.USAGE) return {};
  if (!fresh && beLastState && Date.now() - beLastState.at < 60 * 1000) return beLastState.data;
  let data = {};
  try { data = JSON.parse((await kvGet(env, BE_LAST_KEY)) || "{}") || {}; } catch { data = beLastState?.data || {}; }
  beLastState = { at: Date.now(), data };
  return data;
}
async function beRemember(env, r) {
  if (!env?.USAGE || !r?.evse || !r.checkedAt) return;
  const prev = (await beLast(env))[r.evse];
  if (prev && prev[0] === r.kind && Date.parse(r.checkedAt) - Date.parse(prev[1]) < BE_LAST_REWRITE_MS) return;
  const data = { ...(await beLast(env, true)) }; // read again just before writing: fewer lost updates between copies
  data[r.evse] = [r.kind, r.checkedAt, r.raw || null];
  const keep = Date.now() - BE_LAST_KEEP_MS;
  for (const [k, v] of Object.entries(data)) if (!(Date.parse(v?.[1]) > keep)) delete data[k];
  try {
    await env.USAGE.put(BE_LAST_KEY, JSON.stringify(data));
    countCall("KV writes"); countCall("Belgium last known");
    beLastState = { at: Date.now(), data };
  } catch (e) { console.log("Belgium last known: write failed", e.message); }
}
// A site's stalls from the last known record: {stalls: {evse: {kind, raw, at}}, checkedAt: the oldest of them}.
function beLastFor(last, ids) {
  const stalls = {};
  let oldest = null;
  for (const id of ids) {
    const v = last[id];
    if (!v) continue;
    stalls[id] = { kind: v[0], raw: v[2] || null, at: v[1] };
    if (!oldest || v[1] < oldest) oldest = v[1];
  }
  return oldest ? { stalls, checkedAt: oldest, lastKnown: true } : {};
}

async function beStatusFor(stations, minKw = FAST_KW, env = null) {
  const [index, last] = await Promise.all([beIndex(), beLast(env).catch(() => ({}))]);
  const out = {};
  // Only the stalls at your power, if the index knows each stall's power: fewer calls, a truer count.
  const stalls = (s) => s.kw ? byPower(s.evseIds.map((id, i) => ({ id, kw: s.kw[i] })), (p) => p.kw, minKw).map((p) => p.id) : s.evseIds;
  const site = (s) => { const ids = stalls(s); return { be: true, available: null, total: ids.length, evseIds: ids, maxKw: s.maxKw,
    source: "Eco-Movement (BE)", ...beLastFor(last, ids) }; };
  for (const st of stations.slice(0, BE_MAX_STATIONS)) {
    const near = beSitesNear(index, brandOf(st.brand).key, Number(st.lat), Number(st.lon), BE_NEARBY_KM);
    if (!near.length || near[0].d > BE_MATCH_KM) {
      // No site of this brand: Open Charge Map's brand may be outdated (Nazareth E17: TotalEnergies there,
      // Circle K/Spirii in the Belgian feed). Then any fast site on the same spot, and only that one.
      const any = beSitesNear(index, "*", Number(st.lat), Number(st.lon), BE_ANY_KM)[0];
      out[st.id] = any ? { ...site(any.s), liveId: any.s.key, liveLat: any.s.lat, liveLon: any.s.lon, otherOperator: true,
        nearby: [{ id: any.s.key, lat: any.s.lat, lon: any.s.lon, name: any.s.name || null, ...site(any.s) }] } : null;
      continue;
    }
    const main = near[0].s;
    out[st.id] = {
      ...site(main), liveId: main.key, liveLat: main.lat, liveLon: main.lon,
      nearby: near.slice(0, 4).map(({ s }) => ({ id: s.key, lat: s.lat, lon: s.lon, name: s.name || null, ...site(s) })),
    };
  }
  return { status: out, index: index.built, gapMs: BE_GAP_MS };
}

// DATEX II v3 refill point status → the app's kinds.
const BE_KIND = {
  available: "free",
  charging: "busy", occupied: "busy", reserved: "busy", blocked: "busy",
  faulted: "off", inoperative: "off", outoforder: "off", outofstock: "off", unavailable: "off", removed: "off", planned: "off",
};
// Finds the stall's status in the answer without relying on the exact nesting (the Belgian profile isn't
// published; it follows the German NAP mapping). /debug/be shows the raw answer if this misreads it.
function beParseStatus(data, evse) {
  const norm = (x) => String(x || "").replace(/\*/g, "").toUpperCase();
  const want = norm(evse);
  const all = [];
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { for (const x of o) walk(x); return; }
    const st = o.status?.value ?? (typeof o.status === "string" ? o.status : null);
    if (st && BE_KIND[String(st).toLowerCase()] !== undefined || st === "unknown") {
      all.push({ ref: o.reference?.idG ?? o.idG ?? o.evseId ?? null, raw: st, lastUpdated: o.lastUpdated || o.statusUpdateTime || null });
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(data);
  const pick = all.find((x) => x.ref && norm(x.ref) === want) || all[0];
  return pick ? { raw: pick.raw, kind: BE_KIND[String(pick.raw).toLowerCase()] || "unknown", lastUpdated: pick.lastUpdated } : null;
}

let beNextAt = 0;        // this Worker copy's next allowed call (the IP limit is shared, so it's only a guide)
let beBlockedUntil = 0;  // after a 429: Eco-Movement's own wait
async function beEvse(env, evse) {
  if (!env.ECO_BE_TOKEN) throw new HttpError(500, "ECO_BE_TOKEN is not set");
  if (!/^[A-Za-z0-9*\-_.|]{4,160}$/.test(evse)) throw new HttpError(400, "Bad EVSE id");
  const hit = memoGet(`be:${evse}`);
  if (hit) return { ...hit, cached: true };
  // "evseId|feedId": ask by the official EVSE id; if Eco-Movement doesn't know it, by the feed's id next time.
  const ids = evse.split("|");
  const tried = memoGet(`be-miss:${evse}`) || 0;
  const ask = ids[Math.min(tried, ids.length - 1)];
  const now = Date.now();
  const wait = Math.max(beNextAt, beBlockedUntil) - now;
  if (wait > 0) return { evse, retryAfterMs: wait };
  beNextAt = now + BE_GAP_MS;
  countCall("Eco-Movement BE");
  // Eco-Movement sometimes doesn't answer; give up after 8 s so the app's request doesn't time out instead.
  let res;
  try {
    res = await fetch(BE_STATUS_BASE + encodeURIComponent(ask), {
      headers: { Authorization: `Bearer ${env.ECO_BE_TOKEN}`, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    return { evse, retryAfterMs: BE_GAP_MS, slow: true, note: e.name === "TimeoutError" ? "no answer within 8 s" : e.message };
  }
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after")) || Number(res.headers.get("x-ratelimit-reset")) || 10;
    const ms = ra > 1e9 ? ra * 1000 - Date.now() : ra * 1000; // seconds, or an epoch time
    beBlockedUntil = Date.now() + Math.min(Math.max(ms, 5000), 120000);
    return { evse, retryAfterMs: beBlockedUntil - Date.now(), limited: true };
  }
  if (res.status === 404) {
    if (tried + 1 < ids.length) { memoSet(`be-miss:${evse}`, tried + 1, 24 * 3600 * 1000); return { evse, retryAfterMs: BE_GAP_MS, tryOtherId: true }; }
    const r = { evse, kind: "unknown", note: "not found", asked: ask, checkedAt: new Date().toISOString() };
    memoSet(`be:${evse}`, r, BE_EVSE_TTL_MS);
    return r;
  }
  if (!res.ok) throw new HttpError(502, `Eco-Movement BE: HTTP ${res.status}`);
  const data = await res.json().catch(() => null);
  const parsed = beParseStatus(data, ask) || (ids.length > 1 ? beParseStatus(data, ids.find((x) => x !== ask)) : null);
  const r = { evse, asked: ask, kind: parsed?.kind || "unknown", raw: parsed?.raw || null, lastUpdated: parsed?.lastUpdated || null,
    checkedAt: new Date().toISOString() };
  memoSet(`be:${evse}`, r, BE_EVSE_TTL_MS);
  return r;
}

async function liveStatus(station, env) {
  if (!LIVE_COUNTRIES.has(station.country)) return null;
  const brand = brandOf(station.brand);
  const key = `status:${station.id}:${station.minKw || FAST_KW}`;
  const cached = memoGet(key);
  if (cached !== undefined) return cached;
  let status = null, failed = null;
  if (station.country === "DE") {
    try { status = await deStatus(station, brand); } catch (e) { failed = e.message; console.log("MobiData BW failed", station.id, e.message); }
  } else if (station.country === "AT") {
    try { status = await atStatus(station, env, brand); } catch (e) { failed = e.message; console.log("E-Control failed", station.id, e.message); }
  } else {
    try {
      const features = (await ndwFeaturesNear(station.lat, station.lon)).filter((f) => featureIsBrand(f, brand));
      if (features.length) {
        features.sort((a, b) =>
          haversineKm(a.geometry.coordinates, [station.lon, station.lat]) -
          haversineKm(b.geometry.coordinates, [station.lon, station.lat]));
        const counts = extractCounts(features[0], station.minKw);
        status = counts
          ? { ...counts, ...classify(counts), ...ndwTimes(counts), source: "NDW", checkedAt: new Date().toISOString() }
          : { available: null, total: null, source: "NDW", note: "found, but counts not recognised", checkedAt: new Date().toISOString() };
        // Open Charge Map's pin can be on the wrong side of the road, or two pins can point at one site.
        // So also send the brand's sites nearby (NDW's own positions); the app matches pins to sites,
        // each site once, and moves a pin onto its site.
        const here = [station.lon, station.lat];
        status.liveId = String(features[0].id ?? "");
        [status.liveLon, status.liveLat] = features[0].geometry.coordinates;
        status.nearby = features
          .filter((f) => haversineKm(f.geometry.coordinates, here) <= 1.2)
          .slice(0, 4)
          .map((f) => {
            const c = extractCounts(f, station.minKw);
            const pr = f.properties || {};
            return c ? {
              id: String(f.id ?? ""), lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
              name: pr.name || pr.location_name || null,
              available: c.available, total: c.total, maxKw: c.maxKw, ...classify(c), ...ndwTimes(c),
            } : null;
          })
          .filter(Boolean);
      }
    } catch (e) {
      failed = e.message;
      console.log("NDW failed", station.id, e.message);
    }
  }
  // A failed lookup isn't "no live data": the app keeps the value it has (it greys with age) and
  // the next round tries again (the failure is remembered for 15 s only).
  if (failed && !status) {
    const f = { failed: true, note: `lookup failed: ${String(failed).slice(0, 80)}` };
    memoSet(key, f, 15 * 1000);
    return f;
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
  // Workers Paid: far more outgoing calls per request are allowed, so more sites per round.
  const paid = isPaid(env);
  const nl = stations.filter((s) => s.country === "NL").slice(0, paid ? 60 : MAX_STATUS_LOOKUPS);
  const at = stations.filter((s) => s.country === "AT").slice(0, paid ? 12 : MAX_AT_LOOKUPS);
  const de = stations.filter((s) => s.country === "DE").slice(0, paid ? 40 : MAX_DE_LOOKUPS);
  const list = [...nl, ...de, ...at];
  Object.assign(out, await ptStatusFor(stations.filter((s) => s.country === "PT")));
  // France from the 5-minute snapshot (Worker 0.4.0): automatic like the others, no extra calls per charger.
  const fr = stations.filter((s) => s.country === "FR");
  if (fr.length && setting(env, "frLive")) Object.assign(out, (await frStatusFor(fr)).status);
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

  // A via point that is a town (viaSnap true) is passed on the numbered road nearest to it:
  // plan a rough route through its centre, then take the point where that route runs on an
  // A or N road closest to the centre. Its coordinates go back to the app, which keeps them.
  const snapFlags = Array.isArray(body.viaSnap) ? body.viaSnap : [];
  for (let i = 0; i < vias.length; i++) {
    if (snapFlags[i] !== true) continue;
    try {
      const rough = await roughRoute(env, [from, vias[i], to]);
      const p = snapToMainRoad(rough, vias[i]);
      if (p && haversineKm(p, vias[i]) < 15) vias[i] = [+p[0].toFixed(5), +p[1].toFixed(5)];
    } catch (_) { /* keep the centre */ }
  }
  // Closures the driver chose to avoid: up to 10 small rings (4 to 12 points), closed here if needed.
  let avoid = null;
  if (body.avoid != null) {
    const ok = Array.isArray(body.avoid) && body.avoid.length <= 10 && body.avoid.every((r) =>
      Array.isArray(r) && r.length >= 3 && r.length <= 12 && r.every(valid));
    if (!ok) throw new HttpError(400, "avoid: up to 10 rings of 3 to 12 [lon, lat] points");
    avoid = body.avoid.map((r) => {
      const ring = r.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]);
      const [a, b] = [ring[0], ring.at(-1)];
      return a[0] === b[0] && a[1] === b[1] ? ring : [...ring, a];
    });
    if (!avoid.length) avoid = null;
  }
  // The routing service only takes avoid areas for routes up to 150 km. Longer: plan a short route
  // around each closure (from a bit before it to a bit after it, with the avoid area), take a point
  // halfway along that detour, and plan the whole route through it without avoid areas. That point
  // is a hidden via: no "arrive" there, and not one of your own via points.
  let route, detourPts = [];
  const points = [from, ...vias, to];
  const crowKm = points.slice(1).reduce((sum, p, i) => sum + haversineKm(points[i], p), 0);
  const spans = Array.isArray(body.avoidSpans) ? body.avoidSpans : [];
  if (avoid && crowKm > 90 && spans.length === avoid.length && spans.every((sp) => Array.isArray(sp) && sp.length === 2 && sp.every(valid))) {
    for (let i = 0; i < avoid.length; i++) {
      const [a, b] = spans[i];
      // With all avoid areas, so the way around one closure doesn't run through another.
      const around = await getRouteCached(env, [a, b], avoid);
      const c = avoid[i].reduce((acc, p) => [acc[0] + p[0] / avoid[i].length, acc[1] + p[1] / avoid[i].length], [0, 0]);
      // Halfway along the detour, or failing that its point furthest from the closure.
      const half = around.km.at(-1) / 2;
      let k = around.km.findIndex((x) => x >= half);
      let best = k >= 0 ? k : 0;
      if (haversineKm(around.coords[best], c) < 1) {
        let far = -1;
        around.coords.forEach((p, j) => { const d = haversineKm(p, c); if (d > far) { far = d; best = j; } });
      }
      detourPts.push(around.coords[best].map((v) => +v.toFixed(6)));
    }
    // Each detour point goes where it adds the least distance between the route's points.
    const wp = [...points], hidden = new Set();
    for (const d of detourPts) {
      let at = 1, add = Infinity;
      for (let j = 1; j < wp.length; j++) {
        const extra = haversineKm(wp[j - 1], d) + haversineKm(d, wp[j]) - haversineKm(wp[j - 1], wp[j]);
        if (extra < add) { add = extra; at = j; }
      }
      wp.splice(at, 0, d);
      hidden.add(d);
    }
    // The detour point lies exactly on the detour road: snap within 30 m only, so it can't jump to the
    // other side of a dual carriageway.
    const full = await getRouteCached(env, wp, null, wp.map((p) => (hidden.has(p) ? 30 : SNAP_RADIUS_M)));
    // Hidden vias: drop their "arrive" steps and their km from the via list.
    const hiddenEnds = new Set(wp.map((p, j) => (hidden.has(p) ? full.ends[j - 1] : null)).filter((x) => x != null));
    const steps = full.steps.filter((st) => !(st.type === 10 && hiddenEnds.has(st.way_points?.[0])));
    const viaKms = full.ends.filter((i) => !hiddenEnds.has(i)).map((i) => full.km[i]);
    route = { ...full, steps, viaKms, viaKm: viaKms[0] ?? null, ends: full.ends.filter((i) => !hiddenEnds.has(i)) };
    const raw = rawRoute.get(full);
    if (raw) rawRoute.set(route, raw);
  } else {
    route = await getRouteCached(env, points, avoid);
  }
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
  const first = stations.slice(0, isPaid(env) ? 20 : 8);
  // France not here: its index is a large file to load on a fresh Worker copy, and /plan must stay
  // within the CPU limit; the app asks /status for French chargers straight after planning.
  const status = await statusForMany(first.filter((s) => s.country !== "FR"), env);
  for (const k of Object.keys(status)) if (status[k]?.failed) status[k] = null; // not checked: the app asks again
  const checked = new Set(first.filter((s) => s.country !== "FR" && (status[s.id] != null || !LIVE_COUNTRIES.has(s.country))).map((s) => s.id));
  stations = stations.map((s) => {
    const out = { ...s, status: status[s.id] ?? null, statusChecked: checked.has(s.id) };
    if (det.has(s.id)) { const d = det.get(s.id); out.detourMin = d.min; out.toMin = d.toMin; out.toKm = d.toKm; }
    return out;
  });

  // Send a lighter route to the app (about 25 m precision), with km and minutes per point.
  const keep = simplifyIndices(route.coords, 0.025);
  const result = {
    route: {
      distanceKm: Math.round(route.distanceKm * 10) / 10,
      durationMin: Math.round(route.durationMin),
      viaKm: route.viaKm != null ? Math.round(route.viaKm * 10) / 10 : null,
      viaKms: (route.viaKms || []).map((k) => Math.round(k * 10) / 10),
      roads: roadsAlong(route),
      // A sample of the raw street names, to check the road numbers come through in each country
      borders: (route.countrySegs || []).map(([a, b, id]) => ({ fromKm: Math.round(route.km[a]), toKm: Math.round(route.km[b]), id, iso: route.idIso[id] || null })),
      debugNames: [...new Set(route.steps.filter((s) => s.distance > 2000).map((s) => s.name))].slice(0, 25),
      // Every step with a name: km where it starts and the routing service's name, to check road numbers.
      // Turn-by-turn for your row: [km where it happens, type, road name, roundabout exit] per step
      // (type: 0 left, 1 right, 2/3 sharp, 4/5 slight, 6 straight, 7 roundabout, 9 U-turn, 10 arrive,
      // 11 depart, 12 keep left, 13 keep right). Already in the routing answer, so no extra calls.
      // Each: [km, type, road name, roundabout exit, net turn angle (degrees, + = right), flags, name of
      // the road before]. Flag "r": the shape is a roundabout even if the step doesn't say so (a
      // "keep left" into an untagged roundabout where you go straight on).
      turns: turnsOf(route),
      // The road name at every step, also where you just go on: the street you're on (location line).
      stepNames: route.steps.filter((st) => st.way_points && st.name && st.name !== "-")
        .map((st) => [Math.round(route.km[st.way_points[0]] * 100) / 100, st.name]),
      debugSteps: route.steps.filter((st) => st.name && st.name !== "-" && st.way_points).map((st) => [Math.round(route.km[st.way_points[0]] * 10) / 10, st.name]).slice(0, 120),
      coords: keep.map((i) => [+route.coords[i][0].toFixed(5), +route.coords[i][1].toFixed(5)]),
      km: keep.map((i) => Math.round(route.km[i] * 100) / 100),
      min: keep.map((i) => Math.round(route.min[i] * 10) / 10),
    },
    stations,
    brands,
    paid: isPaid(env), // Workers Paid: the app updates France by itself and more chargers ahead
    vias, // as used: a town via point moved onto its nearest main road
    // Map tiles along the Dutch part of the route, for the second source of chargers (NDW).
    ndwTiles: ndwTilesAlong(route, env),
    // Points along the rest of the route (every km, outside NL), for the country indexes (POST /extra-sites).
    extraPts: extraPtsAlong(route, env),
    generatedAt: new Date().toISOString(),
  };
  // Debug mode in the app: keep the whole routing result (request, the routing service's raw answer
  // and what the app got) for 30 days under a short id, shown in the app's debug line.
  // One KV write per plan, only for devices in debug mode.
  if (body.debug === true && WHO_OF.get(request)?.debug && env.USAGE) { // stored routes only for debug keys
    const id = debugRouteId();
    const raw = rawRoute.get(route) || null;
    try {
      await env.USAGE.put(`debugroute:${id}`, JSON.stringify({
        id, at: result.generatedAt, worker: WORKER_VERSION,
        request: body, ors: raw ? { points: raw.points, answer: raw.data } : { cached: "raw answer no longer kept (route came from the Worker's cache)" },
        app: result,
      }), { expirationTtl: DEBUG_ROUTE_TTL_S });
      countCall("KV writes");
      result.debugId = id;
    } catch (e) { result.debugError = `Couldn't store the routing result: ${e.message}`; }
  }
  return json(request, result);
}

// ---------------------------------------------------------------- second source: NDW (NL)
// Open Charge Map misses sites (Fastned shares no data with it, so new Fastned sites appear late).
// NDW knows every public charger in the Netherlands, but only answers per map box, slow chargers
// included. So: fixed tiles of 0.05° x 0.08° (about 5.5 x 5.5 km) along the route, looked up once
// a day per tile for everyone, trimmed to fast chargers of our brands before caching. The app asks
// for a few tiles per call after planning; a tile that is too big to handle comes back as "split"
// and the app asks for its four quarters instead.
const NDW_TILE_LAT = 0.05, NDW_TILE_LON = 0.08;
const NDW_TILE_MAX_BYTES = 450 * 1024; // above this, parsing risks the free plan's CPU limit
const NL_BOX = [3.3, 50.7, 7.3, 53.6]; // lon/lat, for parts of the route whose country is unknown
const tileKey = (lat, lon) => `${Math.floor(lat / NDW_TILE_LAT)}_${Math.floor(lon / NDW_TILE_LON)}`;
function ndwTilesAlong(route, env) {
  if (!setting(env, "ndwDiscovery")) return [];
  const tiles = new Set();
  const nearKm = 1.5; // service areas and chargers at exits; further out is a detour anyway
  let lastKm = -Infinity;
  for (let i = 0; i < route.coords.length; i++) {
    if (route.km[i] - lastKm < 1 && i !== route.coords.length - 1) continue;
    lastKm = route.km[i];
    const [lon, lat] = route.coords[i];
    const iso = isoAt(route, i);
    const inNl = iso ? iso === "NL" : lon >= NL_BOX[0] && lon <= NL_BOX[2] && lat >= NL_BOX[1] && lat <= NL_BOX[3];
    if (!inNl) continue;
    const dLat = nearKm / 111, dLon = nearKm / (111 * Math.cos(toRad(lat)));
    for (const a of [-dLat, 0, dLat]) for (const b of [-dLon, 0, dLon]) tiles.add(tileKey(lat + a, lon + b));
  }
  return [...tiles];
}
// "12345_678" is a whole tile; "12345_678/2" a quarter (0..3), "12345_678/2/1" a quarter of that.
function tileBox(key) {
  const [base, ...parts] = key.split("/");
  const [ti, tj] = base.split("_").map(Number);
  let lat0 = ti * NDW_TILE_LAT, lon0 = tj * NDW_TILE_LON, dLat = NDW_TILE_LAT, dLon = NDW_TILE_LON;
  for (const q of parts.map(Number)) {
    dLat /= 2; dLon /= 2;
    if (q & 1) lon0 += dLon;
    if (q & 2) lat0 += dLat;
  }
  return [lon0, lat0, lon0 + dLon, lat0 + dLat];
}
const validTile = (k) => typeof k === "string" && /^-?\d+_-?\d+(\/[0-3]){0,3}$/.test(k);

async function ndwTile(env, key) {
  const memoKey = `ndwt2:${key}`; // ndwt2 since Worker 0.9.0: tiles cached before held no Essent/Vattenfall/Eneco
  const hit = memoGet(memoKey);
  if (hit !== undefined) return hit;
  if (env.USAGE) {
    try {
      const kv = JSON.parse((await kvGet(env, memoKey)) || "null");
      if (kv) { memoSet(memoKey, kv, 60 * 60 * 1000); return kv; }
    } catch (_) {}
  }
  const bbox = tileBox(key).map((v) => v.toFixed(5)).join(",");
  countCall("NDW sites"); // apart from "NDW" (live status) since Worker 0.13.0
  const res = await fetch(`${NDW_BBOX}?bbox=${bbox}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new HttpError(502, `NDW returned ${res.status}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > NDW_TILE_MAX_BYTES && key.split("/").length < 4) { try { res.body?.cancel(); } catch (_) {} return { split: true }; }
  const text = await res.text();
  if (text.length > NDW_TILE_MAX_BYTES && key.split("/").length < 4) return { split: true };
  let features = [];
  try { features = JSON.parse(text).features || []; } catch (_) { throw new HttpError(502, "NDW did not return JSON"); }
  // Keep only fast chargers of the brands the app knows, with the few fields it uses.
  const sites = [];
  for (const f of features) {
    const brand = BRANDS.find((b) => featureIsBrand(f, b));
    if (!brand) continue;
    const c = extractCounts(f);
    if (!c || (brand.key !== "ionity" && !(c.maxKw >= FAST_KW))) continue;
    const pr = f.properties || {};
    const [lon, lat] = f.geometry?.coordinates || [];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    sites.push({ id: String(f.id ?? `${lat},${lon}`), brand: brand.key, name: pr.name || pr.location_name || null,
      address: [pr.address, pr.city].filter(Boolean).join(", ") || null, lat, lon, maxKw: c.maxKw, points: c.total });
  }
  const out = { sites };
  memoSet(memoKey, out, 60 * 60 * 1000);
  if (env.USAGE) {
    try { await env.USAGE.put(memoKey, JSON.stringify(out), { expirationTtl: 24 * 3600 }); countCall("KV writes"); } catch (_) {}
  }
  return out;
}

async function handleNdwSites(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!setting(env, "ndwDiscovery")) return json(request, { sites: [], split: [], done: [] });
  const tiles = (Array.isArray(body.tiles) ? body.tiles : []).filter(validTile).slice(0, 3);
  const brands = new Set((Array.isArray(body.brands) ? body.brands : []).filter((k) => BRAND[k]));
  const sites = [], split = [], done = [];
  for (const t of tiles) {
    try {
      const r = await ndwTile(env, t);
      if (r.split) { split.push(...[0, 1, 2, 3].map((q) => `${t}/${q}`)); continue; }
      for (const x of r.sites) if (!brands.size || brands.has(x.brand)) sites.push(x);
      done.push(t);
    } catch (e) {
      console.log("NDW tile failed", t, e.message);
    }
  }
  return json(request, { sites, split, done });
}

// ---------------------------------------------------------------- second source: the country indexes
// (Worker 0.13.0) Outside the Netherlands Open Charge Map was the only list of where chargers are, so a
// site it lacks (Fastned Brecht Oost on the E19, missing on 22 Nov) never showed. The Worker already
// keeps a list of fast sites per country for live status: Belgium (Eco-Movement), France (IRVE),
// Portugal (MOBI.E) and, since 0.13.0, Germany with part of Austria (MobiData BW's OCPDB, built weekly
// by de-index.yml). /plan sends points along the route outside NL (every km); the app sends them in
// pieces to /extra-sites, which answers the sites of the asked brands within 1.5 km. No outside calls
// and no KV writes: the indexes are static files read at most once a day per Worker copy. The app adds
// what it doesn't have yet (same rule as NDW's sites); live status then works through the usual paths.
const EXTRA_STEP_KM = 1, EXTRA_NEAR_KM = 1.5, EXTRA_MAX_PTS = 150; // 150 points: ~3 ms CPU warm (measured in Node)
const EXTRA_BOXES = { // [minLon, minLat, maxLon, maxLat]: only the indexes a point can be near are loaded
  BE: [2.4, 49.4, 6.5, 51.6], FR: [-5.3, 41.2, 9.7, 51.2], PT: [-9.7, 36.8, -6.0, 42.3], DE: [5.7, 46.3, 17.3, 55.2],
};
const inExtraBox = (cc, [lon, lat]) => { const b = EXTRA_BOXES[cc]; return lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]; };
function extraPtsAlong(route, env) {
  if (!setting(env, "indexDiscovery")) return [];
  const pts = [];
  let lastKm = -Infinity;
  for (let i = 0; i < route.coords.length; i++) {
    if (route.km[i] - lastKm < EXTRA_STEP_KM && i !== route.coords.length - 1) continue;
    lastKm = route.km[i];
    if (isoAt(route, i) === "NL") continue; // NDW's tiles cover the Netherlands
    const p = route.coords[i];
    if (!Object.keys(EXTRA_BOXES).some((cc) => inExtraBox(cc, p))) continue;
    pts.push([+p[0].toFixed(4), +p[1].toFixed(4)]);
  }
  return pts;
}

// Germany (and the Austrian sites OCPDB holds): data/de-fast-sites.json, fields [brand, cc, lat, lon, maxKw, name, n].
const DE_INDEX_URL = "https://remconld.github.io/apps/data/de-fast-sites.json"; // tools/build-de-index.py, weekly
const DE_CELL = 0.02;
let deIndexState = null;
async function deIndex() {
  if (deIndexState && Date.now() - deIndexState.at < 24 * 3600 * 1000) return deIndexState.promise;
  const promise = (async () => {
    countCall("DE index");
    const res = await fetch(DE_INDEX_URL, { cf: { cacheTtl: 3600 } });
    if (!res.ok) throw new HttpError(502, `Germany index: HTTP ${res.status}`);
    const data = await res.json();
    const grid = new Map();
    for (const [brand, cc, lat, lon, maxKw, name, n] of data.sites || []) {
      if (!BRAND[brand]) continue;
      const k = `${brand}|${Math.floor(lat / DE_CELL)}|${Math.floor(lon / DE_CELL)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push({ brand, cc, lat, lon, maxKw, name, n });
    }
    return { built: data.built, grid, count: (data.sites || []).length };
  })();
  deIndexState = { at: Date.now(), promise };
  promise.catch(() => { if (deIndexState?.promise === promise) deIndexState = null; });
  return promise;
}
// Sites of a grid within km of any of the points. Each cell is looked at once (points a km apart share
// cells), and a site only against the points in its own and the 8 surrounding cells (a cell is at
// least 1.4 km wide here, so 1.5 km reaches no further). cb(site) per site found, once.
function gridScan(grid, cell, gridKeys, pts, km, cb) {
  const cellPts = new Map();
  for (const p of pts) {
    const k = `${Math.floor(p[1] / cell)}|${Math.floor(p[0] / cell)}`;
    if (!cellPts.has(k)) cellPts.set(k, []);
    cellPts.get(k).push(p);
  }
  const cells = new Set();
  for (const k of cellPts.keys()) {
    const [cy, cx] = k.split("|").map(Number);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) cells.add(`${cy + dy}|${cx + dx}`);
  }
  for (const c of cells) {
    const [cy, cx] = c.split("|").map(Number);
    let near = null; // the points that can reach this cell, gathered once per cell
    for (const g of gridKeys) {
      const list = grid.get(`${g}|${c}`);
      if (!list) continue;
      if (!near) {
        near = [];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) near.push(...(cellPts.get(`${cy + dy}|${cx + dx}`) || []));
      }
      for (const s of list) if (near.some((p) => haversineKm([s.lon, s.lat], p) <= km)) cb(s, g);
    }
  }
}
const extraId = (cc, brand, lat, lon) => `x-${cc.toLowerCase()}-${brand}-${lat.toFixed(4)}_${lon.toFixed(4)}`;

async function handleExtraSites(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!setting(env, "indexDiscovery")) return json(request, { sites: [], failed: [] });
  const valid = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  const pts = (Array.isArray(body.pts) ? body.pts : []).filter(valid).slice(0, EXTRA_MAX_PTS);
  const brands = [...new Set((Array.isArray(body.brands) ? body.brands : []).filter((k) => BRAND[k]))];
  if (!pts.length || !brands.length) return json(request, { sites: [], failed: [] });
  const want = new Set(brands);
  const loaders = { BE: beIndex, FR: frIndex, PT: ptIndex, DE: deIndex };
  const idx = {}, failed = [];
  for (const cc of Object.keys(loaders)) {
    if (!pts.some((p) => inExtraBox(cc, p))) continue;
    try { idx[cc] = await loaders[cc](); } catch (e) { failed.push(cc); console.log("Extra sites:", cc, e.message); }
  }
  const out = new Map();
  const add = (cc, brand, s, name, points) => {
    const id = extraId(cc, brand, s.lat, s.lon);
    if (!out.has(id)) out.set(id, { id, brand, country: cc, lat: s.lat, lon: s.lon, name: name || null, maxKw: s.maxKw || null, points: points || null });
  };
  const ptsIn = (cc) => pts.filter((p) => inExtraBox(cc, p));
  // Belgium: every operator ("*" cells), so a site the index builder called "other" still counts when its stall ids are a brand's.
  if (idx.BE) gridScan(idx.BE.grid, BE_CELL, ["*"], ptsIn("BE"), EXTRA_NEAR_KM, (s) => {
    const brand = s.brand !== "other" && BRAND[s.brand] ? s.brand : brandOfSite(null, null, s.name, s.evseIds);
    if (brand && want.has(brand)) add("BE", brand, s, s.name, s.evseIds?.length);
  });
  if (idx.FR) gridScan(idx.FR.grid, FR_CELL, brands, ptsIn("FR"), EXTRA_NEAR_KM, (s, b) => add("FR", b, s, s.name, s.ids?.length));
  if (idx.PT) gridScan(idx.PT.grid, PT_CELL, brands, ptsIn("PT"), EXTRA_NEAR_KM, (s, b) => add("PT", b, s, s.name, s.n));
  if (idx.DE) gridScan(idx.DE.grid, DE_CELL, brands, ptsIn("DE"), EXTRA_NEAR_KM, (s, b) => add(s.cc || "DE", b, s, s.name, s.n));
  return json(request, { sites: [...out.values()], failed });
}

// The routing service only gives alternatives below 100 km, so we make our own: plan through
// points left and right of the fastest route, keep the ones that use different main roads.
// Points left and right of the fastest route are tried at several places along it. Their distance
// to the route, and how long a road must be to count as a "main road" of an option, grow with the
// trip: on a 100 km trip a 40 km side step is never within 25% (it found nothing for Utrecht-Bergen
// op Zoom, while N3/A59/A17/A58 variants exist).
const ALT_DEFAULTS = { fractions: [0.25, 0.5, 0.75], wideAt: [0.5], offsetShare: 0.12, offsetMinKm: 6, offsetMaxKm: 40,
  maxSlower: 1.25, mainRoadShare: 0.1, mainRoadMinKm: 8, mainRoadMaxKm: 30, maxOptions: 3 };

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

// Street and town at a point, for the app's location line. The street comes from OpenStreetMap
// (Overpass, free): of the roads within 40 m, the one that runs the way you're driving, with bigger
// roads preferred over side streets and service roads. The nearest address (the geocoder) often
// names a quiet street next to the ring road you're actually on. Its number (A27, N3) comes along,
// so the app can also check the route's road number after a junction. The town comes from the
// geocoder, kept a day per ~1 km. Fallback: the geocoder's nearest street.
const ROAD_CLASS_PENALTY_M = {
  motorway: 0, trunk: 0, primary: 0, secondary: 3, tertiary: 6, motorway_link: 8, trunk_link: 8,
  primary_link: 8, secondary_link: 10, tertiary_link: 10, unclassified: 12, residential: 18,
  living_street: 25, service: 35,
};
// All mirrors at once, the first good answer wins (one is often slow or refusing).
async function overpassJson(q, ms = 4000) {
  const ctls = OVERPASS_MIRRORS.map(() => new AbortController());
  const timer = setTimeout(() => ctls.forEach((c) => c.abort()), ms);
  try {
    return await Promise.any(OVERPASS_MIRRORS.map(async (url, i) => {
      countCall("Overpass");
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "evailability personal app (github.com/RemcoNLD)", Accept: "application/json" },
        body: "data=" + encodeURIComponent(q), signal: ctls[i].signal,
      });
      if (!res.ok) { countCall("Overpass errors"); throw new Error(`${new URL(url).host} ${res.status}`); }
      const data = await res.json();
      ctls.forEach((c, j) => { if (j !== i) c.abort(); });
      return data;
    }));
  } catch (_) {
    throw new Error("Overpass unavailable");
  } finally { clearTimeout(timer); }
}
function bearingDeg([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180, y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
// The road you're most likely on: distance to it, plus a penalty for small roads and for running
// across your heading (either direction along a road is fine).
async function roadHere(lat, lon, heading) {
  const q = `[out:json][timeout:6];way(around:40,${lat.toFixed(6)},${lon.toFixed(6)})[highway~"^(${Object.keys(ROAD_CLASS_PENALTY_M).join("|")})$"];out tags geom;`;
  const data = await overpassJson(q);
  const kx = 111.32 * Math.cos(lat * Math.PI / 180), ky = 110.57; // km per degree
  let best = null;
  for (const w of data.elements || []) {
    const g = w.geometry || [];
    let dMin = Infinity, segBearing = null;
    for (let i = 0; i < g.length - 1; i++) {
      const ax = (g[i].lon - lon) * kx, ay = (g[i].lat - lat) * ky, bx = (g[i + 1].lon - lon) * kx, by = (g[i + 1].lat - lat) * ky;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-12;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
      const d = Math.hypot(ax + t * dx, ay + t * dy) * 1000;
      if (d < dMin) { dMin = d; segBearing = bearingDeg([g[i].lon, g[i].lat], [g[i + 1].lon, g[i + 1].lat]); }
    }
    if (!Number.isFinite(dMin)) continue;
    let score = dMin + (ROAD_CLASS_PENALTY_M[w.tags?.highway] ?? 20);
    if (heading != null && segBearing != null) {
      const diff = Math.abs(((heading - segBearing + 540) % 360) - 180);
      const across = Math.min(diff, 180 - diff); // 0 = along the road, 90 = crossing it
      score += across > 35 ? 40 : across > 20 ? 12 : 0;
    }
    if (!w.tags?.name && !w.tags?.ref) score += 15; // nameless: a ramp or a driveway
    if (!best || score < best.score) best = { score, tags: w.tags || {} };
  }
  if (!best) return null;
  const t = best.tags;
  const ref = String(t.ref || "").split(";")[0].replace(/\s/g, "");
  const numbered = /^(motorway|trunk|primary|secondary|motorway_link|trunk_link)$/.test(t.highway) && /^[ABDEMNRS]\d{1,4}[a-z]?$/i.test(ref) ? ref.toUpperCase() : null;
  return { street: t.name || null, ref: numbered, highway: t.highway || null };
}
async function whereAt(env, [lon, lat], heading = null) {
  const key = `where:${lon.toFixed(4)},${lat.toFixed(4)}:${heading == null ? "-" : Math.round(heading / 30)}`;
  const cached = memoGet(key);
  if (cached !== undefined) return cached;
  let road = null;
  try { road = await roadHere(lat, lon, heading); } catch (_) { /* geocoder below */ }
  const cityKey = `where-city:${lon.toFixed(2)},${lat.toFixed(2)}`;
  let city = memoGet(cityKey), street = road?.street ?? null, country = null;
  if (city === undefined || (!road && street == null)) {
    const url = `${PELIAS_BASE}/reverse?point.lat=${lat}&point.lon=${lon}&size=1&layers=address,street`;
    try {
      const data = await fetchJson(url, { headers: orsHeaders(env) }, "Geocoder");
      const p = data.features?.[0]?.properties || {};
      city = p.locality || p.localadmin || p.county || null;
      country = p.country_code || null;
      if (!road) street = p.street || (p.layer === "street" ? p.name : null) || null;
      memoSet(cityKey, city, 24 * 3600 * 1000);
    } catch (_) { if (city === undefined) city = null; }
  }
  const out = { street, city, country, ref: road?.ref || null, highway: road?.highway || null, source: road ? "osm" : "geocoder" };
  memoSet(key, out, 24 * 3600 * 1000);
  return out;
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

// A place name for a charger whose own name is only its brand ("Shell Recharge"): the service
// area if a nearby place is named like one, otherwise the town. Looked up once per spot (about
// 100 m) and kept 30 days for everyone.
const AREA_RE = /\b(verzorgingsplaats|parkeerplaats|rasthof|raststätte|rastanlage|autohof|aire de|aire d'|service area|servicestation)\b/i;
// Service areas are mapped in OpenStreetMap (highway=services / rest_area) with their own name
// ("'t Hol", "Keizershof"), which the geocoder doesn't flag as such. So ask OpenStreetMap
// (Overpass) for the nearest one within 500 m first; the geocoder gives the town.
// Public Overpass servers limit requests per address, and Cloudflare's outgoing addresses are
// shared by many Workers, so one server may refuse ("429"). Try a few mirrors in turn.
const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
// One Overpass request for all chargers of a batch (not one per charger): service areas near
// each, with their outlines. A mirror that refuses or hangs is skipped after a few seconds.
async function fetchWithTimeout(url, init, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctl.signal }); } finally { clearTimeout(t); }
}
let overpassGood = 0;
const CHARGE_BRAND_START = /^(fastned|ionity|tesla|enbw|aral|shell( recharge)?|total(energies)?|electra|izivia|powerdot|allego|bp pulse|essent|vattenfall( incharge)?|eneco)\b/i;
// Names of hosts rather than places, never used as a place even at a fuel station.
const HOST_WORDS = /\b(mc ?donald'?s|burger king|kfc|van der valk|hotel|motel|restaurant|ikea|lidl|aldi|albert heijn|jumbo|parking|parkeergarage|p\+r)\b/i;
// "Shell 't Hol" -> "'t Hol"; "Fastned Keizershof" -> "Keizershof"; "Shell" or "Tango" -> nothing.
const FUEL_BRANDS = /\b(shell( recharge)?|bp( pulse)?|esso|total(energies)?|tango|texaco|tinq|avia|q8|gulf|argos|tamoil|firezone|makro|lukoil|aral( pulse)?|omv|jet|agip|eni|fastned|ionity|tesla( supercharger)?|allego|enbw|electra|powerdot|izivia|ev[- ]?box|vattenfall( incharge)?|incharge|eneco|essent|e\.?on drive|greenflux|laadpunt|charging station|snellaadstation|laadstation|tankstation|express|station)\b/gi;
function placeFromStationName(name, tags = {}) {
  let n = String(name).replace(FUEL_BRANDS, " ");
  for (const k of ["brand", "operator", "network"]) if (tags[k]) n = n.replace(new RegExp(tags[k].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ");
  n = n.replace(AREA_RE, " ").replace(/\b[AN]\d{1,3}\b/g, " ").replace(/[()]/g, " ").replace(/^[\s:–\-,]+|[\s:–\-,]+$/g, "").replace(/\s+/g, " ").trim();
  if (n.length < 3 || !/[a-z]{2}/i.test(n) || /\d{2,}/.test(n) || HOST_WORDS.test(n)) return null;
  return n;
}
async function serviceAreasNear(points) {
  // Service areas (often not mapped or not named in the Netherlands), plus the fuel and charging
  // stations right next to the charger, which usually carry the place in their name
  // ("Shell 't Hol", "Fastned Keizershof", "Tango Hoezaar").
  const parts = points.map((x) => {
    const at = `${x.lat.toFixed(5)},${x.lon.toFixed(5)}`;
    return `nwr[highway~"^(services|rest_area)$"][name](around:800,${at});nwr[amenity~"^(fuel|charging_station)$"][name](around:200,${at});`;
  }).join("");
  const q = `[out:json][timeout:12];(${parts});out geom 80;`;
  let data = null, lastErr = null;
  // Start with the mirror that answered last time (this copy of the Worker remembers it).
  const order = [...OVERPASS_MIRRORS.slice(overpassGood), ...OVERPASS_MIRRORS.slice(0, overpassGood)];
  for (const url of order) {
    countCall("Overpass");
    try {
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "evailability personal app (github.com/RemcoNLD)", Accept: "application/json" },
        body: "data=" + encodeURIComponent(q),
      }, 7000);
      if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
      data = await res.json();
      overpassGood = OVERPASS_MIRRORS.indexOf(url);
      break;
    } catch (e) {
      lastErr = e;
      countCall("Overpass errors"); // shows on the usage page: if this grows, the mirrors refuse us
      console.log("Overpass failed", url, e.message);
    }
  }
  if (!data) throw lastErr || new Error("Overpass unavailable");
  // Per charger: the service area whose outline is nearest (0 when inside it), within 800 m;
  // without one, the nearest fuel or charging station within 250 m whose name says more than
  // its brand ("Shell 't Hol" -> "'t Hol").
  const out = {};
  for (const x of points) {
    let area = null, areaD = 0.8, station = null, stationD = 0.2; // 200 m: the station on your side, not across the road
    for (const el of data.elements || []) {
      const name = el.tags?.name;
      if (!name) continue;
      const d = distanceToElement(el, x.lat, x.lon);
      if (el.tags.highway) { if (d <= areaD) { areaD = d; area = name; } continue; }
      // Fuel stations at a service area carry its name ("Shell 't Hol", "BP Hoezaar"). Charging
      // stations only when the name starts with a charging brand ("Fastned Keizershof"): others are
      // named after their host ("Mc Donalds Nieuwegein", "Van der Valk Hotel"), which isn't a place.
      const isFuel = el.tags.amenity === "fuel";
      if (!isFuel && !CHARGE_BRAND_START.test(String(name).replace(/^\s*[AN]\d{1,3}\s+/i, ""))) continue;
      const place = placeFromStationName(name, el.tags);
      if (place && d <= stationD) { stationD = d; station = place; }
    }
    const a = area ? area.replace(AREA_RE, "").replace(/^[\s:–-]+/, "").trim() || area : null;
    out[x.id] = a ? { name: a, src: "service area" } : station ? { name: station, src: "station name" } : null;
  }
  return out;
}

// Distance in km from a point to an Overpass element: 0 inside a closed outline, otherwise to the
// nearest edge (ways, relation members) or to the node itself.
function distanceToElement(el, lat, lon) {
  if (el.lat != null && el.lon != null) return haversineKm([el.lon, el.lat], [lon, lat]);
  const rings = [];
  if (Array.isArray(el.geometry)) rings.push(el.geometry);
  for (const m of el.members || []) if (Array.isArray(m.geometry)) rings.push(m.geometry);
  let best = Infinity, inside = false;
  const p = toXY([lon, lat], lat);
  for (const g of rings) {
    const pts = g.filter((q) => q && Number.isFinite(q.lat)).map((q) => toXY([q.lon, q.lat], lat));
    for (let i = 0; i + 1 < pts.length; i++) best = Math.min(best, pointSegment(p, pts[i], pts[i + 1]).dist);
    const closed = g.length > 3 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;
    if (closed) {
      let c = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
      }
      if (c) inside = true;
    }
  }
  if (inside) return 0;
  if (Number.isFinite(best)) return best;
  return el.center ? haversineKm([el.center.lon, el.center.lat], [lon, lat]) : Infinity;
}

// A place name for chargers named only by their brand: the service area (OpenStreetMap), else
// the town (geocoder). Kept 30 days per spot (about 100 m) for everyone.
const placeKey = (x) => `pl7:${x.lat.toFixed(3)},${x.lon.toFixed(3)}`;
async function handlePlaces(request, env) {
  const body = await request.json().catch(() => ({}));
  const pts = (Array.isArray(body.points) ? body.points : [])
    .filter((x) => x && typeof x.id === "string" && Number.isFinite(x.lat) && Number.isFinite(x.lon)).slice(0, 8);
  const places = {}, misses = [];
  for (const x of pts) {
    let hit = memoGet(placeKey(x));
    if (hit === undefined && env.USAGE) {
      try { hit = JSON.parse((await kvGet(env, placeKey(x))) || "null") || undefined; } catch (_) { hit = undefined; }
      if (hit) memoSet(placeKey(x), hit, 24 * 3600 * 1000);
    }
    if (hit) places[x.id] = hit; else misses.push(x);
  }
  if (misses.length) {
    let areas = {}, ok = true;
    try { areas = await serviceAreasNear(misses); } catch (_) { ok = false; }
    const towns = await Promise.all(misses.map((x) => placeName(env, [x.lon, x.lat]).catch(() => null)));
    for (let i = 0; i < misses.length; i++) {
      const x = misses[i];
      const res = { area: areas[x.id]?.name || null, src: areas[x.id]?.src || null, town: towns[i] || null, v: 7, ok };
      places[x.id] = res;
      memoSet(placeKey(x), res, (ok ? 24 : 0.25) * 3600 * 1000);
      // Not kept when the service-area lookup failed: tried again later.
      if (env.USAGE && ok && (res.area || res.town)) {
        try { await env.USAGE.put(placeKey(x), JSON.stringify(res), { expirationTtl: 30 * 24 * 3600 }); countCall("KV writes"); } catch (_) {}
      }
    }
  }
  return json(request, { places });
}

async function describeOption(env, route, via, pois, maxCities = 4, mainRoadKm = 30) {
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
    signature: mainRoads(route.steps, mainRoadKm),
  };
}

async function handleAlternatives(request, env) {
  const body = await request.json().catch(() => ({}));
  const { from, to } = body;
  const valid = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  if (!valid(from) || !valid(to)) throw new HttpError(400, "Send from and to as [lon, lat]");
  // Your own via points still ahead (while driving): the route through them comes first, marked ownVia.
  const ownVias = Array.isArray(body.via) ? body.via.filter(valid).slice(0, 3) : [];
  const t = { ...ALT_DEFAULTS, ...(body.tune || {}) };

  const fastest = await getRouteCached(env, [from, to]);
  const viaRoute = ownVias.length ? await getRouteCached(env, [from, ...ownVias, to]).catch(() => null) : null;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const offKm = t.offsetKm ?? clamp(fastest.distanceKm * t.offsetShare, t.offsetMinKm, t.offsetMaxKm);
  t.mainRoadKm = t.mainRoadKm ?? clamp(fastest.distanceKm * t.mainRoadShare, t.mainRoadMinKm, t.mainRoadMaxKm);
  const baseSig = mainRoads(fastest.steps, t.mainRoadKm);

  // Try points left and right of the fastest route, close by at several places and further out halfway.
  const tries = [];
  for (const f of t.fractions) for (const side of [1, -1]) tries.push(offsetPoint(fastest, f, side * offKm));
  for (const f of t.wideAt || []) for (const side of [1, -1]) tries.push(offsetPoint(fastest, f, side * offKm * 2));
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
    if (picks.length >= t.maxOptions) break;
  }

  // Plan the kept ones properly through the snapped point.
  const routes = await Promise.all(picks.map((v) => getRouteCached(env, [from, v, to]).then((r) => ({ r, v })).catch(() => null)));

  // Ionity sites per route, looked up in sections along each one (one big area gets cut short).
  const all = [...(viaRoute ? [{ r: viaRoute, v: null, own: true }] : []), { r: fastest, v: null }, ...routes.filter(Boolean)];
  const found = new Map();
  for (const { r } of all) {
    try { for (const p of await ionityAlongRoute(env, r, 5)) found.set(p.ID, p); } catch (_) {}
  }
  const pois = [...found.values()];

  const options = [];
  for (const { r, v, own } of all) {
    if (v && r.durationMin > fastest.durationMin * t.maxSlower) continue;
    const o = await describeOption(env, r, v, pois, 4, t.mainRoadKm);
    if (own) { o.ownVia = true; options.push(o); continue; }
    if (options.some((x) => x.signature === o.signature)) continue; // same roads as your via route
    if (v && options.some((x) => x.signature === o.signature)) continue; // snapping made it the same road after all
    // A side trip that leaves a road and comes back onto it later (A27 > N631 > A58 > A27) isn't a real alternative.
    const refs = o.roads.map((x) => x.ref);
    if (v && refs.some((ref, i) => refs.indexOf(ref) !== i)) continue;
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
  const minKw = minKwOf(body.minKw);
  let stations = (Array.isArray(body.stations) ? body.stations : []).map((st) => ({ ...st, minKw }));
  const who = WHO_OF.get(request);
  if (who?.trial) {
    // Trial: live status in the Netherlands only, and at most every TRIAL_STATUS_GAP_MS per key.
    stations = stations.filter((st) => (st.country || "").toUpperCase() === "NL");
    const k = `trialstatus:${who.id}`, last = memoGet(k) || 0;
    if (Date.now() - last < TRIAL_STATUS_GAP_MS) {
      return json(request, { status: {}, checkedAt: new Date().toISOString(), trial: true, retryAfterMs: TRIAL_STATUS_GAP_MS - (Date.now() - last) });
    }
    memoSet(k, Date.now(), TRIAL_STATUS_GAP_MS);
  }
  return json(request, { status: await statusForMany(stations, env), checkedAt: new Date().toISOString(), paid: isPaid(env) });
}

// ---------------------------------------------------------------- access
// The app asks for an access code once. The check happens here, so the page source shows nothing
// about it: a 9-digit number that passes the "11-proef" (like a Dutch BSN). A right code gets a token
// (HMAC of a fixed text with a server-side secret); the app keeps it and sends it as X-Access.
// Changing ACCESS_SECRET (or, without it, OCM_API_KEY) signs everyone out.
const DEBUG_ROUTE_TTL_S = 30 * 24 * 3600;
// Short and easy to read off a screenshot: 6 letters/digits without look-alikes (0/o, 1/l/i).
function debugRouteId() {
  const abc = "23456789abcdefghjkmnpqrstuvwxyz";
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((x) => abc[x % abc.length]).join("");
}
async function handleDebugRoute(request, env, id, part) {
  if (!/^[a-z0-9]{4,12}$/.test(id)) throw new HttpError(400, "Unknown route id");
  if (!env.USAGE) throw new HttpError(503, "No KV store bound");
  const text = await kvGet(env, `debugroute:${id}`);
  if (!text) throw new HttpError(404, `No routing result ${id} (kept 30 days)`);
  let body = text;
  if (part) {
    const rec = JSON.parse(text);
    if (!(part in rec)) throw new HttpError(400, "part = request, app or ors");
    body = JSON.stringify(rec[part]);
  }
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `inline; filename="evailability-route-${id}${part ? `-${part}` : ""}.json"`,
      ...corsHeaders(request),
    },
  });
}

const PUBLIC_PATHS = new Set(["/", "/unlock", "/service-status", "/self-service", "/request", "/request/status", "/trial/extend", "/contact", "/contact/cancel-delete", "/request/withdraw", "/brands", "/admin/usage", "/admin/settings", "/admin/users", "/admin/timer", "/admin/push", "/admin/alerts", "/closures/schedule", "/occupancy/config", "/occupancy/at"]);
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
// ---------------------------------------------------------------- users (personal access keys)
// Each person gets their own key, e.g. 7K3F-M9QX-2HTB: 11 random characters from an alphabet without
// look-alikes (no 0/O, 1/I/L), plus a check character at the end so typos are caught before asking.
// Only an HMAC of the key is kept (with the same server-side secret as the tokens), so a key can't be
// read back: it's shown once when made. A right key gets a token "u1.<id>.<gen>.<signature>" that the
// app keeps; regenerating raises gen, which ends the old key's tokens. The list lives in KV under
// "users" (one record; written only from the Users page) and each Worker copy reads it at most once a
// minute, so switching a key off takes effect within a minute or two.
const KEY_ABC = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // 31 characters (no 0, 1, I, L, O)
function keyCheckChar(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += (i + 1) * KEY_ABC.indexOf(body[i]);
  return KEY_ABC[sum % KEY_ABC.length];
}
function newKey() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let body = "";
  for (const x of b) { if (x < 248) body += KEY_ABC[x % 31]; if (body.length === 11) break; } // 248 = 8×31: no bias
  const k = body + keyCheckChar(body);
  return `${k.slice(0, 4)}-${k.slice(4, 8)}-${k.slice(8)}`;
}
function validKey(k) { return /^[2-9A-HJKMNP-Z]{12}$/.test(k) && keyCheckChar(k.slice(0, 11)) === k[11]; }
async function hmac(env, text) {
  const secret = env.ACCESS_SECRET || env.OCM_API_KEY || "";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const keyHash = (env, k) => hmac(env, `key:${k}`);
const userSig = (env, id, gen) => hmac(env, `user:${id}:${gen}`);
async function loadUsers(env, fresh = false) {
  let list = fresh ? undefined : memoGet("users");
  if (list === undefined) {
    list = [];
    try { if (env.USAGE) list = JSON.parse((await kvGet(env, "users")) || "[]"); } catch (_) {}
    memoSet("users", list, 60 * 1000);
  }
  return list;
}
async function saveUsers(env, list) {
  if (!env.USAGE) throw new HttpError(503, "No KV store bound");
  await env.USAGE.put("users", JSON.stringify(list));
  countCall("KV writes");
  memoSet("users", list, 60 * 1000);
}
const userId = () => [...crypto.getRandomValues(new Uint8Array(5))].map((x) => "23456789abcdefghjkmnpqrstuvwxyz"[x % 31]).join("");

async function handleUsers(request, env) {
  checkAdmin(request, env);
  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const list = [...(await loadUsers(env, true))];
    const now = new Date().toISOString();
    const find = () => {
      const u = list.find((x) => x.id === body.id);
      if (!u) throw new HttpError(404, "No such user");
      return u;
    };
    let key = null, user = null;
    if (body.action === "create") {
      const label = String(body.label || "").trim().slice(0, 60);
      if (!label) throw new HttpError(400, "Give a name (label)");
      if (list.length >= 200) throw new HttpError(400, "That's 200 users already");
      key = newKey();
      user = { id: userId(), label, hash: await keyHash(env, key.replace(/-/g, "")), gen: 1, active: true, created: now, keyMade: now };
      list.push(user);
    } else if (body.action === "regenerate") {
      user = find();
      key = newKey();
      user.hash = await keyHash(env, key.replace(/-/g, ""));
      user.gen = (user.gen || 1) + 1; // devices with the old key are signed out
      user.keyMade = now;
    } else if (body.action === "disable" || body.action === "enable") {
      user = find();
      user.active = body.action === "enable";
      user.changed = now;
    } else if (body.action === "set") {
      user = find();
      if (typeof body.active === "boolean") { user.active = body.active; user.changed = now; }
      if (typeof body.debug === "boolean") user.debug = body.debug;
      if (body.full === true) delete user.trial; // a trial becomes a full key (same key, devices keep working)
    } else if (body.action === "approve" || body.action === "decline" || body.action === "delete-request") {
      // Requests (self-service). Approve makes a full key from it; the asking device picks up its sign-in.
      let reqs = await loadRequests(env);
      const r = reqs.find((x) => x.id === body.id);
      if (!r) throw new HttpError(404, "No such request");
      if (body.action === "delete-request") reqs = reqs.filter((x) => x !== r);
      else if (body.action === "decline") {
        r.status = "declined"; r.done = now;
        const reply = String(body.note || "").trim().slice(0, 500);
        if (reply) r.reply = reply; // shown on the asking device
      }
      else {
        if (r.status !== "pending") throw new HttpError(400, "This request was already handled");
        const trialU = r.trialUserId && list.find((x) => x.id === r.trialUserId);
        if (trialU) { // full access for a trial user: same key, limits gone
          delete trialU.trial;
          if (!trialU.emailEnc && r.emailEnc) trialU.emailEnc = r.emailEnc;
          r.status = "approved"; r.userId = trialU.id; r.done = now;
          await saveUsers(env, list);
          await saveRequests(env, reqs);
          return json(request, { ok: true, key: null, upgraded: true, user: publicUser(trialU) });
        }
        key = newKey();
        user = { id: userId(), label: String(body.label || r.name || "New user").trim().slice(0, 60), hash: await keyHash(env, key.replace(/-/g, "")),
          gen: 1, active: true, created: now, keyMade: now, emailEnc: r.emailEnc || null };
        list.push(user);
        r.status = "approved"; r.userId = user.id; r.done = now;
        await saveUsers(env, list);
      }
      await saveRequests(env, reqs);
      return json(request, { ok: true, key, user: user && publicUser(user) });
    } else if (body.action === "message-done" || body.action === "message-delete") {
      let msgs = await loadMessages(env);
      const m = msgs.find((x) => x.id === body.id);
      if (!m) throw new HttpError(404, "No such message");
      if (body.action === "message-delete") msgs = msgs.filter((x) => x !== m); else m.done = now;
      await saveMessages(env, msgs);
      return json(request, { ok: true });
    } else if (body.action === "crypt") {
      // The Users page's email key: public half (JWK) plus the private half locked with the admin password.
      if (!body.pub || !body.wrapped) throw new HttpError(400, "pub and wrapped needed");
      const had = await kvGet(env, "crypt");
      if (had && !body.replace) throw new HttpError(409, "Email encryption is already set up");
      await env.USAGE.put("crypt", JSON.stringify({ pub: body.pub, wrapped: body.wrapped, at: now }));
      countCall("KV writes");
      return json(request, { ok: true });
    } else if (body.action === "rename") {
      user = find();
      const label = String(body.label || "").trim().slice(0, 60);
      if (!label) throw new HttpError(400, "Give a name (label)");
      user.label = label;
    } else if (body.action === "delete") {
      user = find();
      list.splice(list.indexOf(user), 1);
    } else throw new HttpError(400, "action = create, regenerate, set, disable, enable, rename or delete");
    await saveUsers(env, list);
    return json(request, { ok: true, key, user: user && publicUser(user) });
  }
  // GET: the list plus each user's requests per day (last 7 days) and last use.
  await flushUsage(env, true);
  const list = await loadUsers(env, true);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const rec = await readUsageDay(env, d);
    days.push({ day: d, users: rec?.users || {} });
  }
  for (const [id, u] of Object.entries(usage.users)) { // this copy's, not saved yet
    mergeUser(days[0].users[id] || (days[0].users[id] = { n: 0, last: 0 }), u);
  }
  const reqs = await loadRequests(env);
  const crypt = JSON.parse((await kvGet(env, "crypt")) || "null");
  return json(request, {
    legacyCode: !!setting(env, "legacyCode"),
    selfService: selfServiceMode(env),
    crypt: crypt ? { wrapped: crypt.wrapped, at: crypt.at } : null,
    messages: (await loadMessages(env)).slice().reverse().map((m) => ({ id: m.id, at: m.at, kind: m.kind, name: m.name, userId: m.userId || null,
      reqId: m.reqId || null, text: m.text || null, enc: m.enc || null, done: m.done || null })),
    requests: reqs.slice().reverse().map((r) => ({ id: r.id, at: r.at, kind: r.kind, status: r.status, name: r.name, note: r.note, reply: r.reply || null, lang: r.lang || "en",
      emailEnc: r.emailEnc || null, userId: r.userId || null, done: r.done || null })),
    users: list.map((u) => {
      const perDay = days.map((d) => d.users[u.id]?.n || 0).reverse(); // oldest first
      const last = Math.max(0, ...days.map((d) => d.users[u.id]?.last || 0));
      // Devices seen in the last 7 days, newest first. Only counted since the current key was made,
      // so after New key the old devices drop out.
      const made = Date.parse(u.keyMade || u.created || 0) || 0;
      const dev = {};
      for (const d of days) for (const [k, v] of Object.entries(d.users[u.id]?.dev || {})) if (v.last >= made && (!dev[k] || dev[k].last < v.last)) dev[k] = v;
      const devices = Object.entries(dev).map(([id, v]) => ({ id, kind: v.kind || "Other", last: new Date(v.last).toISOString() }))
        .sort((a, b) => b.last.localeCompare(a.last));
      return { ...publicUser(u), perDay, lastUsed: last ? new Date(last).toISOString() : null, devices };
    }),
    days: days.map((d) => d.day).reverse(),
    legacyPerDay: days.map((d) => d.users.legacy?.n || 0).reverse(),
  });
}
const publicUser = (u) => ({ id: u.id, label: u.label, active: u.active !== false, debug: !!u.debug,
  trial: u.trial ? { until: u.trial.until, routes: u.trial.routes, used: u.trial.used || 0, extended: u.trial.extended || null } : null, emailEnc: u.emailEnc || null, created: u.created, keyMade: u.keyMade || u.created, gen: u.gen || 1 });

// ---------------------------------------------------------------- service status (start-screen notice)
// Trouble at the route service is noted in KV "health" only when it changes (works → failing, or
// failing → working again at least 3 minutes after the last failure), so it costs a write now and then.
// Without traffic it clears by itself 15 minutes after the last failure.
const HEALTH_CLEAR_MS = 3 * 60 * 1000, HEALTH_STALE_MS = 15 * 60 * 1000;
async function loadHealth(env) {
  let h = memoGet("health");
  if (h === undefined) { try { h = JSON.parse((await kvGet(env, "health")) || "{}"); } catch (_) { h = {}; } memoSet("health", h, 30 * 1000); }
  return h;
}
async function noteRouteHealth(env, ok) {
  if (!env?.USAGE) return;
  const h = await loadHealth(env), now = Date.now();
  const down = h.ors?.down;
  let next = null;
  if (!ok && !down) next = { down: true, since: now, lastFail: now };
  else if (!ok && down && now - (h.ors.lastFail || 0) > 60 * 1000) next = { ...h.ors, lastFail: now }; // at most a write a minute
  else if (ok && down && now - (h.ors.lastFail || 0) > HEALTH_CLEAR_MS) next = { down: false, since: now };
  if (!next) return;
  const nh = { ...h, ors: next };
  memoSet("health", nh, 30 * 1000);
  await env.USAGE.put("health", JSON.stringify(nh));
  countCall("KV writes");
}
async function handleServiceStatus(request, env) {
  const notices = [];
  const own = String(setting(env, "serviceNotice") || "").trim();
  if (own) notices.push({ id: "own", text: own });
  const h = await loadHealth(env);
  if (h.ors?.down && Date.now() - (h.ors.lastFail || 0) < HEALTH_STALE_MS) {
    notices.push({ id: "ors", text: "We’re experiencing issues with the route service (openrouteservice), beyond our influence, that may affect your experience: planning a route can fail or take longer. It clears by itself once the service works again." });
  }
  return json(request, { notices });
}

// ---------------------------------------------------------------- self-service: requests and trials
// With selfService on, the lock screen offers "No key? Request one": email, name, a note.
//  - requests: kept as a pending request; Remco approves it on the Users page, the asking device picks up
//    its sign-in by itself (pickup token) and Remco can mail the key with his own mail app.
//  - trial: a trial key straight away (Netherlands only, slower status, trialDays / trialRoutes), at most
//    trialPerDay a day, one per device and per email; a second one becomes a request.
// Emails are locked with RSA-OAEP using a public key the Users page made (KV "crypt"); its private half
// is stored locked with the admin password and only opened in the admin's browser. The Worker can't read
// them back. A one-way HMAC of the email spots repeats. Requests live in KV "requests" (one record).
const TRIAL_STATUS_GAP_MS = 3 * 60 * 1000; // trial keys: live status at most every 3 minutes
const TRIAL_EXTEND = { days: 1, routes: 5 }; // once per trial, by the user, when it has run out
const trialInfo = (t) => ({ until: t.until, routesLeft: Math.max(0, t.routes - (t.used || 0)), canExtend: !t.extended,
  extend: TRIAL_EXTEND });
async function handleTrialExtend(request, env) {
  const given = request.headers.get("X-Access") || "";
  const [, id, gen, sig] = given.split(".");
  if (!given.startsWith("u1.") || !id || !sig || !sameText(sig, await userSig(env, id, gen))) throw new HttpError(401, "Access key needed");
  const users = [...(await loadUsers(env, true))];
  const u = users.find((x) => x.id === id && String(x.gen || 1) === gen);
  if (!u?.trial) throw new HttpError(400, "This isn’t a trial key.");
  if (u.trial.extended) throw new HttpError(400, "The trial was already extended once.");
  const now = Date.now();
  const ended = now > Date.parse(u.trial.until) || (u.trial.used || 0) >= u.trial.routes;
  if (!ended) throw new HttpError(400, "Your trial is still running.");
  u.trial.until = new Date(Math.max(now, Date.parse(u.trial.until)) + TRIAL_EXTEND.days * 86400000).toISOString();
  u.trial.routes = Math.max(u.trial.routes, u.trial.used || 0) + TRIAL_EXTEND.routes;
  u.trial.extended = new Date(now).toISOString();
  await saveUsers(env, users);
  return json(request, { ok: true, trial: trialInfo(u.trial) });
}
const selfServiceMode = (env) => { const m = setting(env, "selfService"); return m === "requests" || m === "trial" ? m : "off"; };
async function loadRequests(env) {
  try { return JSON.parse((await kvGet(env, "requests")) || "[]"); } catch (_) { return []; }
}
async function saveRequests(env, list) {
  const cut = Date.now() - 90 * 86400000; // done requests older than 90 days go
  list = list.filter((r) => r.status === "pending" || Date.parse(r.at) > cut).slice(-300);
  await env.USAGE.put("requests", JSON.stringify(list));
  countCall("KV writes");
  return list;
}
async function encryptEmail(env, email) {
  const crypt = JSON.parse((await kvGet(env, "crypt")) || "null");
  if (!crypt?.pub) return null; // not set up yet: the email isn't kept (the request still is)
  const key = await crypto.subtle.importKey("jwk", crypt.pub, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const enc = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, new TextEncoder().encode(email));
  return btoa(String.fromCharCode(...new Uint8Array(enc)));
}
const emailHash = (env, email) => hmac(env, `email:${email.trim().toLowerCase()}`);
const randomToken = () => [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, "0")).join("");
function tokenFor(env, u) { return userSig(env, u.id, u.gen || 1).then((sig) => `u1.${u.id}.${u.gen || 1}.${sig}`); }

// A trial user asking for full access (their token in X-Access): a pending "upgrade" request linked to
// their trial key, allowed whatever the self-service setting; approving it lifts the trial limits on
// the same key, so their app keeps working. Email optional: the trial's email is reused.
async function trialUserOf(request, env) {
  const given = request.headers.get("X-Access") || "";
  const [, id, gen, sig] = given.split(".");
  if (!given.startsWith("u1.") || !id || !sig || !sameText(sig, await userSig(env, id, gen))) return null;
  const u = (await loadUsers(env, true)).find((x) => x.id === id && String(x.gen || 1) === gen);
  return u?.trial ? u : null;
}
async function handleRequest(request, env) {
  const trialUser = await trialUserOf(request, env);
  const mode = trialUser ? "requests" : selfServiceMode(env);
  if (mode === "off") throw new HttpError(403, "Requests are closed at the moment.");
  if (!env.USAGE) throw new HttpError(503, "No KV store bound");
  const ip = request.headers.get("CF-Connecting-IP") || "?";
  const rk = `req:${ip}`;
  if ((memoGet(rk) || 0) >= 3) throw new HttpError(429, "Too many requests from here. Try again in an hour.");
  memoSet(rk, (memoGet(rk) || 0) + 1, 60 * 60 * 1000);
  const body = await request.json().catch(() => ({}));
  if (body.website) return json(request, { pending: true }); // honeypot: a bot filled the hidden field
  const email = String(body.email || "").trim().slice(0, 120);
  if (!(trialUser && !email) && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, "That email address doesn’t look right.");
  const name = String(body.name || "").trim().slice(0, 60);
  const note = String(body.note || "").trim().slice(0, 300);
  const device = String(body.device || "").replace(/[^a-z0-9]/g, "").slice(0, 12);
  const lang = ["nl", "pt"].includes(body.lang) ? body.lang : "en"; // for the key email
  const hash = email ? await emailHash(env, email) : `user:${trialUser.id}`;
  const ipHash = (await hmac(env, `ip:${ip}`)).slice(0, 16);
  let list = await loadRequests(env);
  const now = new Date().toISOString(), today = now.slice(0, 10);

  if (mode === "trial") {
    const usedHere = list.some((r) => r.kind === "trial" && (r.emailHash === hash || (device && r.device === device) || (r.ipHash === ipHash && r.at.slice(0, 10) === today)));
    const todayCount = list.filter((r) => r.kind === "trial" && r.at.slice(0, 10) === today).length;
    if (!usedHere && todayCount < Number(setting(env, "trialPerDay"))) {
      const users = [...(await loadUsers(env, true))];
      if (users.length >= 200) throw new HttpError(400, "No room for new keys at the moment.");
      const until = new Date(Date.now() + Number(setting(env, "trialDays")) * 86400000).toISOString();
      const emailEnc = await encryptEmail(env, email);
      const u = { id: userId(), label: name || "Trial", hash: await keyHash(env, newKey().replace(/-/g, "")), gen: 1, active: true,
        created: now, keyMade: now, emailEnc, trial: { until, routes: Number(setting(env, "trialRoutes")), used: 0 } };
      users.push(u);
      await saveUsers(env, users);
      list.push({ id: userId(), at: now, kind: "trial", status: "approved", userId: u.id, name, note, emailEnc, emailHash: hash, device, ipHash });
      await saveRequests(env, list);
      return json(request, { token: await tokenFor(env, u), name: u.label, trial: { until, routesLeft: u.trial.routes } });
    }
    // A second trial, or today's trials used up: a normal request instead.
  }
  let r = list.find((x) => x.status === "pending" && (trialUser ? x.trialUserId === trialUser.id : x.emailHash === hash));
  const pickup = randomToken();
  if (r) { r.pickup = await hmac(env, `pickup:${pickup}`); r.device = device || r.device; if (note) r.note = note; if (name) r.name = name; }
  else {
    if (list.filter((x) => x.status === "pending").length >= 50) throw new HttpError(429, "Too many open requests at the moment. Try again later.");
    r = { id: userId(), at: now, kind: trialUser ? "upgrade" : "request", status: "pending", name: name || trialUser?.label || "",
      note, emailEnc: email ? await encryptEmail(env, email) : trialUser?.emailEnc || null,
      emailHash: hash, device, ipHash, lang, pickup: await hmac(env, `pickup:${pickup}`), ...(trialUser ? { trialUserId: trialUser.id } : {}) };
    list.push(r);
  }
  await saveRequests(env, list);
  return json(request, { pending: true, id: r.id, pickup, trialUsed: mode === "trial", upgrade: !!trialUser });
}
// ---------------------------------------------------------------- messages to Remco (privacy, notes)
// From Help › Privacy (a key) or the waiting screen (a request): a note, or a request to delete my data.
// Kept in KV "messages"; the text is encrypted like emails (AES-GCM, its key locked with the Users
// page's RSA key), so only the Users page can read it.
async function loadMessages(env) { try { return JSON.parse((await kvGet(env, "messages")) || "[]"); } catch (_) { return []; } }
async function saveMessages(env, list) {
  const cut = Date.now() - 90 * 86400000;
  list = list.filter((m) => !m.done || Date.parse(m.at) > cut).slice(-200);
  await env.USAGE.put("messages", JSON.stringify(list));
  countCall("KV writes");
}
async function encryptText(env, text) {
  const crypt = JSON.parse((await kvGet(env, "crypt")) || "null");
  if (!crypt?.pub) return { text }; // encryption not set up yet
  const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const d = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(text));
  const rsa = await crypto.subtle.importKey("jwk", crypt.pub, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const k = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, await crypto.subtle.exportKey("raw", aes));
  const b = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  return { enc: { k: b(k), iv: b(iv), d: b(d) } };
}
// Who is writing: a key holder (token) or a waiting request (id + pickup). Null if neither.
async function senderOf(request, env, body) {
  const given = request.headers.get("X-Access") || "";
  if (given.startsWith("u1.")) {
    const [, id, gen, sig] = given.split(".");
    if (id && sig && sameText(sig, await userSig(env, id, gen))) {
      const u = (await loadUsers(env, true)).find((x) => x.id === id);
      if (u) return { userId: u.id, name: u.label };
    }
  }
  if (body.id && body.t) {
    const r = (await loadRequests(env)).find((x) => x.id === body.id);
    if (r && sameText(r.pickup || "", await hmac(env, `pickup:${body.t}`))) return { reqId: r.id, name: r.name || "" };
  }
  return null;
}
async function handleContact(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "?";
  const rk = `contact:${ip}`;
  if ((memoGet(rk) || 0) >= 5) throw new HttpError(429, "Too many messages from here. Try again in an hour.");
  memoSet(rk, (memoGet(rk) || 0) + 1, 60 * 60 * 1000);
  const body = await request.json().catch(() => ({}));
  const from = await senderOf(request, env, body);
  if (!from) throw new HttpError(401, "Messages can only be sent from the app with a key or a waiting request.");
  const kind = body.kind === "delete" ? "delete" : "note";
  const text = String(body.text || "").trim().slice(0, 1000);
  if (kind === "note" && !text) throw new HttpError(400, "Write a message first.");
  const list = await loadMessages(env);
  // One open deletion request per key: a second one changes nothing (the app shows it as pending).
  if (kind === "delete" && from.userId && list.some((m) => !m.done && m.kind === "delete" && m.userId === from.userId)) {
    return json(request, { ok: true, already: true });
  }
  if (list.filter((m) => !m.done).length >= 100) throw new HttpError(429, "Too many open messages at the moment. Try again later.");
  list.push({ id: userId(), at: new Date().toISOString(), kind, ...from, ...(text ? await encryptText(env, text) : {}) });
  await saveMessages(env, list);
  return json(request, { ok: true });
}
// The key holder takes back an open deletion request (Help › Privacy › Cancel).
async function handleCancelDelete(request, env) {
  const from = await senderOf(request, env, {});
  if (!from?.userId) throw new HttpError(401, "Access key needed");
  const list = await loadMessages(env);
  const keep = list.filter((m) => !(!m.done && m.kind === "delete" && m.userId === from.userId));
  if (keep.length !== list.length) await saveMessages(env, keep);
  return json(request, { ok: true });
}
async function handleWithdraw(request, env) {
  const body = await request.json().catch(() => ({}));
  const list = await loadRequests(env);
  const r = list.find((x) => x.id === body.id);
  if (!r || !body.t || !sameText(r.pickup || "", await hmac(env, `pickup:${body.t}`))) throw new HttpError(404, "No such request.");
  if (r.status === "approved") throw new HttpError(400, "This request was already approved.");
  await saveRequests(env, list.filter((x) => x !== r)); // gone, email and all
  memo.delete(`reqst:${r.id}`);
  return json(request, { ok: true });
}
async function handleRequestStatus(request, env, url) {
  const id = url.searchParams.get("id") || "", t = url.searchParams.get("t") || "";
  const k = `reqst:${id}`;
  let r = memoGet(k);
  if (r === undefined) { r = (await loadRequests(env)).find((x) => x.id === id) || null; memoSet(k, r, 30 * 1000); }
  if (!r || !t || !sameText(r.pickup || "", await hmac(env, `pickup:${t}`))) return json(request, { status: "unknown" });
  if (r.status === "declined") return json(request, { status: "declined", reply: r.reply || null });
  if (r.status !== "approved" || !r.userId) return json(request, { status: r.status });
  const u = (await loadUsers(env)).find((x) => x.id === r.userId);
  if (!u) return json(request, { status: "unknown" });
  return json(request, { status: "approved", token: await tokenFor(env, u), name: u.label, debug: !!u.debug });
}
// Trial limits on the Worker side (who.trial set): France, Belgium and debug are for full keys; each
// /plan uses one of the trial's routes (counted in the users record: one KV write per route).
async function trialGate(path, request, env, who) {
  if (path === "/fr-status" || path === "/be-status" || path === "/be-evse") {
    throw new HttpError(403, "Live status outside the Netherlands is for full keys.", "trial-country");
  }
  if (path === "/plan" && request.method === "POST") {
    const users = [...(await loadUsers(env, true))];
    const u = users.find((x) => x.id === who.id);
    if (!u?.trial) return;
    if ((u.trial.used || 0) >= u.trial.routes) {
      throw new HttpError(403, "Your trial’s routes are used up.", "trial-ended", { trial: trialInfo(u.trial), selfService: selfServiceMode(env) !== "off" });
    }
    u.trial.used = (u.trial.used || 0) + 1;
    await saveUsers(env, users);
  }
}

// Who is asking: { id } for a personal key, { id: "legacy" } for the old shared code, { id: "admin" }
// for the admin password, or null.
async function whoIs(request, env, url) {
  const given = request.headers.get("X-Access") || url.searchParams.get("access") || "";
  if (!given) return null;
  if (given.startsWith("u1.")) {
    const [, id, gen, sig] = given.split(".");
    if (!id || !sig || !sameText(sig, await userSig(env, id, gen))) return null;
    const u = (await loadUsers(env)).find((x) => x.id === id);
    if (!u) throw new HttpError(401, "This access key no longer exists. Ask for a new one.", "deleted");
    if (String(u.gen || 1) !== gen) throw new HttpError(401, "This access key was replaced. Enter the new one.", "replaced");
    // "off" is a pause: the app keeps its token and works again once the key is switched back on.
    if (u.active === false) throw new HttpError(401, "This access key is switched off for now.", "off");
    if (u.trial && Date.now() > Date.parse(u.trial.until)) {
      // Like "off": the device keeps its token, so it works again if the key is made full.
      throw new HttpError(401, "Your trial has ended.", "trial-ended", { trial: trialInfo(u.trial), selfService: selfServiceMode(env) !== "off" });
    }
    return { id, name: u.label, debug: !!u.debug, trial: u.trial || null };
  }
  if (sameText(given, await accessToken(env))) {
    if (!setting(env, "legacyCode")) throw new HttpError(401, "The old access code no longer works. Enter your personal key.", "legacy-off");
    return { id: "legacy", debug: false };
  }
  // The admin password works too (handy for opening /debug/… pages in a browser: ?access=<password>).
  if (env.ADMIN_TOKEN && sameText(given, env.ADMIN_TOKEN)) return { id: "admin", debug: true };
  return null;
}
async function handleUnlock(request, env) {
  // Max 5 tries per 10 minutes per address, so guessing takes a while.
  const ip = request.headers.get("CF-Connecting-IP") || "?";
  const key = `unlock:${ip}`;
  const tries = memoGet(key) || 0;
  if (tries >= 5) throw new HttpError(429, "Too many tries. Wait 10 minutes.");
  memoSet(key, tries + 1, 10 * 60 * 1000);
  const body = await request.json().catch(() => ({}));
  const given = String(body.code || "").toUpperCase().replace(/[\s\-.]/g, "");
  if (validKey(given)) {
    const hash = await keyHash(env, given);
    const u = (await loadUsers(env, true)).find((x) => sameText(x.hash, hash));
    if (u && u.active === false) throw new HttpError(403, "This access key has been switched off.");
    if (u) {
      memo.delete(key); // a right key resets the tries
      return json(request, { token: `u1.${u.id}.${u.gen || 1}.${await userSig(env, u.id, u.gen || 1)}`, name: u.label, debug: !!u.debug });
    }
  } else if (setting(env, "legacyCode") && elfProef(given)) {
    return json(request, { token: await accessToken(env) });
  }
  await sleep(800);
  throw new HttpError(403, "That key isn’t right.");
}

// Each request's key {id, name, debug}, looked up by its request (a module variable could be
// overwritten by another request while this one waits on a fetch).
const WHO_OF = new WeakMap();
async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(request) });
  await loadSettings(env); // switches from the usage page (cached a minute); the old-code switch is one
  if (path === "/unlock" && request.method === "POST") return handleUnlock(request, env);
  if (path === "/service-status" && request.method === "GET") return handleServiceStatus(request, env);
  if (path === "/self-service" && request.method === "GET") return json(request, { mode: selfServiceMode(env) });
  if (path === "/request" && request.method === "POST") return handleRequest(request, env);
  if (path === "/request/status" && request.method === "GET") return handleRequestStatus(request, env, url);
  if (path === "/trial/extend" && request.method === "POST") return handleTrialExtend(request, env);
  if (path === "/contact" && request.method === "POST") return handleContact(request, env);
  if (path === "/contact/cancel-delete" && request.method === "POST") return handleCancelDelete(request, env);
  if (path === "/request/withdraw" && request.method === "POST") return handleWithdraw(request, env);
  let who = null;
  if (!PUBLIC_PATHS.has(path) && !path.startsWith("/logo/")) {
    who = await whoIs(request, env, url);
    if (!who) throw new HttpError(401, "Access key needed");
    if (who.id !== "admin") {
      const d = (url.searchParams.get("d") || "").replace(/[^a-z0-9]/g, "").slice(0, 12);
      countUser(who.id, d || null, d ? deviceKind(request) : null);
    }
    WHO_OF.set(request, who);
    // Debug tools only for keys with Debug switched on (Users page) or the admin password.
    if (path.startsWith("/debug/") && !who.debug) throw new HttpError(403, "Debug isn’t switched on for this key");
    if (who.trial) await trialGate(path, request, env, who);
  }
  if (path === "/me" && request.method === "GET") {
    const deletePending = who && who.id !== "legacy" && who.id !== "admin"
      ? (await loadMessages(env)).some((m) => !m.done && m.kind === "delete" && m.userId === who.id) : false;
    return json(request, { name: who?.name || null, debug: !!who?.debug, legacy: who?.id === "legacy", deletePending,
      trial: who?.trial ? trialInfo(who.trial) : null, occBrands: occBrands(env), occCountries: OCC_COUNTRIES });
  }

  if (path === "/" && request.method === "GET") {
    return json(request, {
      ok: true,
      service: "evailability proxy",
      // Fingerprint for the app's debug line: which Worker code answers (set by Cloudflare per deploy).
      version: WORKER_VERSION,
      deployId: env.CF_VERSION_METADATA?.id?.slice(0, 8) || null,
      deployedAt: env.CF_VERSION_METADATA?.timestamp || null,
      secrets: { ORS_API_KEY: !!env.ORS_API_KEY, OCM_API_KEY: !!env.OCM_API_KEY, ECO_BE_TOKEN: !!env.ECO_BE_TOKEN },
      plan: isPaid(env) ? `paid until ${paidUntil(env)}` : "free",
    });
  }
  if (path === "/geocode" && request.method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) throw new HttpError(400, "Add ?q=<place>");
    return json(request, { results: await geocode(env, q) });
  }
  if (path === "/closures/schedule" && request.method === "GET") {
    // Public on purpose: only the update interval, for the scheduled GitHub job (no secrets in GitHub needed).
    const h = Number(setting(env, "closuresHours"));
    return json(request, { hours: [6, 12, 24, 48].includes(h) ? h : 12 }); // an old saved "Off" (0) counts as 12
  }
  if (path === "/occupancy/config" && request.method === "GET") {
    // Public on purpose: on/off and brand name patterns only, for the GitHub job (no secrets there).
    const all = url.searchParams.get("all") === "1"; // de-index.yml: every brand, whatever is followed
    const keys = all ? BRANDS.map((b) => b.key) : occBrands(env);
    return json(request, { on: keys.length > 0, keepDays: OCC_KEEP_DAYS,
      brands: keys.map((k) => ({ key: k, live: BRAND[k].live.source, evse: BRAND[k].evse.source })) });
  }
  if (path === "/occupancy" && request.method === "GET") return handleOccupancy(request, env, url);
  if (path === "/occupancy/at" && request.method === "GET") return handleOccupancyAt(request, env, url);
  if (path === "/admin/usage" && request.method === "GET") return handleUsage(request, env);
  if (path === "/admin/settings" && (request.method === "GET" || request.method === "POST")) return handleSettings(request, env);
  if (path === "/admin/users" && (request.method === "GET" || request.method === "POST")) return handleUsers(request, env);
  if (path === "/admin/timer" && (request.method === "GET" || request.method === "POST")) return handleTimer(request, env);
  if (path === "/admin/push" && (request.method === "GET" || request.method === "POST")) return handlePush(request, env);
  if (path === "/admin/alerts" && (request.method === "GET" || request.method === "POST")) return handleAlerts(request, env);
  if (path === "/plan" && request.method === "POST") return handlePlan(request, env);
  if (path === "/status" && request.method === "POST") return handleStatus(request, env);
  if (path === "/fr-status" && request.method === "POST") {
    // Reading the national file costs more CPU than the free plan allows; automatic updates used up the
    // Worker's allowance on 14 Nov so that /plan failed too (1102). The app now asks only on a tap, at
    // most every few minutes (setting "France: minutes between updates").
    // Switch: "France live (tap)" on the usage page (or the Worker variable FR_LIVE = "off").
    // Since Worker 0.4.0 France comes with /status (from a 5-minute snapshot); this stays for app copies
    // older than 0.30, which still ask here on a tap (gapMin 1: the snapshot changes every 5 minutes).
    if (!setting(env, "frLive")) return json(request, { status: {}, off: true });
    const body = await request.json().catch(() => ({}));
    if (!Array.isArray(body.stations)) throw new HttpError(400, "Send {stations:[{id, lat, lon, brand}]}");
    return json(request, { ...(await frStatusFor(body.stations, minKwOf(body.minKw))), gapMin: 1, pauseMin: 2, paid: isPaid(env) });
  }
  if (path === "/be-status" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (!Array.isArray(body.stations)) throw new HttpError(400, "Send {stations:[{id, lat, lon, brand}]}");
    return json(request, await beStatusFor(body.stations, minKwOf(body.minKw), env));
  }
  if (path === "/be-evse" && request.method === "GET") {
    const r = await beEvse(env, url.searchParams.get("id") || "");
    if (r.kind && !r.cached) await beRemember(env, r);
    return json(request, r);
  }
  if (path === "/debug/be" && request.method === "GET") {
    // Raw Eco-Movement answer for one stall plus what we read from it: /debug/be?id=BE*IOY*E417904
    if (!env.ECO_BE_TOKEN) throw new HttpError(500, "ECO_BE_TOKEN is not set");
    const id = url.searchParams.get("id") || "";
    countCall("Eco-Movement BE");
    const res = await fetch(BE_STATUS_BASE + encodeURIComponent(id), { headers: { Authorization: `Bearer ${env.ECO_BE_TOKEN}`, Accept: "application/json" } });
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch (_) {}
    const headers = Object.fromEntries([...res.headers].filter(([k]) => /rate|retry|link/i.test(k)));
    return json(request, { http: res.status, headers, parsed: data ? beParseStatus(data, id) : null, raw: data ?? text.slice(0, 4000) });
  }
  if (path === "/where" && request.method === "GET") {
    const lat = Number(url.searchParams.get("lat")), lon = Number(url.searchParams.get("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new HttpError(400, "Add ?lat=..&lon=..");
    const h = Number(url.searchParams.get("heading"));
    return json(request, await whereAt(env, [lon, lat], url.searchParams.has("heading") && Number.isFinite(h) ? h : null));
  }
  if (path.startsWith("/debug/route/") && request.method === "GET") {
    return handleDebugRoute(request, env, path.slice(13).toLowerCase(), url.searchParams.get("part"));
  }
  if (path === "/alternatives" && request.method === "POST") return handleAlternatives(request, env);
  if (path === "/detours" && request.method === "POST") return handleDetours(request, env);
  if (path === "/ndw-sites" && request.method === "POST") return handleNdwSites(request, env);
  if (path === "/extra-sites" && request.method === "POST") return handleExtraSites(request, env);
  if (path === "/places" && request.method === "POST") return handlePlaces(request, env);
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
  if (path === "/debug/fr-range" && request.method === "GET") {
    // /debug/fr-range                      → does Range work, how big is the file
    // /debug/fr-range?part=3&parts=10      → read piece 3 of 10 only (check this call's CPU time in the Cloudflare logs)
    // &ids=FRIOYE413102,FRIOYE413103       → ids to look for (default: Ionity Village Catalan Est)
    const ids = new Set((url.searchParams.get("ids") ||
      "FRIOYE413102,FRIOYE413103,FRIOYE413104,FRIOYE413105,FRIOYE413152,FRIOYE413153,FRIOYE413202,FRIOYE413203,FRIOYE413204,FRIOYE413205,FRIOYE413252,FRIOYE413253")
      .split(",").map((s) => s.trim()).filter(Boolean));
    if (url.searchParams.get("whole") === "1") {
      // The whole file in one call: its CPU time in the Cloudflare logs says whether the free plan can carry it.
      const t0 = Date.now();
      const whole = await frWhole(ids);
      return json(request, { wallMs: Date.now() - t0, ...whole });
    }
    const probe = await frProbe();
    const partParam = url.searchParams.get("part");
    if (partParam == null || !probe.rangeWorks) return json(request, { probe });
    const parts = Math.min(50, Math.max(1, Number(url.searchParams.get("parts")) || 10));
    const part = Math.min(parts - 1, Math.max(0, Number(partParam) || 0));
    const t0 = Date.now();
    const piece = await frPiece(probe.total, part, parts, ids);
    return json(request, { probe: { total: probe.total, lastModified: probe.headers["last-modified"] }, wallMs: Date.now() - t0, ...piece });
  }
  if (path === "/debug/ocm-operator" && request.method === "GET") {
    return json(request, { ionity: (await brandOperators(env)).byBrand.ionity });
  }
  throw new HttpError(404, "Unknown endpoint");
}

// ---------------------------------------------------------------- timer (Cron Trigger)
// Every 5 minutes (wrangler.toml [triggers]) the Worker starts GitHub jobs itself, because GitHub's own
// schedule often starts hours late or not at all. It signs in as the GitHub App "EVailability timer"
// (owned by RemcoNLD, installed on this repo only, permission Actions: read and write) with GH_APP_ID
// (variable) and GH_APP_KEY (secret: the App's .pem key), and gets a one-hour installation token.
// Nothing here expires: the App key is valid until it's deleted on GitHub (App > Credentials > Key pairs).
//   Portugal live (pt-live.yml) and France live (fr-live.yml, while the frLive setting is on): every tick.
//   Road closures (closures.yml): started once data/closures.json is older than the interval set on the
//   usage page (checked every 15 minutes). A started run always updates (FORCE), so the timer decides.
// KV "timer": the state shown on the usage page, written only when it changes, plus when closures last
// started (at most a few writes a day). GET/POST /admin/timer shows it / checks the App now.
const GH_REPO = "RemcoNLD/apps";
const GH_API = "https://api.github.com";
const CLOSURES_RAW = `https://raw.githubusercontent.com/${GH_REPO}/main/data/closures.json`;
const gh = { pem: null, key: null, installId: null, token: null, tokenExp: 0 };

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = (s) => b64url(new TextEncoder().encode(s));
function derLen(n) {
  if (n < 128) return [n];
  const b = [];
  while (n) { b.unshift(n & 255); n >>= 8; }
  return [0x80 | b.length, ...b];
}
// GitHub hands out PKCS#1 keys ("BEGIN RSA PRIVATE KEY"); Web Crypto only imports PKCS#8, so wrap it.
function pemToPkcs8(pem) {
  const text = String(pem).replace(/\\n/g, "\n");
  if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(text) || !/-----END (RSA )?PRIVATE KEY-----/.test(text)) {
    throw new Error("GH_APP_KEY isn’t a complete .pem key (BEGIN or END line missing)");
  }
  const body = text.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  let der;
  try { der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0)); }
  catch (_) { throw new Error("GH_APP_KEY has characters that don’t belong in a key (pasted wrong?)"); }
  if (!/BEGIN RSA PRIVATE KEY/.test(text)) return der; // already PKCS#8
  const alg = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const head = [0x02, 0x01, 0x00, ...alg, 0x04, ...derLen(der.length)];
  const out = new Uint8Array([0x30, ...derLen(head.length + der.length), ...head, ...der]);
  return out;
}
async function appKey(env) {
  if (gh.key && gh.pem === env.GH_APP_KEY) return gh.key;
  if (!env.GH_APP_KEY) throw new Error("GH_APP_KEY isn’t set in the Worker");
  try {
    gh.key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(env.GH_APP_KEY),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch (e) {
    if (/GH_APP_KEY/.test(e.message)) throw e;
    throw new Error("GH_APP_KEY couldn’t be read as a private key (incomplete or a different file?)");
  }
  gh.pem = env.GH_APP_KEY;
  gh.installId = null; gh.token = null; // a new key: sign in afresh
  return gh.key;
}
async function appJwt(env) {
  const id = String(env.GH_APP_ID || "").trim();
  if (!/^\d+$/.test(id)) throw new Error("GH_APP_ID isn’t set (or isn’t a number) in the Worker");
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64urlText(JSON.stringify({ iat: now - 60, exp: now + 540, iss: id }))}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await appKey(env), new TextEncoder().encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}
async function ghCall(path, bearer, method = "GET", body) {
  countCall("GitHub API");
  const res = await fetch(`${GH_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "evailability-worker",
      ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) {}
  return { status: res.status, ok: res.ok, data };
}
// Installation token, kept per Worker copy until 5 minutes before it expires (valid one hour).
async function installToken(env) {
  if (gh.token && Date.now() < gh.tokenExp - 5 * 60 * 1000 && gh.pem === env.GH_APP_KEY) return gh.token;
  const jwt = await appJwt(env);
  if (!gh.installId) {
    const r = await ghCall(`/repos/${GH_REPO}/installation`, jwt);
    if (r.status === 401) throw new Error("GitHub doesn’t accept the App’s sign-in: GH_APP_ID and GH_APP_KEY don’t belong together (or the key was deleted)");
    if (r.status === 404) throw new Error(`The App isn’t installed on ${GH_REPO} (GitHub > the App > Install App)`);
    if (!r.ok) throw new Error(`GitHub ${r.status} looking up the installation: ${r.data?.message || "no message"}`);
    gh.installId = r.data.id;
  }
  const t = await ghCall(`/app/installations/${gh.installId}/access_tokens`, jwt, "POST");
  if (t.status === 404) { gh.installId = null; throw new Error(`The App isn’t installed on ${GH_REPO} any more`); }
  if (!t.ok) throw new Error(`GitHub ${t.status} giving a token: ${t.data?.message || "no message"}`);
  gh.token = t.data.token; // passed on as given (GitHub's token format may change length)
  gh.tokenExp = Date.parse(t.data.expires_at) || Date.now() + 50 * 60 * 1000;
  return gh.token;
}
async function startWorkflow(env, file) {
  const token = await installToken(env);
  const r = await ghCall(`/repos/${GH_REPO}/actions/workflows/${file}/dispatches`, token, "POST", { ref: "main" });
  if (r.status === 403) throw new Error(`The App may not start ${file}: give it Actions: Read and write (GitHub > the App > Permissions & events), then accept the change under Install App`);
  if (r.status === 401) { gh.token = null; throw new Error("GitHub refused the installation token; trying again next time"); }
  if (!r.ok) throw new Error(`GitHub ${r.status} starting ${file}: ${r.data?.message || "no message"}`);
}
// Hours since data/closures.json was made, from its first bytes ("generatedAt" comes first).
// No Range request: GitHub gzips the file, so a byte range is a cut-off gzip stream ("Gzip compressed
// stream ended prematurely", 18-23 Nov 2026). Instead the whole file is asked and only the start read.
async function closuresAgeH() {
  countCall("GitHub raw");
  const res = await fetch(CLOSURES_RAW, { cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error(`closures.json: ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let head = "";
  try {
    while (head.length < 4000) {
      const { value, done } = await reader.read();
      if (done) break;
      head += dec.decode(value, { stream: true });
      if (/"generatedAt"\s*:\s*"[^"]+"/.test(head)) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const m = /"generatedAt"\s*:\s*"([^"]+)"/.exec(head);
  if (!m) throw new Error("closures.json has no generatedAt");
  return (Date.now() - Date.parse(m[1])) / 36e5;
}
async function loadTimer(env) {
  try { return JSON.parse((await kvGet(env, "timer")) || "{}"); } catch (_) { return {}; }
}
async function saveTimer(env, state) {
  try { await env.USAGE.put("timer", JSON.stringify(state)); countCall("KV writes"); } catch (e) { console.log("Timer save failed", e.message); }
}
// One job's outcome into the state; true if it's worth saving (became OK or failed, or a different error).
function noteJob(state, job, ok, msg) {
  const prev = state[job] || {};
  const now = new Date().toISOString();
  const changed = prev.ok !== ok || (!ok && prev.msg !== msg);
  state[job] = { ...prev, ok, msg, since: changed ? now : prev.since || now };
  return changed;
}
const TIMER_JOBS = { pt: "Portugal live", fr: "France live", closures: "Road closures", occ: "Occupancy" };
async function runTimer(env, at = Date.now()) {
  await loadSettings(env);
  const state = await loadTimer(env);
  const msgs = [];
  let save = false;
  try {
    await startWorkflow(env, "pt-live.yml");
    save = noteJob(state, "pt", true, "starts every 5 minutes") || save;
  } catch (e) {
    save = noteJob(state, "pt", false, e.message) || save;
    console.log("Timer: Portugal live", e.message);
  }
  if (setting(env, "frLive")) {
    try {
      await startWorkflow(env, "fr-live.yml");
      save = noteJob(state, "fr", true, "starts every 5 minutes") || save;
    } catch (e) {
      save = noteJob(state, "fr", false, e.message) || save;
      console.log("Timer: France live", e.message);
    }
  }
  if (new Date(at).getUTCMinutes() % 15 < 5) {
    try {
      const h = Number(setting(env, "closuresHours"));
      const hours = [6, 12, 24, 48].includes(h) ? h : 12;
      const age = await closuresAgeH();
      const startedAgoMin = (Date.now() - Date.parse(state.closures?.startedAt || 0)) / 60000;
      // 15 minutes early is fine; never twice within 45 minutes (the run takes a few minutes to commit).
      if (age >= hours - 0.25 && startedAgoMin > 45) {
        await startWorkflow(env, "closures.yml");
        state.closures = { ...(state.closures || {}), startedAt: new Date().toISOString() };
        save = true;
      }
      save = noteJob(state, "closures", true, `every ${hours} h`) || save;
    } catch (e) {
      save = noteJob(state, "closures", false, e.message) || save;
      console.log("Timer: Road closures", e.message);
    }
    // Occupancy through the day: one reading per 15 minutes (the job's own schedule is the backup).
    if (setting(env, "occupancy")) {
      try {
        await startWorkflow(env, "occupancy.yml");
        save = noteJob(state, "occ", true, "starts every 15 minutes") || save;
      } catch (e) {
        save = noteJob(state, "occ", false, e.message) || save;
        console.log("Timer: Occupancy", e.message);
      }
    }
    // Failed GitHub runs (also ones the timer didn't start: deploys, pushes, GitHub's own schedule).
    try { save = (await checkWorkflowRuns(env, state)) || save; }
    catch (e) { console.log("Timer: workflow runs", e.message); }
  }
  if (save) await saveTimer(env, state);
  // Push notifications: incidents from the alert rules (timer jobs, route service, GitHub jobs, daily
  // limits, service health), see "admin alerts".
  try { msgs.push(...(await runAlerts(env, at, state, 5 - msgs.length))); }
  catch (e) { console.log("Timer: alerts", e.message); }
  for (const m of msgs.slice(0, 5)) {
    try { await notifyAdmin(env, m); } catch (e) { console.log("Push failed", e.message); }
  }
  return state;
}
// GET: the timer's state. POST: check the App now (sign in, token, may it see the workflows?) without
// starting anything.
async function handleTimer(request, env) {
  checkAdmin(request, env);
  const state = await loadTimer(env);
  if (request.method === "GET") return json(request, { state, appId: env.GH_APP_ID || null, keySet: !!env.GH_APP_KEY });
  const steps = [];
  try {
    gh.token = null; // a real check: sign in again
    const token = await installToken(env);
    steps.push(`Signed in as the App (id ${env.GH_APP_ID}) and got a token for ${GH_REPO}`);
    const r = await ghCall(`/repos/${GH_REPO}/actions/workflows?per_page=50`, token);
    if (!r.ok) throw new Error(`The App can’t see the workflows (GitHub ${r.status}): give it Actions: Read and write`);
    const files = (r.data.workflows || []).map((w) => w.path.split("/").pop());
    for (const f of ["pt-live.yml", "fr-live.yml", "closures.yml", "occupancy.yml"]) {
      if (!files.includes(f)) throw new Error(`${f} isn’t in the repo`);
    }
    steps.push("It can see Portugal live, France live, Road closures and Occupancy");
    return json(request, { ok: true, steps, state });
  } catch (e) {
    return json(request, { ok: false, steps, error: e.message, state });
  }
}

// ---------------------------------------------------------------- admin alerts (Worker 0.8.0)
// Rules for push notifications to the usage page, changed there (tap a row › Notifications), and
// incidents: a rule that goes off opens an incident with one push; it can be acknowledged with a
// quiet period (no pushes for it meanwhile), resolves by itself once the rule is fine again for a few
// checks, and stays in a log. Evaluated by the 5-minute timer (runTimer) from the usage record's
// 5-minute slots (see usage counting), so it costs no extra KV writes except on incident changes.
//   KV "alerts":     {defaults: {general, limit, service, job}, rules: {<target key>: partial rule}}
//   KV "alerts-log": {started, open: {<target key>: incident}, log: [closed incidents, newest first]}
// Target keys: limit:<source> (daily limits), svc:<service> / api:<endpoint> (service health),
// job:pt|fr|closures (timer jobs), ors (route service notice), gh:<workflow name> (GitHub jobs).
const ALERT_TZ = "Europe/Amsterdam";
const ALERT_DEFAULTS = {
  general: { remindMin: 30, resolveChecks: 2, reopenMin: 30, quietOn: true, quietFrom: 23, quietTo: 7 },
  limit: { on: true, forecast: true, horizonH: 3, pct: 80, resolvedPush: true },
  service: { on: true, fails: 1, failsMin: 5, noSuccess: false, rate: 90, rateMin: 15, minCalls: 10, slowMs: 0, slowMin: 15, resolvedPush: true },
  job: { on: true, resolvedPush: true },
};
// [min, max, step] for numbers; "bool" for switches.
const ALERT_FIELDS = {
  general: { remindMin: [0, 1440, 5], resolveChecks: [1, 12, 1], reopenMin: [0, 240, 5], quietOn: "bool", quietFrom: [0, 23, 1], quietTo: [0, 23, 1] },
  limit: { on: "bool", forecast: "bool", horizonH: [1, 24, 1], pct: [0, 100, 1], resolvedPush: "bool" },
  service: { on: "bool", fails: [0, 1000, 1], failsMin: [5, 180, 5], noSuccess: "bool", rate: [0, 100, 1], rateMin: [5, 180, 5],
    minCalls: [1, 1000, 1], slowMs: [0, 60000, 50], slowMin: [5, 180, 5], resolvedPush: "bool" },
  job: { on: "bool", resolvedPush: "bool" },
};
const ALERT_NAMES = {
  "api:/plan": "Plan a route", "api:/alternatives": "Compare routes", "api:/status": "Live status",
  "api:/fr-status": "Live status France (old)", "api:/be-status": "Belgium: sites", "api:/be-evse": "Belgium: one stall",
  "api:/geocode": "Address search", "api:/detours": "Detour minutes", "api:/places": "Place names", "api:/ndw-sites": "Extra NL chargers",
  "api:/extra-sites": "Extra chargers (BE, FR, PT, DE)", "svc:NDW": "NDW live status (NL)", "svc:Open Charge Map": "Open Charge Map",
  "svc:MobiData BW": "MobiData BW live status (DE)", "svc:E-Control": "E-Control live status (AT)", "svc:Nominatim": "Nominatim (backup search)",
  "api:/where": "Street and town", "svc:Routing": "openrouteservice: routes", "svc:Geocoder": "openrouteservice: addresses",
  "svc:Matrix": "openrouteservice: detours", "job:pt": "Portugal live", "job:fr": "France live", "job:closures": "Road closures", "job:occ": "Occupancy",
  ors: "Route service notice",
};
const LIMIT_TARGETS = [
  { key: "limit:Worker requests", name: "Worker requests", src: "Worker requests", fixed: 100000, cf: true },
  { key: "limit:KV reads", name: "KV reads", src: "KV reads", fixed: 100000, cf: true },
  { key: "limit:KV writes", name: "KV writes", src: "KV writes", fixed: 1000, cf: true },
  { key: "limit:directions", name: "openrouteservice routes", src: "Routing", ors: "directions" },
  { key: "limit:matrix", name: "openrouteservice detours", src: "Matrix", ors: "matrix" },
  { key: "limit:geocode/search", name: "openrouteservice place search", src: "Geocoder", ors: "geocode/search" },
];
const alertKind = (key) => (key.startsWith("limit:") ? "limit" : /^(svc|api):/.test(key) ? "service" : "job");
const alertName = (key) => ALERT_NAMES[key] || LIMIT_TARGETS.find((t) => t.key === key)?.name || key.replace(/^(svc|api|gh|job):/, "");
const validAlertKey = (key) => typeof key === "string" && key.length < 120 && /^(limit:|svc:|api:|job:|gh:|ors$)/.test(key);

function cleanRule(kind, r) {
  const out = {};
  for (const [f, spec] of Object.entries(ALERT_FIELDS[kind] || {})) {
    const v = r?.[f];
    if (v === undefined || v === null || v === "") continue;
    if (spec === "bool") { out[f] = v === true || v === "true" || v === 1; continue; }
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    out[f] = Math.min(spec[1], Math.max(spec[0], Math.round(n / spec[2]) * spec[2]));
  }
  return out;
}
async function loadAlerts(env, fresh = false) {
  let c = fresh ? undefined : memoGet("alerts");
  if (c === undefined) {
    try { c = JSON.parse((await kvGet(env, "alerts")) || "{}"); } catch (_) { c = {}; }
    c.defaults = c.defaults || {}; c.rules = c.rules || {};
    memoSet("alerts", c, 60 * 1000);
  }
  return c;
}
const alertDefaults = (cfg, kind) => ({ ...ALERT_DEFAULTS[kind], ...(cfg.defaults[kind] || {}) });
const alertRule = (cfg, key) => ({ ...alertDefaults(cfg, alertKind(key)), ...(cfg.rules[key] || {}) });
async function loadAlertLog(env) {
  let l;
  try { l = JSON.parse((await kvGet(env, "alerts-log")) || "{}"); } catch (_) { l = {}; }
  l.open = l.open || {}; l.log = l.log || [];
  return l;
}

// Local time in the Netherlands, for texts and quiet hours.
function tzParts(at) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: ALERT_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}
// The moment of local time y-mo-d h:00 (offset taken from that day; fine outside the DST switch hour).
function tzAt(y, mo, d, h) {
  const guess = Date.UTC(y, mo - 1, d, h);
  const p = tzParts(guess);
  return guess - (Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - guess);
}
function localWhen(at, now) {
  const a = tzParts(at), n = tzParts(now), two = (x) => String(x).padStart(2, "0");
  const time = `${two(a.h)}:${two(a.mi)}`;
  return a.y === n.y && a.mo === n.mo && a.d === n.d ? `at ${time}` : `on ${two(a.d)}-${two(a.mo)} at ${time}`;
}
const fmtN = (n) => Math.round(n).toLocaleString("en-GB");
function fmtDur(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
}
function isQuiet(g, now) {
  if (!g.quietOn || g.quietFrom === g.quietTo) return false;
  const h = tzParts(now).h;
  return g.quietFrom > g.quietTo ? h >= g.quietFrom || h < g.quietTo : h >= g.quietFrom && h < g.quietTo;
}

// Today's counts and the last 3 hours of slots: saved record(s) plus this copy's unsaved tally.
async function alertData(env, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  const rec = (await readUsageDay(env, day)) || {};
  const slots = mergeSlots({}, rec.slots);
  if (new Date(now).getUTCHours() < 3) {
    const y = await readUsageDay(env, new Date(now - 86400000).toISOString().slice(0, 10));
    if (y) mergeSlots(slots, y.slots);
  }
  mergeSlots(slots, usage.slots);
  const calls = { ...(rec.calls || {}) };
  for (const [k, n] of Object.entries(usage.pending)) calls[k] = (calls[k] || 0) + n;
  const ors = { ...(rec.ors || {}) };
  for (const [k, v] of Object.entries(usage.ors)) if (!ors[k] || ors[k].at < v.at) ors[k] = v;
  return { calls, ors, slots };
}
// Sum of a service's slots over the last `mins` minutes (whole slots plus the current one).
function slotWindow(slots, key, mins, now) {
  const cur = Math.floor(now / SLOT_MS), from = cur - Math.ceil(mins / 5);
  const a = { n: 0, fail: 0, ms: 0 };
  for (let k = from; k <= cur; k++) { const x = slots[k]?.q?.[key]; if (x) { a.n += x[0]; a.fail += x[1]; a.ms += x[2] || 0; } }
  return a;
}
function evalService(key, rule, slots, now) {
  const reasons = [];
  if (rule.fails > 0) {
    const a = slotWindow(slots, key, rule.failsMin, now);
    if (a.fail >= rule.fails && (!rule.noSuccess || a.fail === a.n)) reasons.push(`${fmtN(a.fail)} of ${fmtN(a.n)} failed in ${rule.failsMin} min`);
  }
  if (rule.rate > 0) {
    const a = slotWindow(slots, key, rule.rateMin, now);
    const ok = a.n ? ((a.n - a.fail) / a.n) * 100 : 100;
    if (a.n >= rule.minCalls && ok < rule.rate) reasons.push(`${Math.round(ok)}% worked in ${rule.rateMin} min (${fmtN(a.n)} calls, threshold ${rule.rate}%)`);
  }
  if (rule.slowMs > 0) {
    const a = slotWindow(slots, key, rule.slowMin, now);
    if (a.n >= 3 && a.ms / a.n > rule.slowMs) reasons.push(`average ${fmtN(a.ms / a.n)} ms in ${rule.slowMin} min (threshold ${fmtN(rule.slowMs)} ms)`);
  }
  const w = slotWindow(slots, key, 15, now);
  const name = alertName(key);
  return { key, kind: "service", name, failing: reasons.length > 0, level: 1,
    title: `${name}: failing`, body: reasons.join("; "),
    detail: w.n ? `last 15 min: ${fmtN(w.n)} calls, ${fmtN(w.fail)} failed${w.n ? `, average ${fmtN(w.ms / w.n)} ms` : ""}` : "no calls in the last 15 min" };
}
function evalLimit(t, rule, data, now) {
  let used, limit, resetAt;
  const nextUtcMidnight = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1);
  if (t.cf) { used = data.calls[t.src] || 0; limit = t.fixed; resetAt = nextUtcMidnight; }
  else {
    const q = data.ors[t.ors];
    if (!q || q.limit == null || q.remaining == null) return null;
    used = q.limit - q.remaining; limit = q.limit;
    const r = q.reset ? (q.reset > 1e12 ? q.reset : q.reset * 1000) : 0;
    resetAt = r > now ? r : nextUtcMidnight;
  }
  // Rate: the last hour of slots (needs at least half an hour of slots and 5 calls, else no forecast).
  const cur = Math.floor(now / SLOT_MS);
  const have = Object.keys(data.slots).map(Number).filter((k) => k >= cur - 12);
  let n = 0;
  for (let k = cur - 12; k <= cur; k++) n += data.slots[k]?.c?.[t.src] || 0;
  const mins = 60 + (now - cur * SLOT_MS) / 60000;
  const rate = have.length >= 6 && n >= 5 ? n / mins : null; // per minute
  const pct = limit ? (used / limit) * 100 : 0;
  const reset = `at ${localWhen(resetAt, now).replace(/^.* at /, "")}`; // always the next reset, so the time is enough
  const perHour = rate != null ? `, about ${fmtN(rate * 60)} an hour` : "";
  let crossAt = null;
  if (rate && used < limit) {
    const at = now + ((limit - used) / rate) * 60000;
    if (at < resetAt) crossAt = at;
  }
  const base = { key: t.key, kind: "limit", name: t.name, failing: false, level: 0,
    detail: `${fmtN(used)} of ${fmtN(limit)} used (${Math.round(pct)}%)${perHour}${crossAt ? `; at this rate over the limit ${localWhen(crossAt, now)}` : rate != null ? "; stays under the limit at this rate" : "; too little traffic for a forecast"}` };
  const body = `${fmtN(used)} of ${fmtN(limit)} used today${perHour}. Resets ${reset}.`;
  if (used >= limit) return { ...base, failing: true, level: 3, title: `${t.name} is over the daily limit`, body: `${fmtN(used)} of ${fmtN(limit)} used; further calls fail until the reset ${reset}.` };
  if (rule.pct > 0 && pct >= rule.pct) return { ...base, failing: true, level: 2, title: `${t.name} at ${Math.floor(pct)}% of the daily limit`,
    body: `${body}${crossAt ? ` At this rate over the limit ${localWhen(crossAt, now)}.` : ""}` };
  if (rule.forecast && crossAt && crossAt - now <= rule.horizonH * 3600000) {
    return { ...base, failing: true, level: 1, title: `At this rate, ${t.name} will go over the limit ${localWhen(crossAt, now)}`, body };
  }
  return base;
}
// Every target with its current state. all=true also returns targets whose rule is off (for the page).
function evaluateAlerts(env, cfg, data, timerState, health, now, all = false) {
  const out = [];
  const add = (r) => { if (!r) return; r.rule = alertRule(cfg, r.key); r.custom = !!cfg.rules[r.key]; if (all || r.rule.on) out.push(r); };
  for (const t of LIMIT_TARGETS) { if (t.cf && isPaid(env)) continue; add(evalLimit(t, alertRule(cfg, t.key), data, now)); }
  const svcKeys = new Set();
  for (const s of Object.values(data.slots)) for (const k of Object.keys(s.q || {})) svcKeys.add(k);
  for (const k of Object.keys(cfg.rules)) if (alertKind(k) === "service") svcKeys.add(k);
  for (const k of svcKeys) add(evalService(k, alertRule(cfg, k), data.slots, now));
  const job = (key, failing, body, detail, link) => {
    const name = alertName(key);
    add({ key, kind: "job", name, failing, level: 1, title: `${name}: failing`, body, detail, link });
  };
  for (const [k, name] of Object.entries(TIMER_JOBS)) {
    if (k === "fr" && !setting(env, "frLive")) continue;
    if (k === "occ" && !setting(env, "occupancy")) continue;
    const j = timerState[k];
    job(`job:${k}`, j?.ok === false, String(j?.msg || "Unknown error").slice(0, 180), j ? (j.ok ? `OK: ${j.msg || ""}` : `failing: ${j.msg || ""}`) : "no tick yet");
  }
  const down = !!(health?.ors?.down && now - (health.ors.lastFail || 0) < HEALTH_STALE_MS);
  job("ors", down, "openrouteservice fails; drivers see the notice on the start screen.", down ? "notice showing" : "no notice");
  for (const [name, st] of Object.entries(timerState.gh?.seen || {})) {
    job(`gh:${name}`, st === "failure", `GitHub job “${name}” failed. The log is on GitHub Actions.`, `newest finished run: ${st}`, timerState.gh?.link?.[name]);
  }
  return out;
}

const pushTag = (key) => `a-${key}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
function incEvent(inc, t, text, at) {
  inc.events = [...(inc.events || []), { at, t, text: String(text || "").slice(0, 240) }].slice(-14);
}
function closeIncident(log, inc, at, how) {
  delete log.open[inc.key];
  inc.resolvedAt = at;
  incEvent(inc, "resolve", how, at);
  log.log.unshift(inc);
}
function pruneAlertLog(log, now) {
  log.log = log.log.filter((x) => now - (x.resolvedAt || x.opened) < 30 * 86400000).slice(0, 150);
}
// The timer's part: open, push, remind and resolve incidents. Returns the push messages.
async function runAlerts(env, now, timerState, budget = 5) {
  const cfg = await loadAlerts(env);
  const g = alertDefaults(cfg, "general");
  const data = await alertData(env, now);
  const results = evaluateAlerts(env, cfg, data, timerState, await loadHealth(env), now);
  const log = await loadAlertLog(env);
  const first = !log.started;
  const quiet = isQuiet(g, now);
  const ackRead = Object.fromEntries(Object.values(log.open).map((x) => [x.id, x.ackAt || null])); // to spot a change made meanwhile
  const msgs = [];
  let changed = first;
  const failing = new Map(results.filter((r) => r.failing).map((r) => [r.key, r]));
  for (const r of failing.values()) {
    let inc = log.open[r.key], fresh = false;
    if (!inc) {
      const i = g.reopenMin ? log.log.findIndex((x) => x.key === r.key && now - x.resolvedAt < g.reopenMin * 60000) : -1;
      if (i >= 0) {
        inc = log.log.splice(i, 1)[0];
        Object.assign(inc, { resolvedAt: null, okTicks: 0, ackAt: null, ackUntil: null, pushes: 0, pushedLevel: 0 });
        incEvent(inc, "reopen", r.title, now);
      } else {
        inc = { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, key: r.key, kind: r.kind, opened: now, pushes: 0, lastPush: 0, okTicks: 0, events: [] };
        incEvent(inc, "open", `${r.title}${r.body ? ` · ${r.body}` : ""}`, now);
      }
      fresh = true;
      // Old failures found at the first run (GitHub jobs that failed before this existed): quiet.
      if (first && r.key.startsWith("gh:")) { inc.ackAt = now; inc.ackUntil = "resolved"; incEvent(inc, "ack", "Found at the start; no push", now); }
      log.open[r.key] = inc; changed = true;
    }
    if (inc.okTicks) { inc.okTicks = 0; changed = true; }
    Object.assign(inc, { name: r.name, title: r.title, body: r.body, link: r.link || inc.link || null });
    if ((r.level || 0) > (inc.worst || 0)) { inc.worst = r.level; inc.worstText = r.title; }
    const acked = !!inc.ackAt && (inc.ackUntil === "resolved" || inc.ackUntil > now);
    const held = quiet && r.kind === "limit" && r.level < 3; // quiet hours: only outages and over-limit
    let push = null;
    if (!held) {
      if (!inc.pushes && !acked) push = fresh && inc.events.some((e) => e.t === "reopen") ? "reopen" : "open";
      else if (inc.pushes && r.level > (inc.pushedLevel || 0) && (!acked || r.level === 3)) push = "worse";
      else if (!acked && inc.ackAt && inc.ackUntil !== "resolved") push = "still"; // quiet period over
      else if (!acked && inc.pushes && g.remindMin > 0 && now - inc.lastPush >= g.remindMin * 60000) push = "remind";
    }
    if (push && msgs.length >= budget) push = null; // at most 5 a tick; the rest follows next tick
    if (push) {
      const since = localWhen(inc.opened, now).replace(/^at /, "");
      const msg = push === "open" || push === "worse" ? { title: r.title, body: r.body }
        : push === "reopen" ? { title: `${r.name}: failing again`, body: r.body }
        : { title: r.kind === "limit" ? r.title : `${r.name}: still failing`, body: `Since ${since}. ${r.body}` };
      msgs.push({ ...msg, tag: pushTag(r.key), url: `admin.html#incident=${inc.id}` });
      if (push === "still") { inc.ackAt = null; inc.ackUntil = null; }
      inc.pushes = (inc.pushes || 0) + 1; inc.lastPush = now; inc.pushedLevel = Math.max(inc.pushedLevel || 0, r.level || 0);
      incEvent(inc, push === "open" || push === "reopen" ? "push" : push, push === "open" ? "Notification sent" : msg.title, now);
      changed = true;
    }
  }
  // Fine again (or no longer watched): resolve after enough good checks.
  for (const inc of Object.values(log.open)) {
    if (failing.has(inc.key)) continue;
    const rule = alertRule(cfg, inc.key);
    const watched = rule.on && results.some((r) => r.key === inc.key);
    inc.okTicks = (inc.okTicks || 0) + 1; changed = true;
    const need = inc.kind === "job" ? 1 : g.resolveChecks;
    if (watched && inc.okTicks < need) continue;
    closeIncident(log, inc, now, watched ? `OK again after ${fmtDur(now - inc.opened)}` : "No longer watched (rule off or gone)");
    if (watched && rule.resolvedPush && inc.pushes && msgs.length < budget) {
      msgs.push({ title: `${inc.name || alertName(inc.key)}: OK again`, body: `Resolved after ${fmtDur(now - inc.opened)}.`, tag: pushTag(inc.key), url: `admin.html#incident=${inc.id}` });
    }
  }
  if (first) log.started = now;
  if (changed) {
    pruneAlertLog(log, now);
    // An acknowledgement or a manual close on the usage page meanwhile wins over this tick's copy.
    const kv = await loadAlertLog(env);
    for (const [k, inc] of Object.entries(log.open)) {
      const f = kv.open[k];
      if (f && f.id === inc.id && (f.ackAt || null) !== (ackRead[inc.id] ?? null)) {
        inc.ackAt = f.ackAt; inc.ackUntil = f.ackUntil;
        const mine = new Set(inc.events.map((e) => `${e.at}${e.t}`));
        inc.events = [...inc.events, ...f.events.filter((e) => !mine.has(`${e.at}${e.t}`))].sort((a, b) => a.at - b.at).slice(-14);
      }
      const closed = !f && kv.log.find((x) => x.id === inc.id && x.resolvedAt >= now);
      if (closed) { delete log.open[k]; log.log.unshift(closed); }
    }
    await saveAlertLog(env, log);
  }
  return msgs;
}
async function saveAlertLog(env, log) {
  try { await env.USAGE.put("alerts-log", JSON.stringify(log)); countCall("KV writes"); } catch (e) { console.log("Alerts save failed", e.message); }
}
// The usage page: GET rules, targets with their current state, open incidents and the log; POST changes.
async function handleAlerts(request, env) {
  checkAdmin(request, env);
  const now = Date.now();
  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (body.action === "save-defaults" || body.action === "save-rule") {
      const cfg = await loadAlerts(env, true);
      if (body.action === "save-defaults") {
        if (!ALERT_FIELDS[body.kind]) throw new HttpError(400, "Unknown kind");
        cfg.defaults[body.kind] = body.values ? cleanRule(body.kind, body.values) : {};
      } else {
        if (!validAlertKey(body.key)) throw new HttpError(400, "Unknown target");
        if (body.rule) cfg.rules[body.key] = cleanRule(alertKind(body.key), body.rule);
        else delete cfg.rules[body.key];
      }
      await env.USAGE.put("alerts", JSON.stringify(cfg)); countCall("KV writes");
      memoSet("alerts", cfg, 60 * 1000);
    } else if (["ack", "unack", "resolve"].includes(body.action)) {
      const log = await loadAlertLog(env);
      const inc = Object.values(log.open).find((x) => x.id === body.id);
      if (!inc) throw new HttpError(404, "That incident is already resolved");
      if (body.action === "ack") {
        let until, text;
        if (body.until === "resolved") { until = "resolved"; text = "until resolved"; }
        else if (body.until === "tomorrow") {
          const g = alertDefaults(await loadAlerts(env), "general");
          const p = tzParts(now + 86400000);
          until = tzAt(p.y, p.mo, p.d, g.quietTo || 7); text = `until ${localWhen(until, now).replace(/^(at|on) /, "")}`;
        } else {
          const m = Math.min(7 * 1440, Math.max(5, Number(body.until) || 30));
          until = now + m * 60000; text = `for ${fmtDur(m * 60000)}`;
        }
        Object.assign(inc, { ackAt: now, ackUntil: until });
        incEvent(inc, "ack", `Acknowledged; no pushes ${text}`, now);
      } else if (body.action === "unack") {
        Object.assign(inc, { ackAt: null, ackUntil: null });
        incEvent(inc, "unack", "Acknowledgement taken back", now);
      } else closeIncident(log, inc, now, "Closed by you");
      await saveAlertLog(env, log);
    } else if (body.action === "clear-log") {
      const log = await loadAlertLog(env);
      log.log = [];
      await saveAlertLog(env, log);
    } else throw new HttpError(400, "Unknown action");
  }
  const cfg = await loadAlerts(env);
  const data = await alertData(env, now);
  const targets = evaluateAlerts(env, cfg, data, await loadTimer(env), await loadHealth(env), now, true)
    .map(({ key, kind, name, failing, level, title, body, detail, rule, custom, link }) => ({ key, kind, name, failing, level, title, body, detail, rule, custom, link }));
  const log = await loadAlertLog(env);
  const g = alertDefaults(cfg, "general");
  return json(request, {
    defaults: Object.fromEntries(Object.keys(ALERT_DEFAULTS).map((k) => [k, alertDefaults(cfg, k)])),
    builtIn: ALERT_DEFAULTS, savedDefaults: cfg.defaults, rules: cfg.rules, fields: ALERT_FIELDS, targets,
    open: Object.values(log.open).sort((a, b) => b.opened - a.opened), log: log.log.slice(0, 100),
    quiet: isQuiet(g, now), now,
  });
}

// ---------------------------------------------------------------- push notifications (usage page)
// Standard Web Push (RFC 8030/8291/8292) to the usage page added to the home screen as its own app
// (admin.html + admin-sw.js + admin.webmanifest). Only the admin gets these; the driving app has none.
//   KV "push-vapid": the VAPID key pair, made by the Worker the first time the usage page asks for it
//     ({pub: base64url raw public key, jwk: private key}); never in Git.
//   KV "push-subs": the subscriptions [{endpoint, p256dh, auth, label, added}], written only on
//     subscribe, unsubscribe, or when the push service answers 404/410 (subscription gone).
//   GET /admin/push: the public key and the subscriptions; POST {action: "subscribe", sub, label} |
//     {action: "unsubscribe", endpoint} | {action: "test", endpoint?}.
// Sent from the timer (runTimer): a timer job turning failing or OK again, the route service going
// down or back, and a GitHub workflow whose newest finished run failed (or works again).
// The message is encrypted for the phone (aes128gcm); the push service only sees ciphertext.
const PUSH_TTL_S = 6 * 3600;
const PUSH_SUB = "https://remconld.github.io/apps/admin.html"; // VAPID contact (Apple wants mailto: or https:)
const te = new TextEncoder();
const b64urlBytes = (s) => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4)), (c) => c.charCodeAt(0));
const b64urlAny = (bytes) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}
async function pushVapid(env, make = false) {
  let v = memoGet("push-vapid");
  if (v === undefined) {
    try { v = JSON.parse((await kvGet(env, "push-vapid")) || "null"); } catch (_) { v = null; }
    memoSet("push-vapid", v, 10 * 60 * 1000);
  }
  if (!v && make) {
    // Read KV itself again first: another Worker copy may have made the key meanwhile, and a second
    // key would break every subscription made with the first.
    try { v = JSON.parse((await kvGet(env, "push-vapid")) || "null"); } catch (_) { v = null; }
  }
  if (!v && make) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    v = { pub: b64urlAny(pub), jwk: await crypto.subtle.exportKey("jwk", kp.privateKey), made: new Date().toISOString() };
    await env.USAGE.put("push-vapid", JSON.stringify(v)); countCall("KV writes");
    memoSet("push-vapid", v, 10 * 60 * 1000);
  }
  return v;
}
async function pushSubs(env) {
  try { return JSON.parse((await kvGet(env, "push-subs")) || "[]"); } catch (_) { return []; }
}
async function savePushSubs(env, subs) {
  await env.USAGE.put("push-subs", JSON.stringify(subs)); countCall("KV writes");
}
async function vapidHeader(v, endpoint) {
  const key = await crypto.subtle.importKey("jwk", v.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64urlText(JSON.stringify({ typ: "JWT", alg: "ES256" }))}.${b64urlText(JSON.stringify({ aud: new URL(endpoint).origin, exp: now + 12 * 3600, sub: PUSH_SUB }))}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(data))); // raw r||s, as JWS wants
  return `vapid t=${data}.${b64urlAny(sig)}, k=${v.pub}`;
}
// RFC 8291: one aes128gcm record for the subscription's keys.
async function encryptPush(sub, payload) {
  const uaPub = b64urlBytes(sub.p256dh), authSecret = b64urlBytes(sub.auth);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, cat(te.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, cat(te.encode(payload), new Uint8Array([2]))));
  return cat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPub.length]), asPub, ct); // rs = 4096
}
// One message to one subscription: {ok, status, gone}.
async function sendPush(env, v, sub, msg) {
  countCall("Push");
  try {
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: { Authorization: await vapidHeader(v, sub.endpoint), TTL: String(PUSH_TTL_S), Urgency: "high",
        "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
        ...(msg.tag ? { Topic: String(msg.tag).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) } : {}) },
      body: await encryptPush(sub, JSON.stringify(msg)),
    });
    const text = res.ok ? "" : (await res.text().catch(() => "")).slice(0, 200);
    return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410, text };
  } catch (e) {
    return { ok: false, status: 0, gone: false, text: e.message };
  }
}
// To every subscription (or one endpoint); drops the ones the push service says are gone.
// msg: {title, body, url?, tag?}. Returns [{label, ok, status, text}].
async function notifyAdmin(env, msg, onlyEndpoint) {
  const v = await pushVapid(env);
  if (!v) return [];
  const subs = await pushSubs(env);
  const targets = subs.filter((s) => !onlyEndpoint || s.endpoint === onlyEndpoint);
  if (!targets.length) return [];
  const full = { url: "admin.html#timer", ...msg, at: new Date().toISOString() };
  const results = await Promise.all(targets.map((s) => sendPush(env, v, s, full)));
  const gone = new Set(targets.filter((_, i) => results[i].gone).map((s) => s.endpoint));
  if (gone.size) await savePushSubs(env, subs.filter((s) => !gone.has(s.endpoint)));
  results.forEach((r, i) => { if (!r.ok) console.log("Push", targets[i].label, r.status, r.text); });
  return results.map((r, i) => ({ label: targets[i].label, ok: r.ok, status: r.status, gone: r.gone, text: r.text }));
}
async function handlePush(request, env) {
  checkAdmin(request, env);
  const pubSubs = (subs) => subs.map((s) => ({ endpoint: s.endpoint, label: s.label, added: s.added, host: new URL(s.endpoint).host }));
  if (request.method === "GET") {
    const v = await pushVapid(env, true);
    return json(request, { publicKey: v.pub, subs: pubSubs(await pushSubs(env)) });
  }
  const body = await request.json().catch(() => ({}));
  if (body.action === "subscribe") {
    const s = body.sub || {};
    const keys = s.keys || {};
    let host = "";
    try { host = new URL(s.endpoint).protocol === "https:" ? new URL(s.endpoint).host : ""; } catch (_) {}
    if (!host || !keys.p256dh || !keys.auth) throw new HttpError(400, "That isn’t a push subscription");
    const subs = (await pushSubs(env)).filter((x) => x.endpoint !== s.endpoint);
    subs.push({ endpoint: s.endpoint, p256dh: keys.p256dh, auth: keys.auth, label: String(body.label || "Device").slice(0, 60), added: new Date().toISOString() });
    await savePushSubs(env, subs.slice(-10));
    return json(request, { ok: true, subs: pubSubs(subs.slice(-10)) });
  }
  if (body.action === "unsubscribe") {
    const subs = await pushSubs(env);
    const left = subs.filter((x) => x.endpoint !== body.endpoint);
    if (left.length !== subs.length) await savePushSubs(env, left);
    return json(request, { ok: true, subs: pubSubs(left) });
  }
  if (body.action === "test") {
    const results = await notifyAdmin(env, { title: "EVailability", body: "Test notification: push works on this device.", tag: "test" }, body.endpoint || null);
    return json(request, { ok: results.length > 0 && results.every((r) => r.ok), results, subs: pubSubs(await pushSubs(env)) });
  }
  throw new HttpError(400, "Unknown action");
}
// GitHub workflows: the newest finished run per workflow (one API call), kept in state.gh =
// {seen: {<workflow name>: "failure"|"success"}, link: {<name>: run URL}}; the alerts turn a failure into
// an incident (gh:<name>) and its success into a resolve. True when something changed.
async function checkWorkflowRuns(env, state) {
  const token = await installToken(env);
  const r = await ghCall(`/repos/${GH_REPO}/actions/runs?status=completed&per_page=40`, token);
  if (!r.ok) throw new Error(`GitHub ${r.status} listing runs`);
  const newest = {};
  for (const run of r.data.workflow_runs || []) {
    if (!["success", "failure", "timed_out", "startup_failure"].includes(run.conclusion)) continue;
    if (!newest[run.name]) newest[run.name] = run; // runs come newest first
  }
  const gh = (state.gh = state.gh || { seen: {} });
  gh.link = gh.link || {};
  let changed = false;
  for (const [name, run] of Object.entries(newest)) {
    const now = run.conclusion === "success" ? "success" : "failure";
    if (gh.seen[name] === now) continue;
    gh.seen[name] = now; gh.link[name] = run.html_url; changed = true;
  }
  return changed;
}

export default {
  // Cron Trigger (wrangler.toml): starts the GitHub jobs, see "timer" above.
  async scheduled(event, env, ctx) {
    ENV_NOW = env;
    ctx.waitUntil(runTimer(env, event.scheduledTime).catch((e) => console.log("Timer", e.message)));
  },
  async fetch(request, env, ctx) {
    ENV_NOW = env; // the same for every request of this Worker copy
    if (request.method !== "OPTIONS") countCall("Worker requests");
    // Save the tally after answering: straight away after planning (rare, many calls),
    // otherwise at most every 2 minutes. A new deploy discards anything not yet saved.
    const path0 = new URL(request.url).pathname;
    const urgent = /^\/(plan|alternatives)/.test(path0);
    // Time per endpoint that matters for the driver (QoS): from the request to the answer.
    const timed = /^\/(plan|alternatives|status|fr-status|be-status|be-evse|geocode|detours|places|ndw-sites|extra-sites|where)$/.test(path0) && request.method !== "OPTIONS";
    const t0 = Date.now();
    try {
      const res = await route(request, env);
      if (timed) noteQos(`api:${path0}`, Date.now() - t0, res.status < 500, res.status);
      return res;
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (timed) noteQos(`api:${path0}`, Date.now() - t0, status < 500 && status !== 429 ? true : false, status);
      console.log("Error", status, e.message);
      return json(request, e.reason ? { error: e.message, reason: e.reason, ...(e.extra || {}) } : { error: e.message }, status);
    } finally {
      // A failure is saved after a minute instead of two, so the alerts see it sooner.
      const failFlush = usage.failed && Date.now() - usage.lastFlush > 60 * 1000;
      ctx?.waitUntil?.(flushUsage(env, urgent || failFlush).catch(() => {}));
    }
  },
};
