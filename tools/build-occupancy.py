#!/usr/bin/env python3
"""Occupancy through the day: how many chargers were free at each charger site, every 15 minutes.

Run by .github/workflows/occupancy.yml (started by the Worker's timer every 15 minutes, GitHub's own
schedule as backup). Standard library only. Keeps 8 days (today and the same weekday a week ago), so
the app can draw today's line against last week's (like ParkPilot's "previous weeks" line).

    python3 tools/build-occupancy.py STATE_DIR [--fr fr-status.json] [--pt pt-status.json]

STATE_DIR holds the branch "occ" (read, then rewritten in place; the workflow force-pushes it as one
commit without history, like live-fr). The Worker's GET /occupancy/config says whether this is on and
which brands to follow (setting "occupancy" and "occupancyBrands" on the usage page); when off, this
writes nothing and exits with code 3, so the workflow skips publishing.

Sources (no keys needed):
  NL  NDW's live GeoJSON (the Worker's source too). At most 1,000 features per call, so a scan of the
      whole country (tiles split until under 1,000) runs once a day to find the followed brands' fast
      sites (nl-sites.json); the other runs ask a small box around each known site.
  FR  the France live snapshot (branch live-fr) with data/fr-fast-sites.json.
  PT  the Portugal live snapshot (branch live) with data/pt-fast-sites.json.
  DE  MobiData BW's Open ChargePoint DataBase (the Worker's German source, AFIR data; Germany, and
      the Austrian sites it holds):
      one call per followed brand with operator_name=<brand>, so the whole country in a few calls.

Files written (in STATE_DIR):
  t_<floor lat>_<floor lon>.json  {v, at, slotMin, sites: {key: {b, cc, tz, lat, lon, n, t, d: {date: slots}}}}
      slots: 96 characters, one per 15 minutes of the site's local day (00:00 first):
      0-9 then a-z = number of free chargers (fast ones, the site's own count), "." = no reading.
      t = the site's latest total. Tiles of 1 x 1 degree keep each file small for the Worker.
  nl-sites.json  {at, brands, scanCalls, sites: {ndwId: [brand, lat, lon, name]}}
      (when a box per known site would take as many calls as the last full scan, scanCalls, every run
      is a full scan instead)
  meta.json      {at, secs, sites per country, NDW calls, discovery or not}
"""
import concurrent.futures
import datetime
import glob
import gzip
import json
import math
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
import urllib.parse
from zoneinfo import ZoneInfo

WORKER = "https://ionity.remco-dv.workers.dev"
NDW = "https://dotnl.ndw.nu/api/rest/geojson/dynamic-road-status/charge-point-data/v1/features"
NL_BOX = (3.3, 50.7, 7.3, 53.6)          # lon/lat of the Netherlands, generously
NDW_MAX = 1000                            # NDW answers at most this many features per call
DISCOVER_H = 20                           # rescan the Netherlands for sites after this many hours
SCAN_CALLS = 288                          # calls of a full NL scan (measured 24 Nov 2026), until a scan has
                                          # counted its own: when the boxes per site would take as many, a
                                          # full scan each run is cheaper (all 1,556 fast sites = 1,184 boxes)
OCPDB = "https://api.mobidata-bw.de/ocpdb/api/public/v1/locations"
OCPDB_MAX = 1000                          # the API's largest page
DE_COUNTRIES = {"DE", "AT"}               # OCPDB also holds some sites abroad (AFIR feeds of whole networks);
                                          # keep Germany, and Austria while E-Control isn't read here
# What to ask OCPDB's operator_name for, per brand key (a part of the operator's name); others: the key.
DE_OPERATOR = {"ionity": "IONITY", "fastned": "Fastned", "enbw": "EnBW", "aral": "Aral", "tesla": "Tesla",
               "shell": "Shell", "total": "Total", "allego": "Allego", "electra": "Electra",
               "essent": "E.ON", "vattenfall": "Vattenfall", "eneco": "Eneco"}
