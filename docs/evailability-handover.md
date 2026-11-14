# EVailability: handover

A web app for the phone that shows the fast chargers along a driving route, with how many are free right now and how many minutes of detour each one costs. You plan a route once; while you drive, the list follows your GPS: destination at the top, you at the bottom, chargers in between in the order you reach them.

- **App:** https://remconld.github.io/apps/evailability.html (the old address `ionity-route.html` forwards here)
- **Usage page:** https://remconld.github.io/apps/admin.html
- **Server (proxy):** https://ionity.remco-dv.workers.dev
- **Code:** GitHub repo `RemcoNLD/apps` (branch `main`)
- **State at the last update:** app `2026-11-14.58`, Worker deployed from commit of the same day. Open items: section 10. France: section 11.

No passwords, keys or tokens are in this document or in the repo. Where they're needed, this document names the secret and says where to set it.

---

## 1. Architecture

```
iPhone (Safari / home-screen app)
   │  evailability.html — one static file on GitHub Pages
   │  sends X-Access header (access token) on every call
   ▼
Cloudflare Worker "ionity"  (src/evailability-worker.js)
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
| `evailability.html` | The whole app: HTML, CSS and JavaScript in one file. No build step, no libraries. |
| `ionity-route.html` | Forwarder from the app's old name (old links and home-screen icons). Carries an `APP_VERSION` so old cached copies reload into it. |
| `src/evailability-worker.js` | The Cloudflare Worker (one ES module, no dependencies). |
| `wrangler.toml` | Worker name, entry file, KV binding. |
| `.github/workflows/deploy-worker.yml` | Deploys the Worker on every push that changes the Worker or `wrangler.toml`. |
| `admin.html` | Usage page (calls per source per day against the free-tier limits). |
| `index.html` | The apps page that links to the apps. |
| `docs/evailability-handover.md` | This document. |
| `data/fr-fast-sites.json` | France: fast sites of the app's brands with their charge-point ids (section 11). |
| `tools/build-fr-index.py` | Builds that file from the national French charger file. |

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

1. **Repo and Pages.** Put `evailability.html`, `admin.html` and `index.html` in a GitHub repo. Settings → Pages → Deploy from a branch → `main`, folder `/`. The app's address is then `https://<user>.github.io/<repo>/evailability.html`.
2. **Cloudflare.** Create a free account. Note the account ID (dashboard sidebar). Workers → choose a `workers.dev` subdomain.
3. **KV namespace.** Storage & Databases → KV → create `ionity-usage`. Put its ID in `wrangler.toml` under `[[kv_namespaces]]` with `binding = "USAGE"`.
4. **API keys.** Get keys from OpenRouteService (sign up, create a token), Open Charge Map (My profile → API keys) and E-Control (register for the Ladestellenverzeichnis API).
5. **Worker secrets.** In Cloudflare: Workers → `ionity` → Settings → Variables and Secrets, add as *Secret*:
   - `ORS_API_KEY`, `OCM_API_KEY`, `ECONTROL_API_KEY`
   - `ADMIN_TOKEN`: the password for the usage page (choose one)
   - optional `ACCESS_SECRET`: signs the app's access tokens (see section 6). Without it, `OCM_API_KEY` is used for this.
   - optional `OCM_IONITY_OPERATOR_ID`: only to force Ionity's Open Charge Map operator ID.

   `keep_vars = true` in `wrangler.toml` makes sure a deploy doesn't remove these.
6. **Deploy pipeline.** Create a Cloudflare API token with the template *Edit Cloudflare Workers* (plus KV edit), then add repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in GitHub (Settings → Secrets and variables → Actions). Every push that changes `wrangler.toml` (and, once the workflow is updated, `src/evailability-worker.js`) deploys through `cloudflare/wrangler-action@v3`. It can also be started by hand (Actions → Deploy Ionity Worker → Run workflow).
7. **Point the app at the Worker.** In `evailability.html` (and `admin.html`), `const WORKER = "https://ionity.<subdomain>.workers.dev"`. In the Worker, add the app's origin to `ALLOWED_ORIGINS` and set `ECONTROL_REFERER`.
8. **Check.** Open `https://ionity.<subdomain>.workers.dev/`: it should answer `ok: true` and show which keys are set. Then open the app and enter an access code (section 6).

