#!/usr/bin/env python3
"""Germany index: every fast site (>= 50 kW, live status reported) of the app's brands in Germany, plus
the Austrian sites MobiData BW's OCPDB holds, as data/de-fast-sites.json.

The Worker's POST /extra-sites uses it as a second list of where chargers are, next to Open Charge Map
(like NDW in the Netherlands and the Belgian, French and Portuguese indexes): sites Open Charge Map
lacks still show along the route. Live status keeps coming from OCPDB (DE) and E-Control (AT) per site.

Run weekly by .github/workflows/de-index.yml (and by hand). Standard library only.

    python3 tools/build-de-index.py [OUT]           (default data/de-fast-sites.json)

Brands and their name patterns come from the Worker (GET /occupancy/config?all=1), so a brand added
to the Worker is picked up by itself; the operator_name to ask OCPDB for is DE_OPERATOR in
build-occupancy.py (else the brand key). One OCPDB call per brand (limit 1,000 locations each).

File: {built, source, licence, fields: [brand, cc, lat, lon, maxKw, name, n], sites: [...]}
"""
import datetime
import importlib.util
import json
import os
import re
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("occ", os.path.join(HERE, "build-occupancy.py"))
occ = importlib.util.module_from_spec(spec)
spec.loader.exec_module(occ)

FAST_KW = 50
SKIP = {"essent"}  # Dutch brand matched on "E.ON": in Germany that would label E.ON's own network as Essent
COUNTRIES = {"DE", "AT"}


def brands_from_worker():
    try:
        cfg = occ.get(f"{occ.WORKER}/occupancy/config?all=1", timeout=20)
    except Exception as e:
        occ.log("Worker config not reachable:", e)
        sys.exit(1)
    out = []
    for b in cfg.get("brands") or []:
        if b["key"] in SKIP:
            continue
        out.append({"key": b["key"], "live_re": re.compile(b.get("live") or "(?!)", re.I),
                    "evse_re": re.compile(b.get("evse") or "(?!)", re.I)})
    occ.log("Brands:", ", ".join(b["key"] for b in out))
    return out


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "data", "de-fast-sites.json")
    brands = brands_from_worker()
    if len(brands) < 5:
        occ.log("Fewer than 5 brands from the Worker (old Worker without ?all=1?): not writing")
        sys.exit(1)
    locs, failed = {}, 0
    for b in brands:
        term = occ.DE_OPERATOR.get(b["key"], b["key"])
        url = f"{occ.OCPDB}?operator_name={urllib.parse.quote(term)}&limit={occ.OCPDB_MAX}"
        try:
            data = occ.get(url, timeout=120)
        except Exception as e:
            occ.log(f"{b['key']}: OCPDB failed:", e)
            failed += 1
            continue
        items = data if isinstance(data, list) else (data.get("items") or [])
        mine = 0
        for loc in items:
            cc = occ.de_country(loc)
            if cc in COUNTRIES and occ.de_coords(loc) and occ.de_brand_of(loc, [b]):
                locs.setdefault(str(loc.get("id")), (b["key"], loc))
                mine += 1
        note = " (at the page limit: some may be missing)" if len(items) >= occ.OCPDB_MAX else ""
        occ.log(f"{b['key']} (operator_name={term}): {len(items)} locations, {mine} of the brand{note}")
    if failed > len(brands) // 2:
        occ.log(f"{failed} of {len(brands)} brands failed: not writing")
        sys.exit(1)

    # Group into sites like the occupancy job: one brand within 80 m, not on opposite sides of the road.
    order = sorted(locs.items(), key=lambda kv: int(kv[0]) if kv[0].isdigit() else 0)
    sites = []  # [brand, lat, lon, name, [loc]]
    for lid, (b, loc) in order:
        lat, lon = occ.de_coords(loc)
        for s in sites:
            if s[0] == b and occ.km(lat, lon, s[1], s[2]) <= 0.08 and not occ.opposite_sides(s[3], loc.get("name")):
                s[4].append(loc)
                break
        else:
            sites.append([b, lat, lon, loc.get("name") or "", [loc]])

    rows, per = [], {}
    for b, lat, lon, name, members in sites:
        pts = {}
        for loc in members:
            for i, e in enumerate(loc.get("evses") or []):
                st = e.get("status")
                if st in ("REMOVED", "PLANNED"):
                    continue
                kw = max([0] + [(c.get("max_electric_power") or 0) / 1000 for c in e.get("connectors") or []])
                eid = re.sub(r"[^A-Za-z0-9]", "", str(e.get("evse_id") or e.get("uid") or f"{loc.get('id')}-{i}")).upper()
                live = bool(st) and st not in ("STATIC", "UNKNOWN")
                if kw >= FAST_KW and (live or eid not in pts):
                    pts[eid] = (kw, live)
        fast = [kw for kw, live in pts.values() if live]
        if not fast:
            continue  # no live fast charger: no status to show either
        cc = occ.de_country(members[0])
        address = members[0].get("address") or ""
        city = members[0].get("city") or ""
        label = name or ", ".join(x for x in (address, city) if x)
        rows.append([b, cc, round(lat, 5), round(lon, 5), round(max(fast)), label[:80], len(fast)])
        per[f"{b} {cc}"] = per.get(f"{b} {cc}", 0) + 1
    rows.sort(key=lambda r: (r[0], r[2], r[3]))
    doc = {"built": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
           "source": "MobiData BW OCPDB (api.mobidata-bw.de/ocpdb), AFIR data",
           "licence": "see mobidata-bw.de (open data)",
           "fields": ["brand", "cc", "lat", "lon", "maxKw", "name", "n"], "sites": rows}
    with open(out_path, "w") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    occ.log(f"Done: {len(rows)} sites", json.dumps(dict(sorted(per.items())), ensure_ascii=False))


if __name__ == "__main__":
    main()
