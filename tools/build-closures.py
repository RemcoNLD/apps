#!/usr/bin/env python3
"""Planned road closures for EVailability -> data/closures.json (run by .github/workflows/closures.yml).

NL: NDW open data (DATEX II files on opendata.ndw.nu).  DE: Autobahn GmbH API (verkehr.autobahn.de).
Skips unless the interval set on the admin page has passed (FORCE=true always runs).

Keeps full closures (NL: whole road or one carriageway; DE: CLOSURE) active now or within WINDOW_DAYS,
with their time windows and lines in the direction of travel. Stats per run in data/closures-probe/stats.json.
"""
import gzip, io, json, os, re, sys, time, urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

WORKER = "https://ionity.remco-dv.workers.dev"
NDW_INDEX = "https://opendata.ndw.nu/"
AUTOBAHN = "https://verkehr.autobahn.de/o/autobahn"
OUT = "data/closures.json"
PROBE = "data/closures-probe"
UA = {"User-Agent": "EVailability closures job (github.com/RemcoNLD/apps)"}


def get(url, timeout=60):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
    if url.endswith(".gz") or data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    return data


def now():
    return datetime.now(timezone.utc)


def due():
    if os.environ.get("FORCE") == "true":
        return True, "forced"
    hours = 12
    try:
        hours = int(json.loads(get(f"{WORKER}/closures/schedule", 20)).get("hours") or 12)
    except Exception as e:
        print("Interval not readable, using 12 h:", e)
    try:
        last = json.load(open(OUT)).get("generatedAt")
        age = (now() - datetime.fromisoformat(last)).total_seconds() / 3600
    except Exception:
        return True, "no earlier data"
    # Half an hour slack: GitHub's schedule often starts a few minutes late.
    if age < hours - 0.5:
        return False, f"last update {age:.1f} h ago, interval {hours} h"
    return True, f"last update {age:.1f} h ago, interval {hours} h"


def local(tag):
    return tag.rsplit("}", 1)[-1]


# ------------------------------------------------------------------ shared
WINDOW_DAYS = 8          # keep closures that are active now or start within this many days
CET = None
try:
    from zoneinfo import ZoneInfo
    CET = ZoneInfo("Europe/Berlin")
except Exception:
    pass


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def parse_iso(t):
    try:
        return datetime.fromisoformat(t.replace("Z", "+00:00"))
    except Exception:
        return None


def simplify(line, tol=0.00025):
    """Douglas-Peucker on [lon, lat] (tolerance ~20 m), rounded to 5 decimals."""
    if len(line) < 3:
        return [[round(x, 5), round(y, 5)] for x, y in line]
    def dist(p, a, b):
        (x, y), (x1, y1), (x2, y2) = p, a, b
        dx, dy = x2 - x1, y2 - y1
        if dx == dy == 0:
            return ((x - x1) ** 2 + (y - y1) ** 2) ** 0.5
        t = max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
        return ((x - x1 - t * dx) ** 2 + (y - y1 - t * dy) ** 2) ** 0.5
    keep = [False] * len(line)
    keep[0] = keep[-1] = True
    stack = [(0, len(line) - 1)]
    while stack:
        i, j = stack.pop()
        best, k = 0, None
        for m in range(i + 1, j):
            d = dist(line[m], line[i], line[j])
            if d > best:
                best, k = d, m
        if k is not None and best > tol:
            keep[k] = True
            stack += [(i, k), (k, j)]
    return [[round(p[0], 5), round(p[1], 5)] for p, f in zip(line, keep) if f]


def in_window(periods, now_):
    horizon = now_.timestamp() + WINDOW_DAYS * 86400
    return [p for p in periods if p[1].timestamp() > now_.timestamp() and p[0].timestamp() < horizon]


# ------------------------------------------------------------------ NL (NDW)
NDW_FILES = ("planningsfeed_wegwerkzaamheden_en_evenementen.xml.gz", "tijdelijke_verkeersmaatregelen_afsluitingen.xml.gz")
NDW_CLOSED = ("roadClosed", "carriagewayClosures")
NDW_CARRIAGEWAYS = (None, "mainCarriageway", "connectingCarriageway")


def first_text(el, name):
    for x in el.iter():
        if local(x.tag) == name and (x.text or "").strip():
            return x.text.strip()
    return None