To deploy by hand instead: `npx wrangler deploy` in the repo root, after `npx wrangler login`.

---

## 4. The Worker

One file, `src/evailability-worker.js`. It's organised in sections, marked `// ---…` in the code.

### Endpoints

All need the access token (header `X-Access`, or `?access=` in a URL), except those marked *public*.

| Endpoint | What it does |
|---|---|
| `GET /` *public* | Health check; shows which keys are set (true/false only). |
| `POST /unlock` *public* | `{code}` → `{token}` if the code passes the check (section 6). |
| `GET /geocode?q=` | Place search (Pelias), for the address fields. |
| `POST /alternatives` | `{from, to}` → up to 3 route options (see below), each with main roads, cities on the way and the number of Ionity sites. |
| `POST /plan` | `{from, to, via?, viaSnap?, brands?, corridorKm?}` (viaSnap: per via, true for a town: it is moved onto the nearest A/N road of a rough route through it; the used points come back as `vias`) → route (coordinates, km and minutes per point, roads, via positions) plus the chargers of those brands within 5 km. `via`: one point or a list of up to 3. Detours are included only if cached; status only for the first 8 chargers. |
| `POST /status` | `{stations:[{id, lat, lon, country, brand}]}` → live status per charger. |
| `POST /places` | `{points:[{id, lat, lon}]}` (max 8) → `{places:{id:{area, src, town, v, ok}}}`, for chargers named only by their brand. One Overpass request per batch: service areas (`highway=services`/`rest_area`, within 800 m, the one whose outline is nearest, 0 when inside it) and, as fallback, the nearest fuel station within 200 m, or charging station whose name starts with a charging brand, whose name says more than its brand (host names such as restaurants and hotels are skipped) ("Shell 't Hol" → "'t Hol"; `placeFromStationName`). Three mirrors, 7 s timeout each, starting with the one that answered last. Town: the geocoder. Cached 30 days per ~100 m (`pl7:` in KV), not when Overpass failed. |
| `POST /ndw-sites` | `{tiles, brands}` (max 3 tiles) → `{sites, split, done}`: fast chargers of those brands from NDW in those tiles; `split` lists quarter tiles to ask for instead. |
| `POST /detours` | `{items:[{id, lat, lon, a, b}]}` (max 20) → `detours`: extra minutes per charger; `reach`: `{toMin, toKm}`, the drive from `a` to the charger. `a`/`b` are route points 3 km before and after it. |
| `GET /brands` *public* | The brands (key, name, colour). |
| `GET /logo/<brand>` *public* | The brand's site icon (image). |
| `GET /admin/usage` *public, own password* | Usage per day for the admin page (`Authorization: Bearer <ADMIN_TOKEN>`). |
| `GET /debug/…` | Diagnostics: `brands`, `ndw`, `de`, `at`, `detour`, `ocm-ionity`, `ocm-operator`. In a browser use `?access=<ADMIN_TOKEN>`. |

### Route planning

- **Routing:** OpenRouteService `directions/driving-car` with `extra_info: countryinfo` and instructions. Each point may snap to a road up to 5 km away (`radiuses`), so a start in a car park still works.
- **Roads:** road numbers (A, E, B, N, S, M…) come from the instruction step names. The badges in the app are styled per country like real road signs.
- **Route options:** OpenRouteService gives no alternative routes over 100 km. So `/alternatives` makes them itself: it plans via points left and right of the fastest route at 1/4, 1/2 and 3/4 of the way, at 12% of the trip length (6–40 km), plus twice that halfway (8 rough routes). It drops options more than 25% slower or with the same main roads as another option (a main road: driven at least 10% of the trip, 8–30 km), keeps up to 3, drops side trips that return to a road they left, and names each by its main roads and the large cities it passes (`MAJOR_CITIES`). The chosen option is planned again with its via point. After planning, the app says when there was nothing to choose from, or why the comparison failed.

