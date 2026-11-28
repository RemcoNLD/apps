#!/usr/bin/env python3
"""Occupancy through the day: how many chargers were free at each charger site, every 5 minutes.

Run by .github/workflows/occupancy.yml (started by the Worker's timer every 5 minutes, GitHub's own
schedule as backup). Standard library only. Keeps 8 days (today and the same weekday a week ago), so
the app can draw today's line against last week's (like ParkPilot's "previous weeks" line).

    python3 tools/build-occupancy.py STATE_DIR [--fr fr-status.json] [--pt pt-status.json]

STATE_DIR holds the branch "occ" (read, then rewritten in place; the workflow force-pushes it as one
commit without history, like live-fr). The Worker's GET /occupancy/config says whether this is on and
which brands to follow (setting "occupancy" and "occupancyBrands" on the usage page); when off, this
writes nothing and exits with code 3, so the workflow skips publishing.

Sources (no keys needed):
  NL  since 28 Nov 2026 NDW's whole-country file (opendata.ndw.nu/charging_point_locations.geojson.gz, ~4.5 MB,
      every Dutch charge point with its live availabilities, refreshed about every minute): one download per
      run gives every followed site, and the site list itself. Only when it fails or is stale, and every 6 h
      as a check (counts compared, in the run log), the boxes below are asked.
      Before: NDW's live GeoJSON API (the Worker's source too). At most 1,000 features per call, so a scan of the
      whole country (tiles split until under 1,000) runs once a day to find the followed brands' fast
      sites (nl-sites.json) and to count NDW's features per 0.01 degree (nl-grid.json); the other runs
      ask planned boxes (nl_plan, 26 Nov 2026): the followed sites split into as few boxes as hold at most
      800 features each, so the land between motorway sites costs no calls; calls spread evenly over
      about two minutes (1-2 a second) and a run cut short resumes at the box it stopped at.
  FR  the France live snapshot (branch live-fr) with data/fr-fast-sites.json.
  PT  the Portugal live snapshot (branch live) with data/pt-fast-sites.json.
  DE  MobiData BW's Open ChargePoint DataBase (the Worker's German source, AFIR data; Germany, and
      the Austrian sites it holds):
      one call per followed brand with operator_name=<brand>, so the whole country in a few calls.
  AT  E-Control, through the Worker's GET /occupancy/at?part=N (its key is a Worker secret): the
      followed brands' Austrian sites, a few per call.

Files written (in STATE_DIR):
  t_<floor lat>_<floor lon>.json  {v, at, slotMin, sites: {key: {b, cc, tz, lat, lon, n, t, d: {date: slots}}}}
      slots: 288 characters, one per 5 minutes of the site's local day (00:00 first; until 25 Nov 2026
      96 per 15 minutes: those days are stretched to 288 on the first run, each reading kept 3 times):
      0-9 then a-z = number of free chargers (fast ones, the site's own count), "." = no reading.
      t = the site's latest total. Tiles of 1 x 1 degree keep each file small for the Worker.
  nl-sites.json  {at, brands, scanCalls, sites: {ndwId: [brand, lat, lon, name]}}
  nl-grid.json   {at, cell, cells: {"<floor lat*100>_<floor lon*100>": features}} from the last full scan
      (when a box per known site would take as many calls as the last full scan, scanCalls, every run
      is a full scan instead)
  meta.json      {at, secs, sites per country, NDW calls, discovery or not, pace}
  pace.json      per source (NDW, OCPDB, E-Control): how often it is read now and since when it is
      paused (see "Pace" below)
  log-<YYYY-MM-DD>.jsonl  one line per run (local date, Europe/Amsterdam), kept keepDays: per source
      whether it was due, its calls, how many worked at the 1st/2nd/3rd/4th try, failed, refused (429/503),
      seconds waited, why it stopped, readings (28 Nov 2026, Remco: "per bron terughalen wanneer die iets
      gedaan heeft en wat het resultaat was ... of er retry was en na hoeveel pogingen het wel gelukt is").
      Read by the usage page straight from raw.githubusercontent.com: no Worker call, no KV.

Retries (28 Nov 2026): NDW and OCPDB refused calls now and then at only 1 call a second, OCPDB even at
the first call of a run read every 30 minutes: GitHub's runners share their addresses with other users,
so a 429 there usually means "someone else on this address", not us. Since 28 Nov a refused call waits
(Retry-After + 1 s, else 1, 2, 4 s for NDW and 5, 10, 20 s for OCPDB, plus a little jitter) and is tried
again, at most 4 times, while the source's waiting budget for the run lasts (NDW 40 s, OCPDB 60 s); NDW
also halves its pace after each refusal and slowly speeds up again. Only when a call still fails after its
tries, the budget is used up, or a source asks to wait over a minute (or answers 503), the source stops for
the run and the pace below applies (Remco's rule: pause at least 10 minutes, then slower).

Pace (25 Nov 2026, Remco: "als er een rate limiting optreedt ... meteen 10 minuten langer pauzeren ...
pas weer de snelheid opvoeren als we het idee hebben dat het weer kan"): each source is read every
5 minutes. When it rate-limits (HTTP 429, a 503, the Worker saying E-Control limited it) or a fifth or
more of its calls in a run fail, the rest of that run leaves it alone, it pauses at least 10 minutes
(longer if it says Retry-After), and it steps down one level: 5 -> 10 -> 15 -> 30 minutes between
reads. After a calm hour at a level it steps one level faster again, back to 5; a source that pushes
back again needs a longer calm before speeding up. Since 28 Nov the calm needed is 30 minutes times the
number of push-backs in the last 6 hours (at most 2 hours), and a pause ends at the run that starts within
a minute of its end (before, a run starting 1 s early waited another full interval). FR and PT come from snapshots that are made anyway, so they're
read every run.
"""
import concurrent.futures
import datetime
import glob
import gzip
import json
import math
import os
import random
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
SLOT_MIN = 5
SLOTS = 24 * 60 // SLOT_MIN
PACE_LEVELS = [5, 10, 15, 30]             # minutes between reads of one source, fastest first
PAUSE_MIN = 10                            # at least this long without calls after being rate limited
CALM_MIN = 60                             # a calm hour at a level: one level faster (times the streak, max 4)
SOFT_RETRY_S = 5                          # NDW 429 asking to wait at most this long: obeyed once per run
SOFT_BURST_S = 3                          # 429s within this many seconds of that one belong to the same burst
PACE_V = 4                                # pace.json version: 2 = NDW calmer per second, 3 = planned boxes
                                          # and a steady pace (26 Nov 2026), 4 = retries (28 Nov 2026)
