# Ionity route: handover

A web app for the phone that shows the fast chargers along a driving route, with how many are free right now and how many minutes of detour each one costs. You plan a route once; while you drive, the list follows your GPS: destination at the top, you at the bottom, chargers in between in the order you reach them.

- **App:** https://remconld.github.io/apps/ionity-route.html
- **Usage page:** https://remconld.github.io/apps/admin.html
- **Server (proxy):** https://ionity.remco-dv.workers.dev
- **Code:** GitHub repo `RemcoNLD/apps` (branch `main`)

No passwords, keys or tokens are in this document or in the repo. Where they're needed, this document names the secret and says where to set it.

---

## 1. Architecture

```
iPhone (Safari / home-screen app)
   │  ionity-route.html — one static file on GitHub Pages
   │  sends X-Access header (access token) on every call
   ▼
Cloudflare Worker "ionity"  (src/ionity-route-worker.js)
   │  holds all API keys, caches, combines sources, counts usage
   ├── OpenRouteService (HeiGIT): routing, travel-time matrix, geocoding (Pelias)
   ├── Open Charge Map: charger locations per operator
   ├── NDW (NL): live availability
   ├── MobiData BW OCPDB (DE): live availability (AFIR data)
   ├── E-Control Ladestellenverzeichnis (AT): live availability
   └── brand websites: site icons (logos)
   │
   └── Cloudflare KV "ionity-usage" (binding USAGE): usage counts, caches, status history
```

Why a Worker: the browser can't hold API keys safely, several sources don't allow calls from a browser (CORS), and the Worker can cache and trim large answers so the phone gets small ones.

### Repo layout

| Path | What |
|---|---|
| `ionity-route.html` | The whole app: HTML, CSS and JavaScript in one file. No build step, no libraries. |
| `src/ionity-route-worker.js` | The Cloudflare Worker (one ES module, no dependencies). |
| `wrangler.toml` | Worker name, entry file, KV binding. |
| `.github/workflows/deploy-worker.yml` | Deploys the Worker on every push that changes the Worker or `wrangler.toml`. |
| `admin.html` | Usage page (calls per source per day against the free-tier limits). |
| `index.html` | The apps page that links to the apps. |
| `docs/ionity-route-handover.md` | This document. |

---

## 2. External services and accounts

All are free tiers. Limits are as known at the time of writing; check the providers' sites.

| Service | Used for | Account / key | Limits that matter |
|---|---|---|---|
| **GitHub Pages** | Hosts the app and admin page | GitHub account RemcoNLD, repo `apps`, Pages from `main` / root | none in practice |
| **GitHub Actions** | Deploys the Worker | Repo secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | none in practice |
| **Cloudflare Workers** (free plan) | The proxy | Cloudflare account, subdomain `remco-dv.workers.dev` | 100,000 requests/day; ~10 ms CPU per request; 128 MB memory; 50 outgoing requests per request |
| **Cloudflare KV** | Namespace `ionity-usage` (binding `USAGE`) | same account | 100,000 reads/day, **1,000 writes/day** |
| **OpenRouteService** (HeiGIT), https://openrouteservice.org | Directions, matrix (detours), geocoding (Pelias) | key in Worker secret `ORS_API_KEY` | Directions 2,000/day, Matrix **500/day**, Geocode 1,000/day; rate limits per minute |
| **Open Charge Map**, https://openchargemap.org | Where the chargers are, per operator | key in Worker secret `OCM_API_KEY` | Fair use; blocks bursts (HTTP 429) |
| **NDW** (Nationaal Dataportaal Wegverkeer) | Live status NL | none (open data) | ~10 requests/s |
| **MobiData BW OCPDB** | Live status DE (all of Germany, AFIR data) | none (open data) | fair use |
| **E-Control** Ladestellenverzeichnis | Live status AT | key in Worker secret `ECONTROL_API_KEY`; requests also send `Referer: https://remconld.github.io/` | modest; the Worker asks for at most 4 sites per call |

