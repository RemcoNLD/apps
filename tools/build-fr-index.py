#!/usr/bin/env python3
"""Build data/fr-fast-sites.json from France's national charger file (IRVE).

Usage:  python3 tools/build-fr-index.py <static.csv> [dynamic.csv]

<static.csv>   "Base nationale consolidée IRVE - données statiques"
               https://transport.data.gouv.fr/resources/84013/download
[dynamic.csv]  optional, "… données dynamiques" (84098): only used for the coverage report.

Keeps fast charge points (>= 50 kW) of the app's brands in metropolitan France and groups
them into sites (same brand within 150 m). Licence Ouverte 2.0, source: transport.data.gouv.fr.
Standard library only.
"""
import csv, json, math, re, sys, os, datetime

FAST_KW = 50
MERGE_M = 150
BBOX = (-5.5, 41.2, 10.0, 51.3)  # lon/lat, metropolitan France incl. Corsica

# (key, EVSE prefix of id_pdc_itinerance, operator-name pattern). Prefix wins; name is the fallback.
# Keep in step with BRANDS in src/evailability-worker.js.
BRANDS = [
    ("ionity",   r"^FRIO[NY]",              r"ionity"),
    ("fastned",  r"^FR(FAS|FLA)",           r"fastned"),
    ("tesla",    r"^FR(TSL|TES)",           r"tesla"),
    ("enbw",     r"^FREBW",                 r"\benbw\b"),
    ("aral",     r"^FR(ARL|ARP)",           r"\baral\b"),
    ("shell",    r"^FR(SHE|TNM|SHL|SRS)",   r"shell|newmotion"),
    ("total",    r"^FR(HPC|TCB|TOT)",       r"\btotal\s*(energies|ev\s*charge)?\b"),
    ("electra",  r"^FRELC",                 r"\belectra\b"),
    ("izivia",   r"^FR(IZI|IZF|CDO)",       r"izivia|corri.?door"),
    ("powerdot", r"^FR(PD1|PWD)",           r"power ?dot"),
    ("allego",   r"^FR(ALL|EVC)",           r"allego"),
]
BRANDS = [(k, re.compile(p), re.compile(n, re.I)) for k, p, n in BRANDS]


def brand_of(pdc_id, operator):
    for k, p, _ in BRANDS:
        if p.match(pdc_id):
            return k
    for k, _, n in BRANDS:
        if n.search(operator):
            return k
    return None


def kw_of(v):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x / 1000 if x > 1000 else x  # a few publishers give watts


def metres(a, b):
    dx = (a[0] - b[0]) * math.cos(math.radians(a[1])) * 111320
    dy = (a[1] - b[1]) * 110540
    return math.hypot(dx, dy)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    static_path = sys.argv[1]
    dyn_path = sys.argv[2] if len(sys.argv) > 2 else None
    csv.field_size_limit(10**7)

    pdcs = {}
    with open(static_path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            pid = (r.get("id_pdc_itinerance") or "").strip()
            kw = kw_of(r.get("puissance_nominale"))
            if not pid or pid in pdcs or kw is None or kw < FAST_KW:
                continue
            b = brand_of(pid, r.get("nom_operateur") or "")
            if not b:
                continue
            try:
                lon, lat = float(r["consolidated_longitude"]), float(r["consolidated_latitude"])
            except (KeyError, TypeError, ValueError):
                continue
            if not (BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]):
                continue
            pdcs[pid] = dict(b=b, lon=lon, lat=lat, kw=kw,
                             st=r.get("id_station_itinerance") or pid,
                             name=(r.get("nom_station") or "").strip())

    # Group: first per station id, then stations of one brand within MERGE_M into one site.
    stations = {}
    for pid, p in pdcs.items():
        s = stations.setdefault((p["b"], p["st"]), dict(b=p["b"], pts=[], ids=[], kw=0, name=p["name"]))
        s["pts"].append((p["lon"], p["lat"]))
        s["ids"].append(pid)
        s["kw"] = max(s["kw"], p["kw"])
    sites, grid = [], {}
    for s in sorted(stations.values(), key=lambda s: -len(s["ids"])):
        lon = sorted(x for x, _ in s["pts"])[len(s["pts"]) // 2]
        lat = sorted(y for _, y in s["pts"])[len(s["pts"]) // 2]
        cell = (s["b"], round(lon * 200), round(lat * 200))  # ~0.005° cells
        hit = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for site in grid.get((s["b"], cell[1] + dx, cell[2] + dy), []):
                    if metres((site["lon"], site["lat"]), (lon, lat)) <= MERGE_M:
                        hit = site
        if hit:
            hit["ids"] += s["ids"]
            hit["kw"] = max(hit["kw"], s["kw"])
            continue
        site = dict(b=s["b"], lon=lon, lat=lat, kw=s["kw"], name=s["name"], ids=list(s["ids"]))
        sites.append(site)
        grid.setdefault(cell, []).append(site)

    sites.sort(key=lambda s: (s["b"], s["lat"], s["lon"]))
    out = {
        "built": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "source": os.path.basename(static_path),
        "licence": "Licence Ouverte 2.0, transport.data.gouv.fr",
        "fields": ["brand", "lat", "lon", "maxKw", "name", "pdcIds"],
        "sites": [[s["b"], round(s["lat"], 5), round(s["lon"], 5), round(s["kw"]), s["name"], sorted(s["ids"])] for s in sites],
    }
    os.makedirs("data", exist_ok=True)
    with open("data/fr-fast-sites.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    # Report
    per = {}
    for s in sites:
        d = per.setdefault(s["b"], [0, 0])
        d[0] += 1
        d[1] += len(s["ids"])
    print(f"{len(sites)} sites, {len(pdcs)} fast charge points, {os.path.getsize('data/fr-fast-sites.json')//1024} kB")
    for b, (n, k) in sorted(per.items()):
        print(f"  {b:9} {n:5} sites {k:6} points")
    if dyn_path:
        seen = {}
        with open(dyn_path, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                pid, t = r["id_pdc_itinerance"], r.get("horodatage") or ""
                if pid in pdcs and t > seen.get(pid, ""):
                    seen[pid] = t
        print("In the live feed (share of fast points):")
        for b in sorted(per):
            ids = [p for p, v in pdcs.items() if v["b"] == b]
            print(f"  {b:9} {100*sum(p in seen for p in ids)//max(1,len(ids)):3}%")


if __name__ == "__main__":
    main()