PAUSE_SLACK_S = 60                        # a pause ending within this many seconds of a run's start is over
CALM_STEP_MIN = 30                        # calm needed before speeding up: this x push-backs in RECENT_H
RECENT_H = 6
TRIES = 4                                 # attempts per call (the first plus 3 retries)
LONG_RA_S = 60                            # a Retry-After longer than this: stop the source for the run
RETRY = {"NDW": (1, 40), "OCPDB": (5, 60), "E-Control": (2, 20), "NDW file": (3, 30)}  # first wait (s, doubles), waiting budget per run
OCPDB_GAP_S = 2                           # between OCPDB calls (one per brand)
NDW_FILE = "https://opendata.ndw.nu/charging_point_locations.geojson.gz"
NDW_FILE_EVERY_H = 6                      # compare the file with box reads this often (28 Nov 2026)
NDW_FILE_FRESH_MIN = 15                   # the file's newest last_updated must be at most this old
LOG_TZ = "Europe/Amsterdam"
BOX_FEATURES = 800                        # plan NDW boxes to hold at most this many features (cap 1,000)
GRID = 100                                # feature density per 1/GRID degree (from the last full scan)
NDW_RUN_S = 120                           # spread a run's NDW calls over about this many seconds:
NDW_RATE = (1.0, 2.0)                     # between 1 and 2 calls a second (documented limit: 10)
NDW_THREADS = 2
FAIL_SHARE = 0.2                          # this share of failed calls (and at least 3) counts as overload
ALPHA = "0123456789abcdefghijklmnopqrstuvwxyz"
FAST_KW = 50
TZ = {"PT": "Europe/Lisbon", "DE": "Europe/Berlin", "AT": "Europe/Vienna"}  # else Central European time
DEFAULT_CONFIG = {"on": True, "keepDays": 8, "brands": [
    {"key": "ionity", "live": "ionity", "evse": r"^[A-Z]{2}\*?IO[NY]\*?"}]}


def log(*a):
    print(*a, flush=True)


def tz_of(cc):
    return ZoneInfo(TZ.get(cc, "Europe/Amsterdam"))


class RateLimited(Exception):
    """The source asks us to slow down (HTTP 429 or 503): no retries, the run leaves it alone."""
    def __init__(self, source, status, retry_after=0):
        super().__init__(f"{source}: HTTP {status}" + (f", Retry-After {retry_after} s" if retry_after else ""))
        self.source, self.status, self.retry_after = source, status, retry_after


def retry_after_s(e):
    try:
        return max(0, int(float(e.headers.get("Retry-After") or 0)))
    except (TypeError, ValueError, AttributeError):
        return 0


def get(url, timeout=60, tries=3, source="?"):
    """One GET as JSON. 429/503 raise RateLimited at once (the caller's Source decides about retrying);
    network trouble and 5xx are tried `tries` times here (calls through a Source use tries=1: it counts)."""
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
            if e.code in (429, 503):
                raise RateLimited(source, e.code, retry_after_s(e))
            if e.code < 500:
                raise
        except Exception as e:  # network trouble: try again
            last = e
        if i < tries - 1:
            time.sleep(2 + 4 * i)
    raise last


def short_err(e):
    """A few words for the run log: "429", "429 RA 1", "503", "HTTP 404", "timeout", "network"."""
    if isinstance(e, RateLimited):
        return f"{e.status}" + (f" RA {e.retry_after}" if e.retry_after else "")
    if isinstance(e, urllib.error.HTTPError):
        return f"HTTP {e.code}"
    t = str(e).lower()
    return "timeout" if "timed out" in t or "timeout" in t else (type(e).__name__ if type(e).__name__ != "URLError" else "network")[:24]