Not (yet) live: Belgium (waiting for an Eco-Movement data token) and France. Chargers there are shown with location and detour, without free counts.

---

## 3. Setting it up from scratch

1. **Repo and Pages.** Put `ionity-route.html`, `admin.html` and `index.html` in a GitHub repo. Settings → Pages → Deploy from a branch → `main`, folder `/`. The app's address is then `https://<user>.github.io/<repo>/ionity-route.html`.
2. **Cloudflare.** Create a free account. Note the account ID (dashboard sidebar). Workers → choose a `workers.dev` subdomain.
3. **KV namespace.** Storage & Databases → KV → create `ionity-usage`. Put its ID in `wrangler.toml` under `[[kv_namespaces]]` with `binding = "USAGE"`.
4. **API keys.** Get keys from OpenRouteService (sign up, create a token), Open Charge Map (My profile → API keys) and E-Control (register for the Ladestellenverzeichnis API).
5. **Worker secrets.** In Cloudflare: Workers → `ionity` → Settings → Variables and Secrets, add as *Secret*:
   - `ORS_API_KEY`, `OCM_API_KEY`, `ECONTROL_API_KEY`
   - `ADMIN_TOKEN`: the password for the usage page (choose one)
   - optional `ACCESS_SECRET`: signs the app's access tokens (see section 6). Without it, `OCM_API_KEY` is used for this.
   - optional `OCM_IONITY_OPERATOR_ID`: only to force Ionity's Open Charge Map operator ID.

   `keep_vars = true` in `wrangler.toml` makes sure a deploy doesn't remove these.
6. **Deploy pipeline.** Create a Cloudflare API token with the template *Edit Cloudflare Workers* (plus KV edit), then add repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in GitHub (Settings → Secrets and variables → Actions). Every push that changes `src/ionity-route-worker.js` or `wrangler.toml` deploys through `cloudflare/wrangler-action@v3`. It can also be started by hand (Actions → Deploy Ionity Worker → Run workflow).
7. **Point the app at the Worker.** In `ionity-route.html`, `const WORKER = "https://ionity.<subdomain>.workers.dev"`. In the Worker, add the app's origin to `ALLOWED_ORIGINS` and set `ECONTROL_REFERER`.
8. **Check.** Open `https://ionity.<subdomain>.workers.dev/`: it should answer `ok: true` and show which keys are set. Then open the app and enter an access code (section 6).

To deploy by hand instead: `npx wrangler deploy` in the repo root, after `npx wrangler login`.

---

## 4. The Worker

One file, `src/ionity-route-worker.js`. It's organised in sections, marked `// ---…` in the code.

### Endpoints

All need the access token (header `X-Access`, or `?access=` in a URL), except those marked *public*.

| Endpoint | What it does |
|---|---|
| `GET /` *public* | Health check; shows which keys are set (true/false only). |
| `POST /unlock` *public* | `{code}` → `{token}` if the code passes the check (section 6). |
| `GET /geocode?q=` | Place search (Pelias), for the address fields. |
| `POST /alternatives` | `{from, to}` → up to 3 route options (see below), each with main roads, cities on the way and the number of Ionity sites. |
| `POST /plan` | `{from, to, via?, brands?, corridorKm?}` → route (coordinates, km and minutes per point, roads, via positions) plus the chargers of those brands within 5 km. `via`: one point or a list of up to 3. Detours are included only if cached; status only for the first 8 chargers. |
| `POST /status` | `{stations:[{id, lat, lon, country, brand}]}` → live status per charger. |
| `POST /detours` | `{items:[{id, lat, lon, a, b}]}` (max 20) → `detours`: extra minutes per charger; `reach`: `{toMin, toKm}`, the drive from `a` to the charger. `a`/`b` are route points 3 km before and after it. |
| `GET /brands` *public* | The brands (key, name, colour). |
| `GET /logo/<brand>` *public* | The brand's site icon (image). |
| `GET /admin/usage` *public, own password* | Usage per day for the admin page (`Authorization: Bearer <ADMIN_TOKEN>`). |
| `GET /debug/…` | Diagnostics: `brands`, `ndw`, `de`, `at`, `detour`, `ocm-ionity`, `ocm-operator`. In a browser use `?access=<ADMIN_TOKEN>`. |

