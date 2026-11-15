#!/usr/bin/env python3
"""Planned road closures for EVailability -> data/closures.json (run by .github/workflows/closures.yml).

NL: NDW open data (DATEX II files on opendata.ndw.nu).  DE: Autobahn GmbH API (verkehr.autobahn.de).
Skips unless the interval set on the admin page has passed (FORCE=true always runs).

First version: also writes small raw samples to data/closures-probe/ so the parsing can be
tuned (direction, start/end, full closure or not). Remove the probe once the parsing is right.
"""
import gzip, io, json, os, re, sys, time, urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

WORKER = "https://ionity.remco-dv.workers.dev"
NDW_INDEX = "https://opendata.ndw.nu/"
# Files that may hold closures; the probe lists all files so names can be corrected.
NDW_WANTED = ("wegwerkzaamheden", "afsluiting", "planningsfeed", "statusberichten", "verkeersmaatregel")
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


# ------------------------------------------------------------------ NL (NDW)
def ndw_files():
    html = get(NDW_INDEX, 30).decode("utf-8", "replace")
    return sorted(set(re.findall(r'href="([^"?/][^"]*\.(?:xml|gz|zip|json))"', html)))


def ndw_parse(root):
    """Best effort: one entry per situationRecord with times, points and closure hints."""
    out = []
    for rec in root.iter():
        if local(rec.tag) != "situationRecord":
            continue
        kind = next((v for k, v in rec.attrib.items() if local(k) == "type"), "")
        texts = {}
        pts = []
        for el in rec.iter():
            n = local(el.tag)
            t = (el.text or "").strip()
            if n in ("latitude", "longitude") and t:
                pts.append((n, float(t)))
            elif n == "posList" and t:
                v = [float(x) for x in t.split()]
                pts += [("latitude", v[i]) if i % 2 == 0 else ("longitude", v[i]) for i in range(len(v))]
            elif t and n in ("overallStartTime", "overallEndTime", "roadOrCarriagewayOrLaneManagementType",
                             "complianceOption", "alertCDirectionCoded", "directionBoundOnLinearSection",
                             "directionRelativeOnLinearSection", "roadNumber", "roadName", "probabilityOfOccurrence",
                             "validityStatus", "roadworksType", "roadMaintenanceType", "carriageway", "lane"):
                texts.setdefault(n, t)
        line = []
        lat = None
        for n, v in pts:
            if n == "latitude":
                lat = v
            elif lat is not None:
                line.append([round(v, 5), round(lat, 5)])
                lat = None
        out.append({"id": rec.attrib.get("id", ""), "kind": kind, **texts, "points": line[:50]})
    return out


def ndw():
    files = ndw_files()
    os.makedirs(PROBE, exist_ok=True)
    open(f"{PROBE}/ndw-files.txt", "w").write("\n".join(files) + "\n")
    picked = [f for f in files if any(w in f.lower() for w in NDW_WANTED)]
    records, notes = [], {}
    for name in picked:
        try:
            raw = get(NDW_INDEX + name, 120)
            tags, types = {}, {}
            for _, el in ET.iterparse(io.BytesIO(raw), events=("start",)):
                n = local(el.tag)
                tags[n] = tags.get(n, 0) + 1
                for k, v in el.attrib.items():
                    if local(k) == "type":
                        types[v] = types.get(v, 0) + 1
            root = ET.fromstring(raw)
            recs = ndw_parse(root)
            for r in recs:
                r["file"] = name
            records += recs
            stem = re.sub(r"\W+", "_", name)
            open(f"{PROBE}/ndw-{stem}-head.xml", "wb").write(raw[:150000])
            json.dump({"bytes": len(raw), "records": len(recs), "types": types, "tags": tags},
                      open(f"{PROBE}/ndw-{stem}-tags.json", "w"), indent=1, sort_keys=True)
            notes[name] = {"bytes": len(raw), "records": len(recs)}
        except Exception as e:
            notes[name] = {"error": str(e)[:200]}
    json.dump({"picked": notes, "sample": records[:40]}, open(f"{PROBE}/ndw-parsed.json", "w"), indent=1)
    closed = [r for r in records if "closed" in r.get("roadOrCarriagewayOrLaneManagementType", "").lower()
              or "closure" in r.get("roadOrCarriagewayOrLaneManagementType", "").lower()]
    return closed, notes


# ------------------------------------------------------------------ DE (Autobahn GmbH)
def autobahn():
    roads = json.loads(get(AUTOBAHN + "/", 30)).get("roads", [])
    items, samples, errors = [], [], {}
    for road in roads:
        rid = urllib.request.quote(road.strip())
        try:
            data = json.loads(get(f"{AUTOBAHN}/{rid}/services/closure", 30))
        except Exception as e:
            errors[road] = str(e)[:120]
            continue
        for c in data.get("closure", []):
            if len(samples) < 12:
                samples.append(c)
            geo = (c.get("geometry") or {}).get("coordinates") or []
            items.append({
                "id": c.get("identifier"), "road": road.strip(), "title": c.get("title"), "subtitle": c.get("subtitle"),
                "blocked": c.get("isBlocked"), "future": c.get("future"), "type": c.get("display_type"),
                "start": c.get("startTimestamp"), "text": " ".join(c.get("description") or [])[:600],
                "points": [[round(p[0], 5), round(p[1], 5)] for p in geo[:50]],
            })
        time.sleep(0.2)
    os.makedirs(PROBE, exist_ok=True)
    json.dump({"roads": len(roads), "errors": errors, "samples": samples}, open(f"{PROBE}/de-samples.json", "w"),
              indent=1, ensure_ascii=False)
    return items, {"roads": len(roads), "errors": len(errors)}


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
            out["sources"][key] = {"ok": True, "count": len(items), "info": info}
        except Exception as e:
            out["sources"][key] = {"ok": False, "count": 0, "error": str(e)[:200]}
        print(key, out["sources"][key].get("count"), out["sources"][key].get("error", ""))
    os.makedirs("data", exist_ok=True)
    json.dump(out, open(OUT, "w"), separators=(",", ":"), ensure_ascii=False)


if __name__ == "__main__":
    sys.exit(main())