class Source:
    """One outside source in this run (28 Nov 2026): every call goes through call(), which retries a
    refused call (429/503) after a wait, and network trouble or a 5xx after 2, 4, 6 s, at most TRIES times,
    and keeps the counts for the run log: calls (attempts), worked at try 1..4, failed after all tries,
    refused answers, seconds waited, why it stopped. Once stopped (budget used up, Retry-After over a minute,
    a 503 twice), every further call of the run raises at once."""
    def __init__(self, name, first_wait=1, budget=40, tries=TRIES):
        self.name, self.first_wait, self.budget, self.tries = name, first_wait, budget, tries
        self.lock = threading.Lock()
        self.calls = self.failed = self.refused = self.skipped = 0
        self.ok = {}            # try number -> calls that worked at that try
        self.errs = {}          # short error -> count (every attempt that went wrong)
        self.waited = 0.0
        self.stopped = None
        self.first_bad = self.last_bad = None   # "HH:MM:SS 429 RA 1"

    def _bad(self, e):
        k = short_err(e)
        self.errs[k] = self.errs.get(k, 0) + 1
        stamp = f"{datetime.datetime.now(datetime.timezone.utc):%H:%M:%S} {k}"
        self.first_bad = self.first_bad or stamp
        self.last_bad = stamp

    def stop(self, e):
        with self.lock:
            self.stopped = self.stopped or e
        return self.stopped

    def call(self, fn, on_refused=None):
        for attempt in range(1, self.tries + 1):
            with self.lock:
                if self.stopped:
                    self.skipped += 1
                    raise self.stopped
                self.calls += 1
            try:
                r = fn()
                with self.lock:
                    self.ok[attempt] = self.ok.get(attempt, 0) + 1
                return r
            except RateLimited as e:
                with self.lock:
                    self.refused += 1
                    self._bad(e)
                    wait = max(e.retry_after + 1, self.first_wait * 2 ** (attempt - 1)) * (1 + 0.3 * random.random())
                    last = attempt == self.tries
                    if e.retry_after > LONG_RA_S or (e.status == 503 and self.errs.get("503", 0) > 1) \
                            or (not last and self.waited + wait > self.budget):
                        self.stopped = self.stopped or e
                        self.failed += 1
                        raise
                    if last:
                        self.failed += 1
                        raise
                    self.waited += wait
                if on_refused:
                    on_refused(e, wait)
                time.sleep(wait)
            except urllib.error.HTTPError as e:  # 4xx other than 429: no use trying again
                with self.lock:
                    self._bad(e)
                    self.failed += 1
                raise
            except Exception as e:  # network trouble or a 5xx
                with self.lock:
                    self._bad(e)
                    if attempt == self.tries:
                        self.failed += 1
                        raise
                time.sleep(2 * attempt)

    def summary(self):
        """For the run log: only what's not zero."""
        out = {"calls": self.calls}
        if self.ok:
            out["ok"] = {str(k): v for k, v in sorted(self.ok.items())}
        for k, v in (("fail", self.failed), ("refused", self.refused), ("skipped", self.skipped), ("wait", round(self.waited, 1))):
            if v:
                out[k] = v
        if self.errs:
            out["errs"] = self.errs
        if self.stopped:
            out["stop"] = str(self.stopped)
        if self.first_bad:
            out["bad"] = self.first_bad if self.first_bad == self.last_bad else f"{self.first_bad} … {self.last_bad}"
        return out


SRC = {k: Source(k, *RETRY[k]) for k in RETRY}


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
    """NDW: an even pace over all threads (1-2 calls a second, NDW_RATE; its documented limit is 10).
    History: 8 a second until 25 Nov 2026, 5 until 26 Nov, 3 on 26 Nov, then 1-2 with planned boxes; even at
    1 a second NDW now and then answers "429, Retry-After 1 s" (other users of the runner's address). Since
    28 Nov each refusal halves the pace (at most 1 call per 2 s) and holds every thread until the wait is
    over; every 20 calls that work speed it up by a fifth again, up to the planned rate. The retry itself is
    done by SRC["NDW"].call()."""
    def __init__(self, per_sec=2):
        self.gap, self.next, self.lock = 1.0 / per_sec, 0.0, threading.Lock()
        self.base = self.gap
        self.calls = 0
        self.good = 0
        self.slowest = self.gap

    def rate(self, per_sec):
        with self.lock:
            self.gap = self.base = 1.0 / per_sec
            self.slowest = max(self.slowest, self.gap)

    def wait(self):
        with self.lock:
            now = time.time()
            at = max(now, self.next)
            self.next = at + self.gap
            self.calls += 1
            self.good += 1
            if self.good >= 20 and self.gap > self.base:
                self.gap, self.good = max(self.base, self.gap / 1.2), 0
        if at > now:
            time.sleep(at - now)

    def slow(self, e, wait):
        """NDW refused a call: everyone waits, and the pace halves for a while."""
        with self.lock:
            self.gap = min(self.gap * 2, 2.0)
            self.slowest = max(self.slowest, self.gap)
            self.good = 0
            self.next = max(self.next, time.time() + wait)
        log(f"NDW: {e}: waiting {wait:.1f} s, then {1 / max(self.gap, 1e-3):.1f} calls/s for a while")


PACE = Pace()


def ndw(box):
    bbox = ",".join(f"{v:.6f}" for v in box)

    def once():
        PACE.wait()
        return get(f"{NDW}?bbox={bbox}", timeout=60, tries=1, source="NDW").get("features", [])
    return SRC["NDW"].call(once, on_refused=PACE.slow)


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
    """The whole country in tiles, split while NDW hits its 1,000 cap. Returns ({id: (site, counts)},
    failed tiles, grid): grid = features of all operators per 1/GRID-degree cell ("<lat*GRID>_<lon*GRID>"),
    which plans the boxes of the next runs (nl_plan)."""
    found, todo, depth_hit, grid = {}, [], 0, {}
    PACE.rate(NDW_RATE[1])
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
            if e is not SRC["NDW"].stopped or failed[0] == 1:
                log("NDW tile failed:", box, e)
            return box, depth, []

    with concurrent.futures.ThreadPoolExecutor(NDW_THREADS) as ex:
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
                    xy = (f.get("geometry") or {}).get("coordinates") or []
                    if len(xy) >= 2 and xy[0] is not None and xy[1] is not None:
                        cell = f"{math.floor(xy[1] * GRID)}_{math.floor(xy[0] * GRID)}"
                        grid[cell] = grid.get(cell, 0) + 1
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
    return found, failed[0], grid


def nl_boxes(sites):
    """The old way (until 26 Nov 2026), still used while there is no density grid: one small box per
    group of sites rounded to 0.01 degree."""
    boxes = {}
    for sid, (b, lat, lon, name) in sites.items():
        key = (round(lat, 2), round(lon, 2))
        boxes.setdefault(key, []).append((sid, lat, lon))
    return list(boxes.values())


