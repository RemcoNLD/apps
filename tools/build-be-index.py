#!/usr/bin/env python3
"""Build data/be-fast-sites.json from Belgium's DATEX II locations feed (Eco-Movement).

Usage:  python3 tools/build-be-index.py <page.json> [page.json ...]

Each page is one answer of GET https://nap-be.eco-movement.com/datex2/v1/locations?offset=N
(1,000 sites per page, header Authorization: Bearer <token>). Pass all pages.

Keeps fast DC charge points (>= 50 kW): the app's brands, and other operators as "other". One site in the feed = one index site.
The EVSE ids are what the Worker asks /datex2/v1/status/{evse_id} for, one stall at a time.
Standard library only.
"""
import json, re, sys, os, datetime

FAST_KW = 50
BBOX = (2.4, 49.4, 6.5, 51.6)  # lon/lat, Belgium with a margin

# (key, EVSE prefix, operator-name pattern). Prefix wins; name is the fallback.
# Keep in step with BRANDS in src/evailability-worker.js.
BRANDS = [
    ("ionity",   r"^BE\*?IO[NY]",           r"ionity"),
    ("fastned",  r"^BE\*?(FLA|FAS)",        r"fastned"),
    ("tesla",    r"^BE\*?(TSL|TES)",        r"tesla"),
    ("enbw",     r"^BE\*?EBW",              r"\benbw\b"),
    ("aral",     r"^BE\*?(ARL|ARP)",        r"\baral\b"),
    ("shell",    r"^BE\*?(SHE|TNM|SHL|SRS)", r"shell|newmotion"),
    ("total",    r"^(BE\*?TCB|CU-)",        r"\btotal\s*(energies|ev\s*charge)?\b"),
    ("electra",  r"^BE\*?EL[CD]",           r"\belectra\b"),
    ("izivia",   r"^BE\*?(IZI|CDO)",        r"izivia|corri.?door"),
    ("powerdot", r"^BE\*?(PD1|PWD)",        r"power ?dot"),
    ("allego",   r"^(BE|NL)\*?ALL",         r"allego"),
]
BRANDS = [(k, re.compile(p, re.I), re.compile(n, re.I)) for k, p, n in BRANDS]


def text(v):
    try:
        return v["values"][0]["value"].strip()
    except (KeyError, IndexError, TypeError, AttributeError):
        return ""


def brand_of(operator, evse_ids):
    for k, _, n in BRANDS:
        if n.search(operator):
            return k
    for k, p, _ in BRANDS:
        if any(p.match(i) for i in evse_ids):
            return k
    return None


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    seen, sites, total_sites, pages = set(), [], 0, 0
    for path in sys.argv[1:]:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        pages += 1
        for table in data["aegiEnergyInfrastructureTablePublication"].get("energyInfrastructureTable", []):
            for s in table.get("energyInfrastructureSite", []):
                total_sites += 1
                if s["idG"] in seen:
                    continue
                seen.add(s["idG"])
                operator = text(s.get("energyDistributor", {}).get("afacAnOrganisation", {}).get("name"))
                try:
                    c = s["entrance"][0]["locAreaLocation"]["coordinatesForDisplay"]
                    lat, lon = float(c["latitude"]), float(c["longitude"])
                except (KeyError, IndexError, TypeError, ValueError):
                    continue
                if not (BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]):
                    continue
                ids, kws, kw = [], {}, 0
                for st in s.get("energyInfrastructureStation", []):
                    for rp in st.get("refillPoint", []):
                        p = rp.get("aegiElectricChargingPoint") or {}
                        pkw = max([0] + [x / 1000 for x in p.get("availableChargingPower", []) if isinstance(x, (int, float))])
                        if pkw < FAST_KW or (p.get("currentType") or {}).get("value") != "dc" or not p.get("idG"):
                            continue
                        # The official EVSE id (on the connector) is what /status/{evse_id} expects; for most
                        # operators it differs from the feed's own id (Circle K: 75431*236544 vs
                        # BE*CKE*EXB00563205*2). Kept as "evse|feedId" so the Worker can fall back to the feed id.
                        evse = next((x.get("identifier") for k in p.get("connector", []) for x in k.get("externalIdentifier", [])
                                     if (x.get("typeOfIdentifier") or {}).get("extendedValueG") == "evseId" and x.get("identifier")), None)
                        eid = p["idG"] if not evse or evse == p["idG"] else f"{evse}|{p['idG']}"
                        ids.append(eid)
                        kws[eid] = max(kws.get(eid, 0), round(pkw))  # each stall's power (evseKw)
                        kw = max(kw, pkw)
                if not ids:
                    continue
                # Other operators are kept too, as "other": an Open Charge Map pin can carry an old brand
                # (Nazareth E17 is TotalEnergies there, Circle K/Spirii here), so the Worker falls back to
                # any fast site on the same spot.
                b = brand_of(operator, ids) or "other"
                try:
                    a = s["entrance"][0]["locAreaLocation"]["locLocationExtensionG"]["FacilityLocation"]["address"]
                    street = text(a["addressLine"][0]["text"])
                    city = text(a.get("city"))
                except (KeyError, IndexError, TypeError):
                    street, city = "", ""
                name = ", ".join(x for x in (street, city) if x) or text(s.get("brand"))
                uniq = sorted(set(ids))
                sites.append((b, round(lat, 5), round(lon, 5), round(kw), name, uniq, [kws[i] for i in uniq]))

    sites.sort(key=lambda s: (s[0], s[1], s[2]))
    out = {
        "built": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "source": "nap-be.eco-movement.com /datex2/v1/locations",
        "pages": pages,
        "fields": ["brand", "lat", "lon", "maxKw", "name", "evseIds", "evseKw"],
        "sites": [list(s) for s in sites],
    }
    os.makedirs("data", exist_ok=True)
    with open("data/be-fast-sites.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    per = {}
    for s in sites:
        d = per.setdefault(s[0], [0, 0])
        d[0] += 1
        d[1] += len(s[5])
    print(f"{pages} pages, {total_sites} sites read ({len(seen)} unique) -> {len(sites)} fast sites, "
          f"{os.path.getsize('data/be-fast-sites.json') // 1024} kB")
    for b, (n, k) in sorted(per.items()):
        print(f"  {b:9} {n:5} sites {k:6} stalls")


if __name__ == "__main__":
    main()