### Chargers along the route

- **Brands:** `BRANDS` lists the 11 brands. Per brand: a pattern to find its operators in Open Charge Map (`ocm`), one to recognise it in the live sources (`live`), one for EVSE IDs (`evse`, e.g. `NL*FLA*…`; TotalEnergies: `xx*TCB`, `xx*TOT`, `FR*HPC`), its colour and its website (for the logo).
- **Operator IDs:** read once a day from Open Charge Map's reference data (`/v3/referencedata`). The trimmed list of operators and countries is kept 7 days in KV (`ocm-ref-v2`).
- **Finding chargers:** the route is cut into pieces of about 150–250 km. Per piece, one Open Charge Map call fetches the box around it for all chosen operators (`operatorid=1,2,3`, `compact=true`). The box is rounded to 0.05° so nearby lookups reuse it. Calls are spaced out and retried on 429.
- **Fast only:** for brands other than Ionity, only sites with a charger of 50 kW or more (`FAST_KW`).
- **Trimming:** each answer is cut down to the few fields used (id, operator, number of points, title, address, coordinates, country, power). It is cached for an hour in memory and a day in KV (`ocm2:…`). This keeps the Worker within the free plan's CPU and memory limits on long routes with many brands.
- **Along the route:** each site is projected onto the route: distance along it (km and minutes) and distance off it. Sites more than 5 km off are dropped.
- **Second source in the Netherlands (NDW):** Open Charge Map misses sites (Fastned shares no data with it). `/plan` returns `ndwTiles`: fixed tiles of 0.05° × 0.08° (about 5.5 km) within 1.5 km of the Dutch part of the route. After planning, the app asks `POST /ndw-sites {tiles (max 3), brands}` in the background. The Worker fetches NDW per tile, keeps only fast chargers (≥ 50 kW, Ionity always) of known brands, and caches the trimmed tile a day in memory and KV (`ndwt1:<tile>`), shared by everyone. A tile whose answer is over 450 kB comes back as `split` and the app asks for its quarters (up to 3 levels), so no single request parses too much. The app adds sites not already there (same brand within 250 m, or matched live id), projected onto the route, within 5 km. Turn off with Worker variable `NDW_DISCOVERY = off`. Cost per new route: about 20–40 NDW calls and as many KV writes; repeated routes in the same area that day cost nothing.

### Detours

- Via the OpenRouteService **matrix**: for each charger S, the times A→S, S→B and A→B, where A and B are route points 3 km before and after it. Detour = A→S + S→B − A→B, in minutes. 20 chargers fit in one matrix call.
- The same matrix call also gives the drive A→S in km (`metrics: duration, distance`). The app uses it to show the real distance and time to a charger beyond an exit (see 5, Behaviour).
- Cached 6 hours per charger and driving direction (`det2:<id>:<bearing>`), in memory.
- Planning doesn't compute detours. The app asks `/detours` for the chargers it shows and, with "Easy to reach" on, for every charger still without a detour within 150 km ahead and 50 km beyond the furthest row scrolled to (at most 80 per round, continuing until done). This keeps the matrix quota (500/day) low.

### Live status

Looked up per charger, cached 60 seconds.

- **NL (NDW):** GeoJSON features in a small box around the charger, filtered on the brand (operator names, `cpo_id`, EVSE ID). Counts CCS entries when present (a CCS and a CHAdeMO cable on one post are one spot), otherwise DC. Also returns the brand's other NDW sites within 1.2 km (`nearby`: id, position, name, counts); the app matches Open Charge Map pins to these sites, each site once, moves a pin onto its site and hides pins left over as duplicates (`reconcileLive`). That fixes pins on the wrong side of the road and two pins for one site. A site whose data hasn't changed for 3 hours while full counts as *probably offline*.
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
| `ndwt1:<tile>` | NDW fast chargers of known brands in a tile | 1 day |
| `logo:<brand>` | Site icon | 7 days (miss: 1 day) |
| `hist:<charger id>` | State seen, since when, last full | 2 days |