def group_box(group):
    lats = [g[1] for g in group]
    lons = [g[2] for g in group]
    return (min(lons) - 0.004, min(lats) - 0.003, max(lons) + 0.004, max(lats) + 0.003)


def box_features(box, grid):
    """Expected NDW features in a box: the grid's cells, each counted for the part the box covers."""
    x0, y0, x1, y1 = box
    n = 0.0
    for i in range(math.floor(y0 * GRID), math.floor(y1 * GRID) + 1):
        fy = min(y1, (i + 1) / GRID) - max(y0, i / GRID)
        if fy <= 0:
            continue
        for j in range(math.floor(x0 * GRID), math.floor(x1 * GRID) + 1):
            c = grid.get(f"{i}_{j}")
            if c:
                fx = min(x1, (j + 1) / GRID) - max(x0, j / GRID)
                if fx > 0:
                    n += c * fx * fy * GRID * GRID
    return n


def split_group(group):
    """Two halves along the longer side (in km: a degree of longitude is ~0.62 of one of latitude here)."""
    lats = [g[1] for g in group]
    lons = [g[2] for g in group]
    axis = 2 if (max(lons) - min(lons)) * 0.62 > max(lats) - min(lats) else 1
    g = sorted(group, key=lambda x: x[axis])
    return g[:len(g) // 2], g[len(g) // 2:]


def nl_plan(sites, grid):
    """Boxes for the followed sites (26 Nov 2026, Remco: "slimmer, maar wel zo frequent mogelijk"): as
    few NDW calls as possible. Start with every site in one box and halve a group (along its longer side)
    while its box would hold more than BOX_FEATURES features of all operators (from the last full scan's
    grid) or more than 1 square degree. A box is the group's sites plus a small margin, so the empty land
    between motorway sites costs nothing. Returns a list of groups [(id, lat, lon)], in a fixed order."""
    pts = sorted((sid, lat, lon) for sid, (b, lat, lon, name) in sites.items())
    if not grid:
        return nl_boxes(sites)
    out, todo = [], [pts] if pts else []
    while todo:
        g = todo.pop()
        x0, y0, x1, y1 = group_box(g)
        if len(g) > 1 and ((x1 - x0) * (y1 - y0) > 1.0 or box_features((x0, y0, x1, y1), grid) > BOX_FEATURES):
            todo += list(split_group(g))
        else:
            out.append(g)
    out.sort(key=lambda g: (-round(g[0][1], 1), g[0][2]))  # north to south: a stable order for the cursor
    return out


def nl_status(sites, groups, cursor=0):
    """Counts for known sites, one NDW call per planned group. A group whose answer still hits the
    1,000 cap is halved and asked again. Starts at group `cursor` (where the last stopped run got to), so
    a run cut short by rate limiting doesn't always miss the same sites.
    Returns (counts, failed calls, next cursor)."""
    out, failed = {}, 0
    n = len(groups)
    order = [(cursor + k) % n for k in range(n)] if n else []
    PACE.rate(max(NDW_RATE[0], min(NDW_RATE[1], n / NDW_RUN_S)))

    def ask(group, depth=0):
        feats = ndw(group_box(group))
        if len(feats) >= NDW_MAX and len(group) > 1 and depth < 4:
            a, b = split_group(group)
            return ask(a, depth + 1) + ask(b, depth + 1)
        byid = {str(f.get("id")): f for f in feats}
        return [(sid, counts(byid[sid]) if sid in byid else None) for sid, _, _ in group]

    first_failed = None
    with concurrent.futures.ThreadPoolExecutor(NDW_THREADS) as ex:
        futs = [(k, ex.submit(ask, groups[k])) for k in order]
        for pos, (k, fu) in enumerate(futs):
            try:
                for sid, c in fu.result():
                    if c:
                        out[sid] = c
            except Exception as e:
                failed += 1
                if first_failed is None:
                    first_failed = k
                if e is not SRC["NDW"].stopped or failed == 1:
                    log("NDW call failed:", e)
    return out, failed, (first_failed if first_failed is not None else cursor)


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
        NOTES["FR"] = f"snapshot {snapshot_age_min(snap, 'at'):.0f} min old"
        return {}
    if snap.get("index") and snap["index"] != idx.get("built"):
        log("FR snapshot from another index version: skipped")
        NOTES["FR"] = "other index version"
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
        NOTES["PT"] = f"snapshot {snapshot_age_min(snap, 'pub'):.0f} min old"
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
    src = SRC["OCPDB"]
    for n, b in enumerate(brands):
        term = DE_OPERATOR.get(b["key"], b["key"])
        url = f"{OCPDB}?operator_name={urllib.parse.quote(term)}&limit={OCPDB_MAX}"
        if n:
            time.sleep(OCPDB_GAP_S)  # one brand after the other, not in a burst (28 Nov 2026)
        try:
            calls += 1
            data = src.call(lambda: get(url, timeout=120, tries=1, source="OCPDB"),
                            on_refused=lambda e, w: log(f"DE {b['key']}: OCPDB {e}: waiting {w:.0f} s, then once more"))
        except Exception as e:
            if src.stopped:
                log(f"DE {b['key']}: OCPDB still refusing, the other brands wait:", e)
                break
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


# ------------------------------------------------------------------ E-Control via the Worker (AT)

def at_sites():
    out, calls, part, parts = {}, 0, 0, 1
    while part < parts and part < 40:
        src = SRC["E-Control"]
        try:
            calls += 1
            data = src.call(lambda: get(f"{WORKER}/occupancy/at?part={part}", timeout=60, tries=1, source="E-Control"))
        except Exception as e:
            if src.stopped:
                log(f"AT part {part}: rate limited, the other parts wait:", e)
                break
            log(f"AT part {part} failed:", e)
            part += 1
            continue
        if not data.get("ok"):
            log("AT skipped:", data.get("reason"))
            break
        parts = int(data.get("parts") or 0)
        for x in data.get("sites") or []:
            out[f"at:{x['id']}"] = ({"b": x["b"], "cc": "AT", "lat": round(x["lat"], 5), "lon": round(x["lon"], 5),
                                     "n": x.get("n") or ""}, (int(x["free"]), int(x["total"])))
        part += 1
        if data.get("limited"):  # E-Control limited the Worker partway through this part
            log(f"AT part {part - 1}: E-Control rate limited the Worker, the other parts wait")
            SRC["E-Control"].stop(RateLimited("E-Control", 429))
            break
    log(f"AT: {len(out)} readings from {calls} Worker calls ({parts} parts)")
    return out, calls


# ------------------------------------------------------------------ pace per source

class Pacer:
    """How often each outside source is read (pace.json on the branch, see "Pace" at the top)."""
    SOURCES = ("NDW file", "NDW", "OCPDB", "E-Control")

    def __init__(self, path, now, fastest=PACE_LEVELS[0]):
        self.path, self.now = path, now
        # The usage page's "Occupancy: fastest interval": never read a source more often than that.
        self.levels = [m for m in PACE_LEVELS if m >= fastest] or PACE_LEVELS[-1:]
        self.why = {}
        try:
            self.state = json.load(open(path))
        except Exception:
            self.state = {}
        if self.state and self.state.get("v") != PACE_V:
            # 28 Nov 2026 (v4): refused calls are now retried, so the push-backs counted before (NDW at every
            # 30 with a streak of 27, OCPDB at 30 with 32) say little: NDW and OCPDB start again at every 10 min
            # with a clean slate (v2, v3 on 26 Nov restarted NDW at 15 for the same kind of reason).
            for src in ("NDW", "OCPDB"):
                r = self.state.get(src)
                if isinstance(r, dict):
                    r.update({"every": 10, "streak": 0, "recent": [], "calmSince": self._iso(now)})
                    r.pop("until", None)
                    log(f"{src}: refused calls are retried now, pace starts again at every 10 min")
        self.state["v"] = PACE_V
        for src, r in list(self.state.items()):
            if not isinstance(r, dict):
                continue
            if r.get("every") not in self.levels:
                r["every"] = min((m for m in self.levels if m >= (r.get("every") or 0)), default=self.levels[-1])

    def lighter(self, src, why):
        """The load on src shrank (fewer brands followed): one level faster at once. Rate limiting still
        slows it down again straight away (paused at least 10 minutes)."""
        r = self.rec(src)
        lvl = self.levels.index(r["every"])
        if lvl > 0:
            r["every"] = self.levels[lvl - 1]
            r["calmSince"] = self._iso(self.now)
            log(f"{src}: {why}, speeding up: every {r['every']} min")

    def _t(self, iso):
        try:
            return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))
        except Exception:
            return None

    def _iso(self, t):
        return t.strftime("%Y-%m-%dT%H:%M:%SZ")

    def rec(self, src):
        return self.state.setdefault(src, {"every": self.levels[0]})

    def due(self, src):
        """Read this source in this run? Not while paused (a pause ending within a minute counts as over),
        and not sooner than its interval (2 min slack: runs start a little later or earlier than every
        5 minutes). The reason it's skipped goes into the run log (self.why)."""
        r = self.rec(src)
        until, last = self._t(r.get("until") or ""), self._t(r.get("last") or "")
        if until and (until - self.now).total_seconds() > PAUSE_SLACK_S:
            log(f"{src}: paused until {r['until']} (rate limited), every {r['every']} min")
            self.why[src] = f"paused until {r['until'][11:16]}"
            return False
        if last and (self.now - last).total_seconds() < (r["every"] - 2) * 60:
            nxt = self._iso(last + datetime.timedelta(minutes=r["every"]))
            log(f"{src}: read every {r['every']} min for now, next after {nxt}")
            self.why[src] = f"every {r['every']} min, next {nxt[11:16]}"
            return False
        return True

    def done(self, src, s):
        """After reading src (a Source) in this run: slow down when it kept refusing or too many calls
        failed (after their retries), speed up after a calm period."""
        r = self.rec(src)
        r["last"] = self._iso(self.now)
        cut = self.now - datetime.timedelta(hours=RECENT_H)
        recent = [x for x in r.get("recent") or [] if (self._t(x) or cut) > cut]
        overload = s.stopped
        if not overload and s.calls >= 3 and s.failed >= FAIL_SHARE * s.calls:
            overload = f"{s.failed} of {s.calls} calls failed"
        lvl = self.levels.index(r["every"]) if r["every"] in self.levels else 0
        if overload:
            wait = max(PAUSE_MIN * 60, getattr(overload, "retry_after", 0) or 0)
            until = self.now + datetime.timedelta(seconds=wait)
            recent.append(self._iso(self.now))
            r.update({"every": self.levels[min(lvl + 1, len(self.levels) - 1)], "until": self._iso(until),
                      "calmSince": self._iso(until), "lastHit": self._iso(self.now), "why": str(overload),
                      "hits": int(r.get("hits") or 0) + 1, "recent": recent, "streak": len(recent)})
            log(f"{src}: slowing down ({overload}): paused until {r['until']}, then every {r['every']} min")
            return
        r["recent"], r["streak"] = recent, len(recent)
        calm = self._t(r.get("calmSince") or "")
        need = min(2 * CALM_MIN, CALM_STEP_MIN * max(1, len(recent)))
        if lvl > 0 and calm and (self.now - calm).total_seconds() >= need * 60:
            r["every"] = self.levels[lvl - 1]
            r["calmSince"] = self._iso(self.now)
            log(f"{src}: calm for {need} min, speeding up: every {r['every']} min")

    def save(self):
        with open(self.path, "w") as f:
            json.dump(self.state, f, separators=(",", ":"))