def ndw_record(rec, situation_id, stats):
    kind = next((v for k, v in rec.attrib.items() if local(k) == "type"), "")
    if not kind.endswith("RoadOrCarriagewayOrLaneManagement"):
        return None
    mtype = first_text(rec, "roadOrCarriagewayOrLaneManagementType")
    stats["type:" + str(mtype)] = stats.get("type:" + str(mtype), 0) + 1
    if mtype not in NDW_CLOSED:
        return None
    # Only for some vehicles (lorries, height limits): not a closure for a car.
    vtypes = {x.text for x in rec.iter() if local(x.tag) == "vehicleType" and x.text}
    if vtypes - {"anyVehicle", "car"} or any(local(x.tag) in ("heightCharacteristic", "weightCharacteristic", "lengthCharacteristic") for x in rec.iter()):
        stats["skip:vehicles"] = stats.get("skip:vehicles", 0) + 1
        return None
    status = first_text(rec, "operatorActionStatus")
    if status in ("terminated", "rejected"):
        return None
    lines, cws = [], set()
    for loc in rec.iter():
        if local(loc.tag) != "location":
            continue
        cw = first_text(loc, "carriageway")
        pos = first_text(loc, "posList")
        if not pos:
            continue
        cws.add(cw)
        if cw not in NDW_CARRIAGEWAYS:
            continue
        v = [float(x) for x in pos.split()]
        lines.append(simplify([[v[i + 1], v[i]] for i in range(0, len(v) - 1, 2)]))
    if not lines:
        stats["skip:no-main-line"] = stats.get("skip:no-main-line", 0) + 1
        return None
    periods = []
    for vp in rec.iter():
        if local(vp.tag) == "validPeriod":
            a, b = parse_iso(first_text(vp, "startOfPeriod") or ""), parse_iso(first_text(vp, "endOfPeriod") or "")
            if a and b:
                periods.append((a, b))
    if not periods:
        a, b = parse_iso(first_text(rec, "overallStartTime") or ""), parse_iso(first_text(rec, "overallEndTime") or "2099-01-01T00:00:00Z")
        if a and b:
            periods.append((a, b))
    periods = in_window(periods, now())
    if not periods:
        stats["skip:time"] = stats.get("skip:time", 0) + 1
        return None
    src = first_text(rec, "value") or ""
    comment = ""
    for c in rec.iter():
        if local(c.tag) == "generalPublicComment":
            comment = first_text(c, "value") or ""
            break
    return {
        "id": rec.attrib.get("id") or situation_id, "full": mtype == "roadClosed",
        "road": first_text(rec, "roadOrJunctionNumber"), "src": src[:60], "text": comment[:300],
        "periods": [[iso(a), iso(b)] for a, b in periods[:20]], "lines": lines,
    }


def ndw():
    out, stats = [], {}
    for name in NDW_FILES:
        raw = get(NDW_INDEX + name, 180)
        stats[name + ":bytes"] = len(raw)
        for _, el in ET.iterparse(io.BytesIO(raw), events=("end",)):
            if local(el.tag) != "situation":
                continue
            sid = el.attrib.get("id", "")
            for rec in el:
                if local(rec.tag) == "situationRecord":
                    r = ndw_record(rec, sid, stats)
                    if r:
                        r["file"] = "planning" if name.startswith("planning") else "measures"
                        out.append(r)
            el.clear()
    # The same closure can come in both files: keep one per identical line + times.
    seen, uniq = set(), []
    for r in out:
        key = (json.dumps(r["lines"]), json.dumps(r["periods"]))
        if key not in seen:
            seen.add(key)
            uniq.append(r)
    stats["kept"], stats["duplicates"] = len(uniq), len(out) - len(uniq)
    return uniq, stats


# ------------------------------------------------------------------ DE (Autobahn GmbH)
DE_TYPES = ("CLOSURE",)   # full closures; CLOSURE_ENTRY_EXIT (ramps) and lorry-only ones left out for now
D = r"(\d\d)\.(\d\d)\.(\d\d)"
T = r"(\d\d):(\d\d)"


def de_dt(d, m, y, hh, mm):
    day = datetime(2000 + int(y), int(m), int(d), tzinfo=CET or timezone.utc)
    return (day + timedelta(hours=int(hh), minutes=int(mm))).astimezone(timezone.utc)