### Route planning

- **Routing:** OpenRouteService `directions/driving-car` with `extra_info: countryinfo` and instructions. Each point may snap to a road up to 5 km away (`radiuses`), so a start in a car park still works.
- **Roads:** road numbers (A, E, B, N, S, M…) come from the instruction step names. The badges in the app are styled per country like real road signs.
- **Route options:** OpenRouteService gives no alternative routes over 100 km. So `/alternatives` makes them itself: it plans via points about 40 km left and right of the fastest route at 1/3 and 2/3 of the way, drops options more than 25% slower or with the same main roads as another option, and names each by its main roads and the large cities it passes (`MAJOR_CITIES`). The chosen option is planned again with its via point.

### Chargers along the route

- **Brands:** `BRANDS` lists the 11 brands. Per brand: a pattern to find its operators in Open Charge Map (`ocm`), one to recognise it in the live sources (`live`), one for EVSE IDs (`evse`, e.g. `NL*FLA*…`; TotalEnergies: `xx*TCB`, `xx*TOT`, `FR*HPC`), its colour and its website (for the logo).
- **Operator IDs:** read once a day from Open Charge Map's reference data (`/v3/referencedata`). The trimmed list of operators and countries is kept 7 days in KV (`ocm-ref-v2`).
- **Finding chargers:** the route is cut into pieces of about 150–250 km. Per piece, one Open Charge Map call fetches the box around it for all chosen operators (`operatorid=1,2,3`, `compact=true`). The box is rounded to 0.05° so nearby lookups reuse it. Calls are spaced out and retried on 429.
- **Fast only:** for brands other than Ionity, only sites with a charger of 50 kW or more (`FAST_KW`).
- **Trimming:** each answer is cut down to the few fields used (id, operator, number of points, title, address, coordinates, country, power). It is cached for an hour in memory and a day in KV (`ocm2:…`). This keeps the Worker within the free plan's CPU and memory limits on long routes with many brands.
- **Along the route:** each site is projected onto the route: distance along it (km and minutes) and distance off it. Sites more than 5 km off are dropped.

### Detours

- Via the OpenRouteService **matrix**: for each charger S, the times A→S, S→B and A→B, where A and B are route points 3 km before and after it. Detour = A→S + S→B − A→B, in minutes. 20 chargers fit in one matrix call.
- The same matrix call also gives the drive A→S in km (`metrics: duration, distance`). The app uses it to show the real distance and time to a charger beyond an exit (see 5, Behaviour).
- Cached 6 hours per charger and driving direction (`det2:<id>:<bearing>`), in memory.
- Planning doesn't compute detours. The app asks `/detours` for the chargers it shows (and, with "Easy to reach" on, the next 60). This keeps the matrix quota (500/day) low.

### Live status

Looked up per charger, cached 60 seconds.