# ------------------------------------------------------------------ store

def stretch(days):
    """Days stored per 15 minutes (96 characters, before 25 Nov 2026) as per 5 minutes: each reading
    covers the 3 slots of its quarter, as it did in the chart."""
    out = {}
    for d, v in days.items():
        if v and len(v) < SLOTS and SLOTS % len(v) == 0:
            k = SLOTS // len(v)
            v = "".join(ch * k for ch in v)
        out[d] = v
    return out


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


HOLD_DAYS = 30  # a day not yet archived stays in the tiles this long at most (occ-profile.py archives it)


def folded_days(state):
    """Dates already archived on branch occ-archive (tools/occ-profile.py, 28 Nov 2026): only those may
    leave the tiles and the run log ("gooi geen data weg", Remco)."""
    try:
        return set(json.load(open(os.path.join(state, "profile.json"))).get("folded") or [])
    except Exception:
        return set()


def prune(sites_by_tile, now, keep_days, folded=frozenset()):
    for tile, sites in list(sites_by_tile.items()):
        for key, rec in list(sites.items()):
            today = now.astimezone(ZoneInfo(rec.get("tz") or "Europe/Amsterdam")).date()
            first = (today - datetime.timedelta(days=keep_days - 1)).isoformat()
            hold = (today - datetime.timedelta(days=HOLD_DAYS)).isoformat()
            rec["d"] = {d: v for d, v in rec["d"].items() if d >= first or (d not in folded and d >= hold)}
            if not rec["d"]:
                del sites[key]
        if not sites:
            del sites_by_tile[tile]