Watch the 1,000 writes/day: writes happen for usage (≤ every 2 min while in use), new boxes, logos and state changes.

---

## 5. The app

One file, `evailability.html`, with no libraries or build step. The version is in `APP_VERSION`; raise it on every change ("Check for update" in Help compares it with the live file).

### Screens

- **Splash:** shows the idea: a car display with "your navigation" on the left and the chargers coming up on the right, the timeline moving down as you drive; about 5 s, or tap. On a fresh start only (after a force close or reboot; not when coming back from the background, and not after an update reload, thanks to a sessionStorage flag). Not shown before the introduction has been seen. "Don't show again" there, and a toggle in Help.
- **Access code:** asked once per device (section 6).
- **Introduction:** five slides on first use; can be shown again from Help.
- **Start:** To / From (empty means your location), a + for up to 2 via points (the screen reads bottom to top like the drive: a new via goes right under To and the earlier one moves down; the lower via is driven first), the brand picker, the charging power (Fast/Extra fast/HPC) and "Simulate the drive". Tapping an empty address field shows the last 10 places used (`evailability-recent`). New route empties the fields and the places behind them together. Without vias you get the route options as cards. The chosen card shows "Planning…" until the route is ready.
- **Driving:** destination at the top (tap: compare routes from here), you at the bottom, chargers in route order in between. Chargers of several brands at one spot (within 200 m, same side) share one row.
  - Each row shows the name, distance and time to it, max power, and free/total (green free, orange full; the numbers grey when older than 3 minutes, the dot keeps its colour and sweeps while updating).
  - Left of the row: how to reach it (exit arrow, red round trip) and extra minutes.
  - Road numbers on the line where the road changes.
  - Top bar: New route, brands (show or hide brands on this route; adding one replans), Easy to reach, and Help.
- **Press and hold a charger:** since when it's full or when it was last full, then Apple Maps, Google Maps, Waze, Flitsmeister (on iPhone: copies coordinates; it has no public navigation link there), copy coordinates, share.
- **Help:** manual with a legend of all symbols, version, and check for update.
- **Bottom banner:** "You've left the route. New route planned.", "New route planned" (after picking another route) and, after planning, "Only one sensible route here" or why the route comparison failed. Hides after 6 s. The roads of the route are shown at the top, not in the banner.

### Behaviour