SLOT_MIN = 15
SLOTS = 24 * 60 // SLOT_MIN
ALPHA = "0123456789abcdefghijklmnopqrstuvwxyz"
FAST_KW = 50
TZ = {"PT": "Europe/Lisbon", "DE": "Europe/Berlin", "AT": "Europe/Vienna"}  # else Central European time
DEFAULT_CONFIG = {"on": True, "keepDays": 8, "brands": [
    {"key": "ionity", "live": "ionity", "evse": r"^[A-Z]{2}\*?IO[NY]\*?"}]}


def log(*a):
    print(*a, flush=True)


def tz_of(cc):
    return ZoneInfo(TZ.get(cc, "Europe/Amsterdam"))


def get(url, timeout=60, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "Accept": "application/json", "Accept-Encoding": "gzip", "User-Agent": "EVailability-occupancy"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
            return json.loads(raw)
        except urllib.error.HTTPError as e:
            last = e
            if e.code < 500 and e.code != 429:
                raise
        except Exception as e:  # network trouble: try again
            last = e
        time.sleep(2 + 4 * i)
    raise last


def load_config():
    try:
        cfg = get(f"{WORKER}/occupancy/config", timeout=20)
        log("Config:", json.dumps(cfg))
        return cfg
    except Exception as e:
        log("Config not reachable, using Ionity only:", e)
        return DEFAULT_CONFIG


# ------------------------------------------------------------------ NDW (NL)

class Pace:
    """NDW refuses bursts (about 10 calls a second): at most 8 starts a second over all threads."""
    def __init__(self, per_sec=8):
        self.gap, self.next, self.lock = 1.0 / per_sec, 0.0, threading.Lock()
        self.calls = 0

    def wait(self):
        with self.lock:
            now = time.time()
            at = max(now, self.next)
            self.next = at + self.gap
            self.calls += 1
        if at > now:
            time.sleep(at - now)


PACE = Pace()


def ndw(box):
    PACE.wait()
    bbox = ",".join(f"{v:.6f}" for v in box)
    return get(f"{NDW}?bbox={bbox}", timeout=60).get("features", [])


def brand_of(feature, brands):
    p = feature.get("properties") or {}
    names = f"{p.get('operator_name') or ''} {p.get('owner_name') or ''} {p.get('suboperator_name') or ''}"
    evse1 = f"{p.get('country_code') or 'XX'}*{p.get('cpo_id') or ''}*"
    evse2 = re.sub(r"^([A-Z]{2})-([A-Z0-9]{3})-.*", r"\1*\2*", str(feature.get("id") or ""))
    for b in brands:
        if b["live_re"].search(names) or b["evse_re"].search(evse1) or b["evse_re"].search(evse2):
            return b["key"]
    return None


def counts(feature):
    """Free and total fast chargers, counted like the Worker (CCS entries when there are any, else DC)."""
    av = [e for e in (feature.get("properties") or {}).get("availabilities") or []
          if isinstance(e.get("total"), (int, float)) and isinstance(e.get("available"), (int, float))]
    dc = [e for e in av if str(e.get("power_type") or "").upper() == "DC"]
    ccs = [e for e in dc if re.search("COMBO|CCS", str(e.get("connector_type") or ""), re.I)]
    use = [e for e in (ccs or dc) if (e.get("power_max") or 0) / 1000 >= FAST_KW]
    if not use:
        return None
    total = int(sum(e["total"] for e in use))
    return (int(sum(e["available"] for e in use)), total) if total else None


def nl_scan(brands):
    """The whole country in tiles, split while NDW hits its 1,000 cap. Returns {id: (site, counts)}."""
    found, todo, depth_hit = {}, [], 0
    lon0, lat0, lon1, lat1 = NL_BOX
    lat = lat0
    while lat < lat1:
        lon = lon0
        while lon < lon1:
            todo.append(((lon, lat, min(lon + 0.5, lon1), min(lat + 0.5, lat1)), 0))
            lon += 0.5
        lat += 0.5

    failed = [0]

    def one(job):
        box, depth = job
        try:
            return box, depth, ndw(box)
        except Exception as e:  # one tile failing shouldn't cost the whole country
            failed[0] += 1
            log("NDW tile failed:", box, e)
            return box, depth, []

    with concurrent.futures.ThreadPoolExecutor(4) as ex:
        while todo:
            batch, todo = todo, []
            for box, depth, feats in ex.map(one, batch):
                if len(feats) >= NDW_MAX and depth < 8:
                    x0, y0, x1, y1 = box
                    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
                    todo += [((x0, y0, mx, my), depth + 1), ((mx, y0, x1, my), depth + 1),
                             ((x0, my, mx, y1), depth + 1), ((mx, my, x1, y1), depth + 1)]
                    continue
                if len(feats) >= NDW_MAX:
                    depth_hit += 1
                for f in feats:
                    b = brand_of(f, brands)
                    c = counts(f) if b else None
                    if not c:
                        continue
                    lon, lat = (f.get("geometry") or {}).get("coordinates") or [None, None]
                    if lat is None:
                        continue
                    p = f.get("properties") or {}
                    found[str(f["id"])] = ([b, round(lat, 5), round(lon, 5), p.get("address") or ""], c)
    if depth_hit:
        log(f"NL scan: {depth_hit} tiles still at the cap at the deepest level")
    return found, failed[0]


def nl_boxes(sites):
    boxes = {}
    for sid, (b, lat, lon, name) in sites.items():
        key = (round(lat, 2), round(lon, 2))
        boxes.setdefault(key, []).append((sid, lat, lon))
    return boxes


def nl_status(sites):
    """Counts for known sites: a small box around each (sites close together share one call)."""
    boxes = nl_boxes(sites)
    out = {}

    def one(group):
        lats = [g[1] for g in group]
        lons = [g[2] for g in group]
        feats = ndw((min(lons) - 0.004, min(lats) - 0.003, max(lons) + 0.004, max(lats) + 0.003))
        byid = {str(f.get("id")): f for f in feats}
        return [(sid, counts(byid[sid]) if sid in byid else None) for sid, _, _ in group]

    with concurrent.futures.ThreadPoolExecutor(4) as ex:
        futs = [ex.submit(one, g) for g in boxes.values()]
        for fu in futs:
            try:
                for sid, c in fu.result():
                    if c:
                        out[sid] = c
            except Exception as e:
                log("NDW call failed:", e)
    return out


# ------------------------------------------------------------------ snapshots (FR, PT)

def letters_count(codes, ages):
    """F free, U in use, O out of order, ? unknown, - not in the live file (as the Worker counts)."""
    known = [ch for ch in codes if ch in "FUO"]
    if not known:
        return None
    seen = [a for a, ch in zip(ages or [], codes) if a is not None and ch != "-"]
    if seen and min(seen) > 24 * 60:
        return None  # nothing changed for a day: "live data looks frozen", no reading
    return codes.count("F"), len(known)


def snapshot_age_min(doc, field):
    try:
        t = datetime.datetime.fromisoformat(doc[field].replace("Z", "+00:00"))
        return (datetime.datetime.now(datetime.timezone.utc) - t).total_seconds() / 60
    except Exception:
        return 1e9


def fr_sites(path, followed):
    if not path or not os.path.exists(path):
        return {}
    snap = json.load(open(path))
    idx = json.load(open("data/fr-fast-sites.json"))
    if snapshot_age_min(snap, "at") > 30:
        log("FR snapshot older than 30 min: skipped")
        return {}
    if snap.get("index") and snap["index"] != idx.get("built"):
        log("FR snapshot from another index version: skipped")
        return {}
    out = {}
    for i, s in enumerate(idx["sites"]):
        if s[0] not in followed:
            continue
        v = snap.get("s", {}).get(str(i))
        c = letters_count(v[0], v[1]) if v else None
        if c:
            key = f"fr:{(s[5] or [str(i)])[-1]}"
            out[key] = ({"b": s[0], "cc": "FR", "lat": s[1], "lon": s[2], "n": s[4]}, c)
    return out


def pt_sites(path, followed):
    if not path or not os.path.exists(path):
        return {}
    snap = json.load(open(path))
    idx = json.load(open("data/pt-fast-sites.json"))
    if snapshot_age_min(snap, "pub") > 30:
        log("PT snapshot older than 30 min: skipped")
        return {}
    out = {}
    for s in idx["sites"]:
        if s[1] not in followed:
            continue
        v = snap.get("s", {}).get(s[0])
        c = letters_count(v[0], v[1]) if v else None
        if c:
            out[f"pt:{s[0]}"] = ({"b": s[1], "cc": "PT", "lat": s[3], "lon": s[4], "n": s[6]}, c)
    return out


# ------------------------------------------------------------------ OCPDB (DE)

SIDE_WORDS = re.compile(r"\b(nord|north|süd|sued|south|ost|east|west|richtung\s+\S+)\b", re.I)


def opposite_sides(a, b):
    wa = "|".join(sorted(w.lower() for w in SIDE_WORDS.findall(a or "")))
    wb = "|".join(sorted(w.lower() for w in SIDE_WORDS.findall(b or "")))
    return wa != wb and (wa or wb) != ""


def km(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = (math.sin((lat2 - lat1) * p / 2) ** 2 +
         math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2)
    return 12742 * math.asin(math.sqrt(a))


def de_brand_of(loc, brands):
    names = " ".join(str((loc.get(k) or {}).get("name") or "") for k in ("operator", "owner", "suboperator"))
    names += " " + str(loc.get("name") or "")
    evses = [re.sub(r"\s", "", str(e.get("evse_id") or e.get("uid") or "")) for e in loc.get("evses") or []]
    for b in brands:
        if b["live_re"].search(names) or any(b["evse_re"].search(x) for x in evses):
            return b["key"]
    return None


ISO3 = {"DEU": "DE", "AUT": "AT", "CHE": "CH", "NLD": "NL", "BEL": "BE", "FRA": "FR", "LUX": "LU",
        "DNK": "DK", "POL": "PL", "CZE": "CZ", "ITA": "IT", "LIE": "LI"}


def de_country(loc):
    c = str(loc.get("country") or loc.get("country_code") or "").upper()
    return ISO3.get(c, c[:2] if len(c) == 2 else c)


def de_coords(loc):
    c = loc.get("coordinates") or {}
    try:
        return float(c.get("latitude", c.get("lat"))), float(c.get("longitude", c.get("lon")))
    except (TypeError, ValueError):
        return None


def de_sites(brands):
    """All of Germany: per brand one OCPDB call (operator_name contains the brand), grouped into sites
    like the Worker's summariseDe (the same charger can come twice: operator feed and federal register;
    merged by EVSE id, a live status wins; sites on the other side of the road stay apart)."""
    locs, calls = {}, 0
    for b in brands:
        term = DE_OPERATOR.get(b["key"], b["key"])
        url = f"{OCPDB}?operator_name={urllib.parse.quote(term)}&limit={OCPDB_MAX}"
        try:
            data = get(url, timeout=120)
            calls += 1
        except Exception as e:
            log(f"DE {b['key']}: OCPDB failed:", e)
            continue
        items = data if isinstance(data, list) else (data.get("items") or [])
        if isinstance(data, dict):
            log(f"DE {b['key']}: answer keys {sorted(data.keys())}, total {data.get('total_count', data.get('count'))}")
        if len(items) >= OCPDB_MAX:
            log(f"DE {b['key']}: {len(items)} locations, at the page limit: some may be missing")
        ops, ccs = {}, {}
        mine = 0
        for loc in items:
            op = str((loc.get("operator") or {}).get("name") or "")
            ops[op] = ops.get(op, 0) + 1
            cc = de_country(loc)
            ccs[cc] = ccs.get(cc, 0) + 1
            if de_brand_of(loc, [b]) and de_coords(loc) and cc in DE_COUNTRIES:
                locs[str(loc.get("id"))] = (b["key"], loc)
                mine += 1
        log(f"DE {b['key']} (operator_name={term}): {len(items)} locations, {mine} of the brand; operators:",
            json.dumps(sorted(ops.items(), key=lambda x: -x[1])[:8], ensure_ascii=False), "countries:", json.dumps(ccs))

    # Group into sites: locations of one brand within 80 m, not on opposite sides of the road.
    def live_count(loc):
        return sum(1 for e in loc.get("evses") or [] if e.get("status") and e["status"] not in ("STATIC", "UNKNOWN"))
    order = sorted(locs.items(), key=lambda kv: (-live_count(kv[1][1]), int(kv[0]) if kv[0].isdigit() else 0))
    sites = []  # [brand, lat, lon, name, [locations]]
    for lid, (b, loc) in order:
        lat, lon = de_coords(loc)
        for s in sites:
            if s[0] == b and km(lat, lon, s[1], s[2]) <= 0.08 and not opposite_sides(s[3], loc.get("name")):
                s[4].append((lid, loc))
                break
        else:
            sites.append([b, lat, lon, loc.get("name") or "", [(lid, loc)]])

    out = {}
    for b, lat, lon, name, members in sites:
        by_id = {}
        for lid, loc in members:
            for i, e in enumerate(loc.get("evses") or []):
                st = e.get("status")
                if st in ("REMOVED", "PLANNED"):
                    continue
                eid = re.sub(r"[^A-Za-z0-9]", "", str(e.get("evse_id") or e.get("uid") or f"{lid}-{i}")).upper()
                live = bool(st) and st not in ("STATIC", "UNKNOWN")
                prev = by_id.get(eid)
                if prev and prev["live"]:
                    continue
                kw = max([0] + [(c.get("max_electric_power") or 0) / 1000 for c in e.get("connectors") or []])
                by_id[eid] = {"st": st, "live": live, "kw": kw}
        pts = [p for p in by_id.values() if p["kw"] >= FAST_KW and p["live"]]
        known = [p for p in pts if p["st"] in ("AVAILABLE", "OUTOFORDER", "INOPERATIVE", "CHARGING", "BLOCKED", "RESERVED")]
        if not known:
            continue
        free = sum(1 for p in pts if p["st"] == "AVAILABLE")
        key = "de:" + min((lid for lid, _ in members), key=lambda x: (len(x), x))
        out[key] = ({"b": b, "cc": de_country(members[0][1]), "lat": round(lat, 5), "lon": round(lon, 5), "n": name}, (free, len(pts)))
    return out, calls


# ------------------------------------------------------------------ store

def tile_of(lat, lon):
    return f"t_{math.floor(lat)}_{math.floor(lon)}.json"


def put(sites_by_tile, key, info, c, now, keep_days):
    tz = tz_of(info["cc"])
    local = now.astimezone(tz)
    day = local.strftime("%Y-%m-%d")
    slot = (local.hour * 60 + local.minute) // SLOT_MIN
    tile = sites_by_tile.setdefault(tile_of(info["lat"], info["lon"]), {})
    rec = tile.get(key) or {"d": {}}
    rec.update({"b": info["b"], "cc": info["cc"], "tz": str(tz.key), "lat": info["lat"], "lon": info["lon"],
                "n": info.get("n") or rec.get("n") or "", "t": c[1]})
    s = list(rec["d"].get(day, "." * SLOTS).ljust(SLOTS, "."))
    s[slot] = ALPHA[max(0, min(len(ALPHA) - 1, c[0]))]
    rec["d"][day] = "".join(s)
    tile[key] = rec


def prune(sites_by_tile, now, keep_days):
    for tile, sites in list(sites_by_tile.items()):
        for key, rec in list(sites.items()):
            first = (now.astimezone(ZoneInfo(rec.get("tz") or "Europe/Amsterdam")).date()
                     - datetime.timedelta(days=keep_days - 1)).isoformat()
            rec["d"] = {d: v for d, v in rec["d"].items() if d >= first}
            if not rec["d"]:
                del sites[key]
        if not sites:
            del sites_by_tile[tile]


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    state = args[0]
    opt = {args[i]: args[i + 1] for i in range(1, len(args) - 1, 2)}
    t0 = time.time()
    now = datetime.datetime.now(datetime.timezone.utc)
    cfg = load_config()
    if not cfg.get("on"):
        log("Occupancy is switched off on the usage page: nothing written")
        sys.exit(3)
    keep_days = int(cfg.get("keepDays") or 8)
    brands = [{"key": b["key"], "live_re": re.compile(b.get("live") or "(?!)", re.I),
               "evse_re": re.compile(b.get("evse") or "(?!)", re.I)} for b in cfg.get("brands") or []]
    followed = {b["key"] for b in brands}
    brand_sig = ",".join(sorted(followed))

    # What's stored so far
    sites_by_tile = {}
    for path in glob.glob(os.path.join(state, "t_*.json")):
        try:
            doc = json.load(open(path))
            sites = doc.get("sites", {})
            if (doc.get("at") or "") < "2026-11-24T18:30:00Z":
                # the first German test run (24 Nov 18:18 UTC) kept Swiss sites too, all marked DE
                sites = {k: v for k, v in sites.items() if not k.startswith("de:")}
            sites_by_tile[os.path.basename(path)] = sites
        except Exception as e:
            log("Unreadable", path, e)
    try:
        nl = json.load(open(os.path.join(state, "nl-sites.json")))
    except Exception:
        nl = {"at": None, "brands": "", "sites": {}}

    readings = {}
    # NL
    age_h = 1e9
    if nl.get("at"):
        age_h = (now - datetime.datetime.fromisoformat(nl["at"].replace("Z", "+00:00"))).total_seconds() / 3600
    discovered = False
    try:
        scan_calls = int(nl.get("scanCalls") or SCAN_CALLS)
        boxes = len(nl_boxes(nl.get("sites") or {}))
        if age_h > DISCOVER_H or nl.get("brands") != brand_sig or not nl.get("sites") or boxes >= scan_calls:
            before = PACE.calls
            found, failed = nl_scan(brands)
            if not failed:
                scan_calls = PACE.calls - before
            if found and not failed and (age_h > DISCOVER_H or nl.get("brands") != brand_sig or not nl.get("sites")):
                nl = {"at": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "brands": brand_sig, "scanCalls": scan_calls,
                      "sites": {sid: site for sid, (site, _) in found.items()}}
                discovered = True
            elif found:  # readings only (or an incomplete scan): add sites that showed up, drop none
                nl["sites"].update({sid: site for sid, (site, _) in found.items()})
            got = {sid: c for sid, (_, c) in found.items()}
            nl["scanCalls"] = scan_calls
            log(f"NL scan: {len(found)} sites of {brand_sig}, {failed} tiles failed, {scan_calls} calls")
        else:
            log(f"NL: {len(nl['sites'])} sites in {boxes} boxes (a full scan takes {scan_calls} calls)")
            got = nl_status(nl["sites"])
        for sid, c in got.items():
            b, lat, lon, name = nl["sites"][sid]
            if b in followed:
                readings[f"nl:{sid}"] = ({"b": b, "cc": "NL", "lat": lat, "lon": lon, "n": name}, c)
    except Exception as e:
        log("NL failed:", e)
    nl_count = sum(1 for k in readings if k.startswith("nl:"))

    fr = fr_sites(opt.get("--fr"), followed)
    pt = pt_sites(opt.get("--pt"), followed)
    readings.update(fr)
    readings.update(pt)
    try:
        de, de_calls = de_sites(brands)
    except Exception as e:
        log("DE failed:", e)
        de, de_calls = {}, 0
    readings.update(de)

    for key, (info, c) in readings.items():
        put(sites_by_tile, key, info, c, now, keep_days)
    prune(sites_by_tile, now, keep_days)

    # Write
    for path in glob.glob(os.path.join(state, "t_*.json")):
        if os.path.basename(path) not in sites_by_tile:
            os.remove(path)
    at = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    for tile, sites in sites_by_tile.items():
        with open(os.path.join(state, tile), "w") as f:
            json.dump({"v": 1, "at": at, "slotMin": SLOT_MIN, "sites": sites}, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(state, "nl-sites.json"), "w") as f:
        json.dump(nl, f, ensure_ascii=False, separators=(",", ":"))
    meta = {"at": at, "secs": round(time.time() - t0, 1), "brands": brand_sig, "keepDays": keep_days,
            "readings": {"NL": nl_count, "FR": len(fr), "PT": len(pt),
                         "DE": sum(1 for i, _ in de.values() if i["cc"] == "DE"),
                         "AT": sum(1 for i, _ in de.values() if i["cc"] == "AT")}, "ndwCalls": PACE.calls,
            "ocpdbCalls": de_calls,
            "discovery": discovered, "nlSites": len(nl.get("sites") or {}),
            "tiles": len(sites_by_tile), "sites": sum(len(s) for s in sites_by_tile.values())}
    with open(os.path.join(state, "meta.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))
    log("Done:", json.dumps(meta))
    if not readings:
        log("No readings at all")
        sys.exit(1)


if __name__ == "__main__":
    main()