NOTES = {}  # source -> why it gave no readings (FR, PT), for the run log


# ------------------------------------------------------------------ NDW's whole-country file (28 Nov 2026)

def nl_from_file(brands, now):
    """All of the Netherlands from NDW's whole-country file (28 Nov 2026): one download of ~4.5 MB (75,000
    charge points, each with its live availabilities and last_updated; refreshed about every minute) instead of
    ~110 box calls that GitHub's shared addresses kept getting refused. Returns ({id: (site, counts)}, info)
    like nl_scan, or (None, info) when it can't be used (failed, or its newest update older than
    NDW_FILE_FRESH_MIN minutes): then the boxes are asked as before."""
    info = {}
    src = SRC["NDW file"]

    def once():
        req = urllib.request.Request(NDW_FILE, headers={"User-Agent": "EVailability-occupancy", "Accept-Encoding": "gzip"})
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read(100 * 1024 * 1024)
        return raw
    try:
        raw = src.call(lambda: http_bytes(once))
    except Exception as e:
        info["error"] = short_err(e)
        log("NDW file failed:", e)
        return None, info
    info["bytes"] = len(raw)
    try:
        if raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        doc = json.loads(raw)
    except Exception as e:
        info["error"] = f"unreadable: {str(e)[:60]}"
        src.failed += 1
        log("NDW file unreadable:", e)
        return None, info
    raw = None
    feats = (doc.get("features") if isinstance(doc, dict) else doc) or []
    newest = max((str((f.get("properties") or {}).get("last_updated") or "") for f in feats), default="")
    info["features"] = len(feats)
    info["newest"] = newest
    try:
        age = (now - datetime.datetime.fromisoformat(newest.replace("Z", "+00:00"))).total_seconds() / 60
    except Exception:
        age = 1e9
    info["ageMin"] = round(age, 1)
    if age > NDW_FILE_FRESH_MIN:
        info["error"] = f"newest update {age:.0f} min old"
        log(f"NDW file: newest update {newest} ({age:.0f} min old): using the boxes")
        return None, info
    found = {}
    for f in feats:
        c = counts(f)
        if not c:
            continue
        b = brand_of(f, brands)
        if not b:
            continue
        lon, lat = ((f.get("geometry") or {}).get("coordinates") or [None, None])[:2]
        if lat is None or lon is None:
            continue
        found[str(f.get("id"))] = ([b, round(lat, 5), round(lon, 5), (f.get("properties") or {}).get("address") or ""], c)
    log(f"NDW file: {len(feats)} charge points, newest update {newest}, {len(found)} fast sites of the followed brands")
    return found, info


def http_bytes(fn):
    """Run a download, turning HTTP 429/503 into RateLimited (like get())."""
    try:
        return fn()
    except urllib.error.HTTPError as e:
        if e.code in (429, 503):
            raise RateLimited("NDW file", e.code, retry_after_s(e))
        raise


# ------------------------------------------------------------------ run log (28 Nov 2026)