- **GPS:** `watchPosition`. Your position is projected onto the route. More than 1 km off it means rerouting from where you are, through the via points still ahead. Via points you've passed are dropped.
- **Status refresh:** every minute for the chargers on screen (at least half visible), in batches of 4, only when the screen is on. Chargers checked within the last minute aren't asked again. Tap a row to update it (at most once a minute; otherwise "Checked N s ago").
- **Smooth list:** `patchList` matches rows by key: unchanged rows stay the same element, changed ones are replaced on their own, new ones inserted. When scrolled up, the row at the top of the view is kept in place while rows come, go or change size.
- **Names:** a row with several chargers uses the first member with a real name (`siteLabel`), so it doesn't switch as members change order. Looked-up places are kept on the device per ~100 m (`evailability-places`), so a replan or reroute shows them at once. After planning, all chargers ahead that need a name are looked up straight away, 8 per call.
- **No blinking:** rows are only redrawn when their content changed (`patchList`, `setHtml`). While updating, a row keeps its numbers and colour; only its numbers turn grey when the value is more than 3 minutes old; the dot keeps the charger's colour (`dot-…` class) and shows a turning radar sweep while updating (`scanning`). A value that changed (free count, total or state) pops briefly (`flashAt`, class `changed`).
- **Detours:** fetched for the rows on screen. With "Easy to reach" on, also for all chargers within 150 km ahead (and 50 km beyond the furthest row you scrolled to); a charger then only appears once its detour is known.
- **Distance on a row:** for a charger next to the road (within 250 m: a service area) it's where the route passes it. For one further away it's the route up to point A (3 km before the closest point) plus the drive A→charger from `/detours` (`wayTo()`). Before that answer is in, the closest point on the route is used, which makes chargers around one junction all show the same distance.
- **Charging power:** Fast (50 kW+), Extra fast (150 kW+) or HPC (300 kW+), on the start screen and in the brand sheet (`evailability-power`). A filter on the device: the live `maxKw` wins over Open Charge Map's (so an AC charger listed as fast drops out); unknown power shows only with Fast, except Ionity. Above Fast, the brands button shows e.g. "150+".
- **Row names:** `siteName()`: brand words are dropped; when nothing useful is left (e.g. every Shell site is called "Shell Recharge"), a service-area name, then NDW's name if it reads like a place (not a street address; kept in `liveName`, never copied into `name`), then a looked-up service area or town (`/places`, once per charger) is used.
- **Order and the other side:** at a service area your side comes first (`orderSites`: the other side counts 600 m later). A charger on the other side shows the real distance and time including the turn-around (route to point A + the drive A→charger from `/detours`).
- **"Easy to reach":** on your side of the road, or a detour of at most 6 minutes, and no round trips.
- **Screen:** kept on while driving with the Screen Wake Lock, asked again whenever iOS releases it, on every tap and every 30 s, plus a tiny silent muted looping video (`NOSLEEP_MP4`, no sound track, so music and CarPlay aren't interrupted) as a fallback for home-screen apps. Help shows which is active. Released on arrival and on New route.
- **Status updating:** while any charger is being looked up, the status bottom right shows a turning ring and a pulsing "Updating".
- **Arrival:** within 150 m of the end of the route (after having been more than 500 m away), a short confetti shower and a "You've arrived" card; no rerouting after that. Stored with the route, so a reload doesn't celebrate again.

### Stored on the device (localStorage)

| Key | Content |
|---|---|
| `evailability-access` | Access token |
| `evailability-v1` | Current route, chargers, statuses (so a reload continues) |
| `evailability-brands` | Brands chosen on the start screen |
| `evailability-hidden` | Brands hidden on the current route |
| `evailability-myside` | "Easy to reach" on/off |
| `evailability-nav` | Navigation app used last |
| `evailability-intro-seen` | Introduction shown |
| `evailability-splash-off` | Splash screen switched off |
| `evailability-power` | Minimum charging power: 50, 150 or 300 |
| `evailability-recent` | Last 10 places used as start, via or destination (label, position, exact), offered in every address field |
| `evailability-places` | Place names found per spot (~100 m), so rows are named at once after a replan (max 400) |

On first start the app moves settings from the old `ionity-route-…` keys to these. sessionStorage `evailability-session` marks that the splash was already considered in this session.

---

## 6. Access code

The app asks for a code once per device. The Worker does the check, so the page source doesn't reveal how it works.

- **Valid code:** 9 digits that pass the *11-proef*, like a Dutch BSN: 9×d1 + 8×d2 + … + 2×d8 − 1×d9 must be divisible by 11. Example: `123456782`. Spaces and dots are ignored.
- **Token:** if the code is right, the Worker returns a token: an HMAC-SHA256 of a fixed text (`ionity-route-access-v1`, kept from the old name so existing tokens stay valid), keyed with `ACCESS_SECRET` (or `OCM_API_KEY` if that isn't set). The app stores it and sends it as `X-Access`. Every endpoint except the public ones requires it; without it the answer is 401 and the app asks for the code again.
- **Signing everyone out:** set or change `ACCESS_SECRET`.
- **Guessing:** limited to 5 tries per 10 minutes per IP address (per Worker copy).
- **Strength:** about 1 in 11 random 9-digit numbers passes. This is a light barrier against casual use, not real security. For more, replace `elfProef` with a list of codes stored as a secret, or with Cloudflare Access.

---

## 7. Testing and debugging

- **Worker:** `node --check src/evailability-worker.js`. The Worker can be imported in Node 18+ and called as `worker.fetch(new Request(...), env, ctx)` with a mocked `globalThis.fetch` and a fake KV (`get`/`put`). That's how changes were tested during development.
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
- **Place names** depend on OpenStreetMap: a named service area, or a fuel station / charging station named "<brand> <place>" next to the charger. Where neither is mapped, the row shows the town. Public Overpass servers sometimes refuse Cloudflare's shared addresses; three mirrors are tried ("Overpass errors" on the usage page).
- **Route options** come from via points beside the fastest route; a variant that differs only by a short road (e.g. the N3 at Dordrecht, ~9 km) can be missed or treated as the same route. A town as via point is passed on the nearest main road, which is the reliable way to force such a variant.
- **CPU:** the free plan allows about 10 ms CPU per request. Route comparison, NDW tiles and place lookups are the heaviest; each is split or trimmed to stay under it.

---

## 9. Rename to EVailability: what's left

The app, files, texts and device storage are renamed. The Worker still runs as `ionity` (address `ionity.remco-dv.workers.dev`) because Worker secrets can't be copied by code. To finish:

1. Create the secrets on a Worker named `evailability` (or rename the Worker in the Cloudflare dashboard, if offered, which keeps them): `ORS_API_KEY`, `OCM_API_KEY`, `ECONTROL_API_KEY`, `ADMIN_TOKEN`, and `ACCESS_SECRET` if used. Same values keep existing access tokens valid.
2. Set `name = "evailability"` in `wrangler.toml`, and `WORKER` in `evailability.html` and `admin.html` to `https://evailability.remco-dv.workers.dev`.
3. In `.github/workflows/deploy-worker.yml`, change the path `src/ionity-route-worker.js` to `src/evailability-worker.js` and the name to "Deploy EVailability Worker". (The GitHub token used by Claude may not edit workflow files.) Until then, a Worker change deploys only when `wrangler.toml` changes too.
4. After a week or so, delete the old `ionity` Worker. Optionally rename the KV namespace (bound by ID, so nothing breaks).

---

## 10. Open items (as of 14 November 2026)

**To check on the next drive**
- Row names after the stricter rules (app `.50`): service-area names (e.g. 't Hol, Keizershof, Hoezaar) instead of "Fastned" / "Shell Recharge", no host names (restaurants, hotels), no flipping back. Since app `.51` the press-and-hold sheet shows two small lines under the title: **Name from** (which rule in `siteName()` gave the name) and **Lookup** (what `/places` returned: service area or station name, town, failed search, or not looked up yet). A brand-only row with "no service area or station within reach" means missing OpenStreetMap data; one with an area that was "skipped" or "not looked up yet" for long points to a bug. The sheet title now uses the row's own label (`siteLabel`), so both always match.
- Place lookups (app `.52`): a "not looked up yet" seen on the road (14 Nov) was most likely a `/places` request that never answered, which kept the one-at-a-time lock (`placesBusy`) set so no further lookups ran; calls made while a lookup was running were also dropped. Now the request times out after 25 s, a call that arrives while one runs is queued (and continues for the whole route), names are looked up for the whole route again after a reload, and opening the press-and-hold sheet asks for that charger straight away and updates the sheet. The Lookup line also says "asking now", "waiting: another lookup running", "no answer at …" or "asked at …, nothing returned". Check on the next drive that brand-only rows get names.
- App `.53` (14 Nov evening, 520 km route with 300+ chargers): place names for the whole route only 100 km ahead (rows on screen and the press-and-hold sheet always) and only after the detour lookups, since every name lookup uses geocoder quota (shared with the address search) and an OpenStreetMap query; timeouts on `/status` (20 s) and `/detours` (30 s); with "Easy to reach", detours carry on to the destination when the top of the list is on screen (before, a stretch where every charger was hidden could stop them there), and "Checking detours…" shows only for chargers actually being looked up; no redraw while a finger is on the list or it's still gliding, and the scroll position is only set when it really changes; road badges on the line are hidden where they pass under the down button (the badge above the button shows the road). To check on a drive: scrolling feels normal while names and detours arrive, no badge on the button.
- App `.54`: names are looked up only for rows that are shown: the rows on screen plus the next 6 further ahead in the list (`namesToFetch()`), never for hidden chargers (brand off, too slow, not easy to reach). No more whole-route name runs. "Easy to reach" is on by default (until switched off on a device).
- App `.55`: default minimum power is Extra fast (150 kW+) on devices that never chose one (`DEFAULT_KW`); a saved choice is kept.
- App `.56`: the fixed road badge above the down button no longer follows rows. Road badges on the line slide over it (the overlapped part is clipped from the fixed one with `clip-path`), and when one sits exactly on it, they swap: the fixed badge shows that road and the moving one is hidden below that point (`updateStickyRoad`, badges carry `data-km`). Check on the phone that it feels smooth both ways.
- App `.58`: press-and-hold opens the charger on the map in Apple Maps, Google Maps or Waze (`NAV_MODE = "show"`) instead of starting a route, so the owner can check the spot first and tap Route/Go there. Set `NAV_MODE = "route"` to go back to routing straight away.
- Smoothness of the list after the keyed `patchList` and scroll anchoring.
- "Overpass" vs "Overpass errors" on the usage page.

**Waiting on the owner**
- Section 9: move the Worker secrets to a Worker named `evailability`, then switch the app and usage page; update the workflow path (the GitHub token used so far has no `workflow` permission).
- Decide whether all brands should be equal (Ionity is still the default brand and listed first on shared rows).

**Ideas and next steps, not started**
- Scaling (100–1,000 daily users): KV writes run out first. Cache API on a custom domain (~€10/year) for status, detours, Open Charge Map tiles and place search instead of per-copy memory; one shared NDW snapshot per minute; fewer KV writes (usage saved less often, charger history off KV); slower refresh for chargers far ahead. Next tiers: Cloudflare Workers Paid $5/month; OpenRouteService has no public paid plan, so self-host it (estimated €40–90/month) plus a geocoder.
- Monetization (explored only): web app with own payments (Mollie/Stripe or a merchant of record for EU VAT) first, native app (Capacitor, CarPlay, background GPS) if there is traction. Before charging: data licences (Open Charge Map attribution, OpenRouteService, NDW/MobiData/E-Control terms), brand logos are trademarks, trademark check on the name.
- Live status for Belgium (Eco-Movement token) and France; NDW-style second source for Germany (MobiData BW).
- CarPlay / car display as a "secondary screen" beside the navigation is the main use case; a native wrapper would be needed for CarPlay.


---

## 11. France (in progress)

**Source.** The National Access Point transport.data.gouv.fr (Licence Ouverte 2.0, attribution required) publishes two national files:
- static, nightly: https://transport.data.gouv.fr/resources/84013/download (CSV, ~130 MB, ~180,000 charge points: position, power, operator, `id_pdc_itinerance`);
- dynamic, live: https://transport.data.gouv.fr/resources/84098/download (CSV, ~9.5 MB, ~129,000 rows: `id_pdc_itinerance`, `etat_pdc` en_service/hors_service/inconnu, `occupation_pdc` libre/occupe/reserve/inconnu, `horodatage`). Rows can appear twice (several origins): take the newest `horodatage`. There is no geographic query: always the whole country.

**Static index (done).** `data/fr-fast-sites.json`, served by GitHub Pages, is built by hand from the static file:
1. Download the static file (and optionally the dynamic one, for a coverage report), zip them and upload them in a Claude chat, or run the script yourself.
2. `python3 tools/build-fr-index.py <static.csv> [dynamic.csv]` (standard library only). It keeps charge points of 50 kW and up of the 11 brands in metropolitan France, recognises the brand by the start of `id_pdc_itinerance` (FRIOY/FRION Ionity, FRFAS Fastned, FRTSL Tesla, FRELC Electra, FRIZF Izivia, FRHPC/FRTCB TotalEnergies, FRALL/FREVC Allego, FRPD1 Powerdot, FRSHE Shell) or else by operator name, and merges stations of one brand within 150 m into one site.
3. Commit the new JSON. Refresh monthly or before a trip to France.

Format: `{built, source, licence, fields, sites:[[brand, lat, lon, maxKw, name, [pdcIds]]]}`.
Build of 14 Nov 2026: 3,943 sites, 25,923 fast points, 710 kB (172 kB gzipped). Ionity 174 sites, Tesla 285, Fastned 65, TotalEnergies 411, Electra 417, Izivia 992, Powerdot 1,122, Allego 446, Shell 31.

**What the files showed (14 Nov 2026, 22:38).**
- Share of fast points present in the live feed: Fastned 100%, Shell 99%, Powerdot 98%, Electra 96%, Tesla 95%, Ionity 93%, TotalEnergies 92%, Izivia 65%, Allego 62%.
- `horodatage` is the last change, not the last check, so a quiet free charger can be hours old. Median age: Tesla 0.5 h, Allego 3.3 h, Ionity 3.7 h, but Electra 207 h: Electra's states look frozen, so a site whose newest change is more than ~24 h old should show "not live".
- Old ids stay in the static file without live data (e.g. Ionity Village Catalan Est: FRIONE4131/4132 next to the live FRIOYE… points). Count only points that are in the live feed.
- Allego sometimes appears twice under FREVC… and FRALLEGO… with the same number tail, ~150–200 m apart (e.g. Perpignan Roussillon). To do: merge such twins and keep the id set that is live.
- Brand patterns in the Worker's `BRANDS` miss French prefixes: Fastned FRFAS (has FLA), Izivia FRIZF (has IZI/CDO), Powerdot FRPD1 (has PWD), Shell FRSHE. Add these when France goes live.

**CPU (the open question).** Scanning the whole dynamic file for the wanted ids took 17–30 ms (decode ~7–10 ms, scan ~10–20 ms) in Node 22 in a test container. The free Workers plan allows about 10 ms CPU per request, so one scan per minute per Worker copy will probably hit "exceeded CPU" now and then. Options: try it on the free plan and watch the logs; Workers Paid ($5/month, no practical CPU limit); or a trimmed snapshot made elsewhere (e.g. a Synology job).

**Range test (Worker, 14 Nov).** `GET /debug/fr-range` checks whether the French server allows partial downloads (HTTP Range) and reports the file size and headers. `GET /debug/fr-range?part=3&parts=10[&ids=…]` reads only piece 3 of 10 and returns the rows for the ids (default: Ionity Village Catalan Est); its CPU time shows in the Cloudflare logs. `frPiece()` takes the lines that start inside its byte range (reading 2 kB past the end so the last line is complete), so the pieces together cover every line exactly once (tested on the real file with 1, 7 and 10 pieces). If Range works, the plan is: the app asks for ~10 pieces side by side, each Worker call scans ~1 MB (~2–3 ms CPU), within the free plan.

**Next steps.** (1) Run the Range test; if it fails, decide the CPU option. (2) Worker: load the index (memory, a day), FR in `LIVE_COUNTRIES`, one shared scan of the dynamic file per minute, `frStatus` per site (free = en_service and libre among live points; full; "not live" when the newest change is > 24 h old), FR sites from the index as a second source like NDW (`ndwTiles`-style), brand prefixes above. (3) App: source label and attribution, PAN FR on the usage page, `APP_VERSION`. (4) Test on a drive in France.