- **NL (NDW):** GeoJSON features in a small box around the charger, filtered on the brand (operator names, `cpo_id`, EVSE ID). Counts DC chargers only. A site whose data hasn't changed for 3 hours while full counts as *probably offline*.
- **DE (MobiData BW OCPDB):** OCPI locations around the charger, filtered on the brand. Per EVSE status, deduplicated; only chargers of 50 kW or more. Sites on the other side of the motorway (e.g. "West" and "Ost") are kept apart.
- **AT (E-Control):** search around the charger, filtered on the brand; same counting. At most 4 Austrian lookups per call.
- **Result per charger:** `available`, `total`, `state` (`free`, `full`, `likely_offline`), `maxKw`, `source`, `checkedAt`, plus history fields:
  - `changedAt`: last change according to the source (NDW: per site; DE: latest per-charger change).
  - `fullSince`: when full, since when (DE: when the last free charger was taken; NL: the site's last change).
  - `seenSince`, `lastFullAt`: what the Worker itself has seen. It keeps one small record per charger in KV (`hist:<id>`, 2 days), written only when the state changes.

### Logos

`/logo/<brand>` reads the brand's home page, picks an icon from its `<link rel="icon">` tags (about 64 px preferred), and falls back to `/favicon.ico` and then Google's favicon service. The image is kept 7 days in KV (`logo:<brand>`), a miss for 1 day. The app shows a coloured letter if there's no icon.

### Usage counting

Every outgoing call is counted per source (`countCall`). The tally is written to KV at most every 2 minutes (straight away after planning), one record per day. `admin.html` shows the last 7 days against the free-tier limits, plus the rate-limit headers OpenRouteService sends.

### KV keys

| Key | Content | Lifetime |
|---|---|---|
| `usage:<date>` | Calls per source that day | 40 days |
| `ocm-ref-v2` | Open Charge Map operators and countries | 7 days |
| `ocm2:<operators>:<box>` | Trimmed chargers in a box | 1 day |
| `logo:<brand>` | Site icon | 7 days (miss: 1 day) |
| `hist:<charger id>` | State seen, since when, last full | 2 days |

Watch the 1,000 writes/day: writes happen for usage (≤ every 2 min while in use), new boxes, logos and state changes.

---

## 5. The app

One file, `ionity-route.html`, with no libraries or build step. The version is in `APP_VERSION`; raise it on every change ("Check for update" in Help compares it with the live file).

### Screens

- **Access code:** asked once per device (section 6).
- **Introduction:** five slides on first use; can be shown again from Help.
- **Start:** To / From (empty means your location), a + for up to 2 via points, the brand picker, and "Simulate the drive". Without vias you get the route options as cards. The chosen card shows "Planning…" until the route is ready.
- **Driving:** destination at the top (tap: compare routes from here), you at the bottom, chargers in route order in between. Chargers of several brands at one spot (within 200 m, same side) share one row.
  - Each row shows the name, distance and time to it, max power, and free/total (green free, orange full, grey when older than 3 minutes or being updated).
  - Left of the row: how to reach it (exit arrow, red round trip) and extra minutes.
  - Road numbers on the line where the road changes.
  - Top bar: New route, brands (show or hide brands on this route; adding one replans), Easy to reach, and Help.
- **Press and hold a charger:** since when it's full or when it was last full, then Apple Maps, Google Maps, Waze, Flitsmeister (on iPhone: copies coordinates; it has no public navigation link there), copy coordinates, share.
- **Help:** manual with a legend of all symbols, version, and check for update.

### Behaviour

- **GPS:** `watchPosition`. Your position is projected onto the route. More than 1 km off it means rerouting from where you are, through the via points still ahead. Via points you've passed are dropped.
- **Status refresh:** every minute for the chargers on screen (at least half visible), in batches of 4, only when the screen is on. Chargers checked within the last minute aren't asked again. Tap a row to update it (at most once a minute; otherwise "Checked N s ago").
- **No blinking:** rows are only redrawn when their content changed (`patchList`, `setHtml`). While updating, a row keeps its numbers and turns grey.
- **Detours:** fetched for the rows on screen. With "Easy to reach" on, also for the next 60 chargers; a charger then only appears once its detour is known.
- **Distance on a row:** for a charger next to the road (within 250 m: a service area) it's where the route passes it. For one further away it's the route up to point A (3 km before the closest point) plus the drive A→charger from `/detours` (`wayTo()`). Before that answer is in, the closest point on the route is used, which makes chargers around one junction all show the same distance.
- **"Easy to reach":** on your side of the road, or a detour of at most 6 minutes, and no round trips.
- **Screen:** kept on while driving with the Screen Wake Lock, asked again whenever iOS releases it, on every tap and every 30 s, plus a tiny silent muted looping video (`NOSLEEP_MP4`, no sound track, so music and CarPlay aren't interrupted) as a fallback for home-screen apps. Help shows which is active. Released on arrival and on New route.
- **Status updating:** while any charger is being looked up, the status bottom right shows a turning ring and a pulsing "Updating".
- **Arrival:** within 150 m of the end of the route (after having been more than 500 m away), a short confetti shower and a "You've arrived" card; no rerouting after that. Stored with the route, so a reload doesn't celebrate again.

### Stored on the device (localStorage)

| Key | Content |
|---|---|
| `ionity-route-access` | Access token |
| `ionity-route-v1` | Current route, chargers, statuses (so a reload continues) |
| `ionity-route-brands` | Brands chosen on the start screen |
| `ionity-route-hidden` | Brands hidden on the current route |
| `ionity-route-myside` | "Easy to reach" on/off |
| `ionity-route-nav` | Navigation app used last |
| `ionity-route-intro-seen` | Introduction shown |

---

## 6. Access code

The app asks for a code once per device. The Worker does the check, so the page source doesn't reveal how it works.

- **Valid code:** 9 digits that pass the *11-proef*, like a Dutch BSN: 9×d1 + 8×d2 + … + 2×d8 − 1×d9 must be divisible by 11. Example: `123456782`. Spaces and dots are ignored.
- **Token:** if the code is right, the Worker returns a token: an HMAC-SHA256 of a fixed text, keyed with `ACCESS_SECRET` (or `OCM_API_KEY` if that isn't set). The app stores it and sends it as `X-Access`. Every endpoint except the public ones requires it; without it the answer is 401 and the app asks for the code again.
- **Signing everyone out:** set or change `ACCESS_SECRET`.
- **Guessing:** limited to 5 tries per 10 minutes per IP address (per Worker copy).
- **Strength:** about 1 in 11 random 9-digit numbers passes. This is a light barrier against casual use, not real security. For more, replace `elfProef` with a list of codes stored as a secret, or with Cloudflare Access.

---

## 7. Testing and debugging

- **Worker:** `node --check src/ionity-route-worker.js`. The Worker can be imported in Node 18+ and called as `worker.fetch(new Request(...), env, ctx)` with a mocked `globalThis.fetch` and a fake KV (`get`/`put`). That's how changes were tested during development.
- **App:** open it in a desktop browser, tick "Simulate the drive" and plan a route; it drives the route at speed. For headless tests, jsdom or Playwright with `fetch` replaced work well. The app's functions are global (`state`, `render()`, `openNavSheet()`…).
- **Diagnostics in a browser:** `https://ionity.remco-dv.workers.dev/debug/brands?access=<ADMIN_TOKEN>` lists the Open Charge Map operators matched per brand. `/debug/ndw`, `/debug/de`, `/debug/at` and `/debug/detour` show raw lookups (see the code for parameters).
- **Logs:** Cloudflare dashboard → Workers → `ionity` → Logs / Observability. Look there for "exceeded CPU" or "exceeded memory" errors.

---

## 8. Known limitations and next steps

- **Belgium:** live status waits for an Eco-Movement token. **France:** no source chosen yet.
- **Open Charge Map** data can be out of date or have a charger slightly off. Live data is matched to it within a few hundred metres.
- **"Since" times** depend on the source. NDW only knows when a site last changed, so "full since" is approximate there. The Worker's own history only covers moments when someone looked.
- **Free plan:** CPU, memory and the 1,000 KV writes/day are the tightest limits. If they become a problem, the Workers Paid plan ($5/month) removes most of them.
- **Flitsmeister** can't be opened with a destination from a web page on iPhone, so it gets the coordinates copied.
- **Access code:** light protection (section 6).