def write_runlog(state, now, line, keep_days, folded=frozenset()):
    """Append one line for this run to log-<local date>.jsonl; drop days older than keep_days once archived."""
    local = now.astimezone(ZoneInfo(LOG_TZ))
    path = os.path.join(state, f"log-{local:%Y-%m-%d}.jsonl")
    with open(path, "a") as f:
        f.write(json.dumps(line, ensure_ascii=False, separators=(",", ":")) + "\n")
    first = (local.date() - datetime.timedelta(days=keep_days - 1)).isoformat()
    for old in glob.glob(os.path.join(state, "log-*.jsonl")):
        day = os.path.basename(old)[4:14]
        if day < first and (day in folded or day < (local.date() - datetime.timedelta(days=HOLD_DAYS)).isoformat()):
            os.remove(old)


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
            if (doc.get("at") or "") < "2026-11-24T18:20:00Z":
                # the first German test run (24 Nov 18:18 UTC) kept Swiss sites too, all marked DE
                sites = {k: v for k, v in sites.items() if not k.startswith("de:")}
            if (doc.get("slotMin") or 15) != SLOT_MIN:
                for rec in sites.values():
                    rec["d"] = stretch(rec.get("d") or {})
            sites_by_tile[os.path.basename(path)] = sites
        except Exception as e:
            log("Unreadable", path, e)
    try:
        nl = json.load(open(os.path.join(state, "nl-sites.json")))
    except Exception:
        nl = {"at": None, "brands": "", "sites": {}}

    try:
        fastest = int(cfg.get("everyMin") or PACE_LEVELS[0])
    except Exception:
        fastest = PACE_LEVELS[0]
    pacer = Pacer(os.path.join(state, "pace.json"), now, fastest)
    if fastest != PACE_LEVELS[0]:
        log(f"Fastest interval set to {pacer.levels[0]} min")
    # Fewer brands than the last run: less load on NDW (boxes instead of a full scan, after one discovery
    # scan) and on OCPDB (one call per brand), so those try one level faster.
    prev_brands = set(filter(None, (pacer.state.get("brands") or "").split(",")))
    fewer = bool(prev_brands) and followed < prev_brands
    if fewer:
        pacer.lighter("OCPDB", f"{len(prev_brands)} → {len(followed)} brands")
    pacer.state["brands"] = brand_sig
    readings = {}
    # NL
    age_h = 1e9
    if nl.get("at"):
        age_h = (now - datetime.datetime.fromisoformat(nl["at"].replace("Z", "+00:00"))).total_seconds() / 3600
    discovered = False
    prev_nl_sig = nl.get("brands") or ""
    try:
        nl_grid = json.load(open(os.path.join(state, "nl-grid.json"))).get("cells") or {}
    except Exception:
        nl_grid = {}
    grid_changed = False
    got, nl_mode, nl_cursor, file_info, compare = {}, None, None, None, None
    # NL from the whole-country file first (28 Nov 2026); the boxes only when it can't be used, and every
    # NDW_FILE_EVERY_H hours as a check that both give the same counts.
    file_due = pacer.due("NDW file")
    if file_due:
        found, file_info = nl_from_file(brands, now)
        pacer.done("NDW file", SRC["NDW file"])
        if found:
            nl_mode = "file"
            changed = nl.get("brands") != brand_sig
            nl = {"at": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "brands": brand_sig, "scanCalls": nl.get("scanCalls") or SCAN_CALLS,
                  "sites": {sid: site for sid, (site, _) in found.items()}, "source": "file", "checkedAt": nl.get("checkedAt")}
            discovered = changed
            got = {sid: c for sid, (_, c) in found.items()}
    check_due = nl_mode == "file" and (not nl.get("checkedAt") or
        (now - datetime.datetime.fromisoformat(nl["checkedAt"].replace("Z", "+00:00"))).total_seconds() >= NDW_FILE_EVERY_H * 3600)
    nl_due = (nl_mode != "file" or check_due) and pacer.due("NDW")
    if nl_mode == "file" and not nl_due:
        pacer.why["NDW"] = "not needed: the file had everything"
    try:
        if not nl_due:
            raise StopIteration
        if nl_mode == "file":
            # The check: the same sites by boxes, counts compared with the file's.
            groups = nl_plan(nl["sites"], nl_grid)
            before = PACE.calls
            box_got, failed, _ = nl_status(nl["sites"], groups, 0)
            both = [sid for sid in box_got if sid in got]
            compare = {"compared": len(both), "same": sum(1 for sid in both if box_got[sid] == got[sid]), "boxCalls": PACE.calls - before}
            nl["checkedAt"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
            log(f"NDW check: {compare['same']} of {compare['compared']} sites have the same counts by boxes as in the file")
            raise StopIteration
        scan_calls = int(nl.get("scanCalls") or SCAN_CALLS)
        groups = nl_plan(nl.get("sites") or {}, nl_grid)
        boxes = len(groups)
        if age_h > DISCOVER_H or nl.get("brands") != brand_sig or not nl.get("sites") or not nl_grid or boxes >= scan_calls:
            nl_mode = "scan"
            if not nl_grid:
                log("NL: no density grid yet: a full scan now, then planned boxes")
            before = PACE.calls
            found, failed, grid = nl_scan(brands)
            if grid and not failed:
                nl_grid = grid
                grid_changed = True
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
            log(f"NL scan: {len(found)} sites of {brand_sig}, {failed} tiles failed, {scan_calls} calls, "
                f"grid {sum(nl_grid.values())} features in {len(nl_grid)} cells; "
                f"next runs: {len(nl_plan(nl['sites'], nl_grid))} planned boxes")
        else:
            nl_mode = "boxes"
            rec = pacer.rec("NDW")
            cursor = int(rec.get("cursor") or 0) % max(1, boxes)
            log(f"NL: {len(nl['sites'])} sites in {boxes} planned boxes (a full scan takes {scan_calls} calls)"
                + (f", starting at box {cursor}" if cursor else ""))
            before = PACE.calls
            got, failed, rec["cursor"] = nl_status(nl["sites"], groups, cursor)
            nl_cursor = [cursor, rec["cursor"], boxes]
            log(f"NL: {len(got)} readings from {PACE.calls - before} calls")
    except StopIteration:
        pass
    except Exception as e:
        log("NL failed:", e)
        SRC["NDW"].failed += 1
        SRC["NDW"].calls += 1
        SRC["NDW"]._bad(e)
    for sid, c in got.items():
        b, lat, lon, name = nl["sites"].get(sid) or (None, 0, 0, "")
        if b in followed:
            readings[f"nl:{sid}"] = ({"b": b, "cc": "NL", "lat": lat, "lon": lon, "n": name}, c)
    if nl_due:
        pacer.done("NDW", SRC["NDW"])
        old = set(filter(None, prev_nl_sig.split(",")))
        if discovered and not SRC["NDW"].stopped and old and followed < old \
                and len(nl_plan(nl["sites"], nl_grid)) < int(nl.get("scanCalls") or SCAN_CALLS):
            pacer.lighter("NDW", f"{len(nl['sites'])} Dutch sites in {len(nl_plan(nl['sites'], nl_grid))} boxes instead of a full scan")
    nl_count = sum(1 for k in readings if k.startswith("nl:"))

    fr = fr_sites(opt.get("--fr"), followed)
    pt = pt_sites(opt.get("--pt"), followed)
    readings.update(fr)
    readings.update(pt)
    de, de_calls = {}, 0
    oc_due = pacer.due("OCPDB")
    if oc_due:
        try:
            de, de_calls = de_sites(brands)
        except Exception as e:
            log("DE failed:", e)
            SRC["OCPDB"].failed += 1
            SRC["OCPDB"]._bad(e)
        pacer.done("OCPDB", SRC["OCPDB"])
    readings.update(de)
    at, at_calls = {}, 0
    at_due = pacer.due("E-Control")
    if at_due:
        try:
            at, at_calls = at_sites()
        except Exception as e:
            log("AT failed:", e)
            SRC["E-Control"].failed += 1
            SRC["E-Control"]._bad(e)
        pacer.done("E-Control", SRC["E-Control"])
    readings.update(at)

    for key, (info, c) in readings.items():
        put(sites_by_tile, key, info, c, now, keep_days)
    folded = folded_days(state)
    prune(sites_by_tile, now, keep_days, folded)


    # Write
    for path in glob.glob(os.path.join(state, "t_*.json")):
        if os.path.basename(path) not in sites_by_tile:
            os.remove(path)
    stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    for tile, sites in sites_by_tile.items():
        with open(os.path.join(state, tile), "w") as f:
            json.dump({"v": 1, "at": stamp, "slotMin": SLOT_MIN, "sites": sites}, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(state, "nl-sites.json"), "w") as f:
        json.dump(nl, f, ensure_ascii=False, separators=(",", ":"))
    if grid_changed:
        with open(os.path.join(state, "nl-grid.json"), "w") as f:
            json.dump({"at": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "cell": 1 / GRID, "cells": nl_grid}, f, separators=(",", ":"))
    pacer.save()
    secs = round(time.time() - t0, 1)

    # One line for this run in the day's log (28 Nov 2026): per source what it did and how it ended.
    def entry(name, due, src=None, read=None, of=None, **extra):
        r = pacer.state.get(name) if isinstance(pacer.state.get(name), dict) else {}
        e = {"due": 1} if due else {"due": 0, "why": pacer.why.get(name, "")}
        if due and src is not None:
            e.update(src.summary())
        if read is not None and due:
            e["read"] = read
        if of is not None and due:
            e["of"] = of
        if r.get("every"):
            e["every"] = r["every"]
        if r.get("until") and pacer._t(r["until"]) and pacer._t(r["until"]) > now:
            e["until"] = r["until"][11:16]
        e.update({k: v for k, v in extra.items() if v is not None})
        return e
    nl_of = sum(1 for v in (nl.get("sites") or {}).values() if v[0] in followed)
    line = {"t": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "secs": secs,
            "NDW file": entry("NDW file", file_due, SRC["NDW file"], nl_count if nl_mode == "file" else 0, nl_of if nl_mode == "file" else None,
                              **({k: file_info.get(k) for k in ("bytes", "features", "ageMin", "error")} if file_info else {})),
            "NDW": entry("NDW", nl_due, SRC["NDW"], (compare or {}).get("same") if compare else nl_count, (compare or {}).get("compared") if compare else nl_of,
                         mode="check" if compare else nl_mode, box=nl_cursor,
                         rate=round(1 / max(PACE.slowest, 1e-3), 2) if PACE.calls else None),
            "OCPDB": entry("OCPDB", oc_due, SRC["OCPDB"], sum(1 for i, _ in de.values() if i["cc"] == "DE"), len(brands)),
            "E-Control": entry("E-Control", at_due, SRC["E-Control"], len(at)),
            "FR": {"due": 1, "read": len(fr), **({"why": NOTES["FR"]} if "FR" in NOTES else {})},
            "PT": {"due": 1, "read": len(pt), **({"why": NOTES["PT"]} if "PT" in NOTES else {})}}
    write_runlog(state, now, line, keep_days, folded)

    meta = {"at": stamp, "secs": secs, "brands": brand_sig, "keepDays": keep_days,
            "readings": {"NL": nl_count, "FR": len(fr), "PT": len(pt),
                         "DE": sum(1 for i, _ in de.values() if i["cc"] == "DE"),
                         "AT": len(at) + sum(1 for i, _ in de.values() if i["cc"] == "AT")}, "ndwCalls": PACE.calls,
            "ndwRefused": SRC["NDW"].refused, "ocpdbCalls": de_calls, "workerAtCalls": at_calls,
            "discovery": discovered, "nlSites": len(nl.get("sites") or {}),
            "nlBoxes": len(nl_plan(nl.get("sites") or {}, nl_grid)),
            "tiles": len(sites_by_tile), "sites": sum(len(s) for s in sites_by_tile.values()),
            "pace": {src: {k: v for k, v in r.items() if k in ("every", "until", "lastHit", "why", "streak")}
                     for src, r in pacer.state.items() if isinstance(r, dict)}, "fastest": pacer.levels[0]}
    with open(os.path.join(state, "meta.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))
    log("Run log:", json.dumps(line, ensure_ascii=False))
    log("Done:", json.dumps(meta))
    if not readings and nl_due:
        log("No readings at all")
        sys.exit(1)
    if not readings:
        log("No readings: the sources are paused or not due in this run")


if __name__ == "__main__":
    main()