def de_periods(text):
    """Time windows from the German description text (local time)."""
    out = []
    for g in re.findall(D + r" von " + T + r" bis " + T, text):
        a = de_dt(*g[0:3], *g[3:5]); b = de_dt(*g[0:3], *g[5:7])
        out.append((a, b if b > a else b + timedelta(days=1)))  # "von 22:00 bis 05:00" runs overnight
    for g in re.findall(D + r",? " + T + r" (?:Uhr )?bis zum " + D + r",? " + T, text):
        out.append((de_dt(*g[0:3], *g[3:5]), de_dt(*g[5:8], *g[8:10])))
    for g in re.findall(r"Beginn: " + D + r" um " + T + r" Uhr\s*Ende: " + D + r" um " + T, text):
        out.append((de_dt(*g[0:3], *g[3:5]), de_dt(*g[5:8], *g[8:10])))
    return out


def autobahn():
    roads = json.loads(get(AUTOBAHN + "/", 30)).get("roads", [])
    out, stats, unparsed = [], {"roads": len(roads)}, []
    for road in roads:
        rid = urllib.request.quote(road.strip())
        try:
            data = json.loads(get(f"{AUTOBAHN}/{rid}/services/closure", 30))
        except Exception as e:
            stats["errors"] = stats.get("errors", 0) + 1
            continue
        for c in data.get("closure", []):
            t = c.get("display_type")
            stats["type:" + str(t)] = stats.get("type:" + str(t), 0) + 1
            if t not in DE_TYPES:
                continue
            text = " ".join(c.get("description") or [])
            periods = de_periods(text)
            if not periods:
                st = parse_iso(c.get("startTimestamp") or "")
                end = re.search(r"Ende der Gesamtmaßnahme: " + D, text)
                if st and end:
                    periods = [(st, de_dt(*end.groups(), 23, 59))]
                elif len(unparsed) < 10:
                    unparsed.append(text[:400])
            periods = in_window(periods, now())
            if not periods:
                stats["skip:time"] = stats.get("skip:time", 0) + 1
                continue
            geo = (c.get("geometry") or {}).get("coordinates") or []
            if len(geo) < 2:
                continue
            imp = c.get("impact") or {}
            out.append({
                "id": c.get("identifier"), "full": False, "road": road.strip(),  # one direction (lines run the way it is driven)
                # title "A1 | Dortmund/Unna - Kamener Kreuz": junctions in the order you drive them
                "between": ((c.get("title") or "").split("|", 1)[-1]).strip(), "dir": (c.get("subtitle") or "").strip(),
                "text": text[:300], "periods": [[iso(a), iso(b)] for a, b in periods[:20]], "lines": [simplify(geo)],
            })
        time.sleep(0.2)
    stats["kept"] = len(out)
    stats["unparsedTimes"] = unparsed
    return out, stats


def main():
    ok, why = due()
    print("Due:" if ok else "Skip:", why)
    if not ok:
        return
    out = {"generatedAt": now().isoformat(timespec="seconds"), "sources": {}, "closures": []}
    for key, fn in (("nl", ndw), ("de", autobahn)):
        try:
            items, info = fn()
            for i in items:
                i["country"] = key.upper()
            out["closures"] += items
            out["sources"][key] = {"ok": True, "count": len(items)}
            os.makedirs(PROBE, exist_ok=True)
            json.dump(info, open(f"{PROBE}/stats-{key}.json", "w"), indent=1, ensure_ascii=False)
        except Exception as e:
            out["sources"][key] = {"ok": False, "count": 0, "error": str(e)[:200]}
        print(key, out["sources"][key].get("count"), out["sources"][key].get("error", ""))
    os.makedirs("data", exist_ok=True)
    # Municipal streets (most NL records, ~2 MB) go in a separate file the app doesn't load (yet).
    local_ = [c for c in out["closures"] if c["country"] == "NL" and (c.get("src") or "").startswith("Gemeente")]
    out["closures"] = [c for c in out["closures"] if c not in local_]
    if "nl" in out["sources"] and out["sources"]["nl"]["ok"]:
        out["sources"]["nl"]["count"] = len(out["closures"]) - sum(1 for c in out["closures"] if c["country"] != "NL")
        out["sources"]["nl"]["municipal"] = len(local_)
    json.dump(out, open(OUT, "w"), separators=(",", ":"), ensure_ascii=False)
    json.dump({"generatedAt": out["generatedAt"], "closures": local_}, open("data/closures-local.json", "w"),
              separators=(",", ":"), ensure_ascii=False)


if __name__ == "__main__":
    sys.exit(main())
