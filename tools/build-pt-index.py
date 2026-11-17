#!/usr/bin/env python3
"""Build data/pt-fast-sites.json from Portugal's MOBI.E charger inventory (DATEX II).

Usage:  python3 tools/build-pt-index.py [static.xml]
        Without a file it downloads the inventory itself (~180 MB, streamed, never held in memory).
        Runs weekly in .github/workflows/pt-index.yml.

Keeps every site with at least one charge point of 50 kW or more, whatever the operator, with each
point's id and power, so the live job (tools/build-pt-status.py) and the Worker (/status, country PT)
can count free stalls at the chosen power. A site gets a brand key when its operator, name or point ids
match one of the app's brands; sites of other operators are kept with brand null, so adding a
Portuguese brand later is a change here and in BRANDS, not a new pipeline.

Source: MOBI.E / NAP Portugal (open access). Standard library only.
"""
import datetime, json, os, re, sys, time, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pt_datex as D  # noqa: E402

FAST_KW = 50
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "pt-fast-sites.json")

# (key, EVSE-id pattern, operator/name pattern). Keep in step with BRANDS in src/evailability-worker.js.
BRANDS = [
    ("ionity",   r"^PT\*?IO[NY]",        r"ionity"),
    ("fastned",  r"^PT\*?FLA",           r"fastned"),
    ("tesla",    r"^PT\*?(TSL|TES)",     r"tesla"),
    ("enbw",     r"^PT\*?EBW",           r"\benbw\b"),
    ("aral",     r"^PT\*?(ARL|ARP)",     r"\baral\b"),
    ("shell",    r"^PT\*?(TNM|SHL|SRS)", r"shell|newmotion"),
    ("total",    r"^PT\*?(TCB|TOT)",     r"\btotal\s*(energies|ev\s*charge)?\b"),
    ("electra",  r"^PT\*?ELC",           r"\belectra\b"),
    ("izivia",   r"^PT\*?(IZI|CDO)",     r"izivia|corri.?door"),
    ("powerdot", r"^PT\*?(PWD|PD1)",     r"power ?dot"),
    ("allego",   r"^PT\*?ALL",           r"allego"),
]
BRANDS = [(k, re.compile(p, re.I), re.compile(n, re.I)) for k, p, n in BRANDS]


def brand_of(site):
    ids = [p["ext"] or p["id"] or "" for p in site["points"]]
    for k, p, _ in BRANDS:
        if any(p.match(i) for i in ids):
            return k
    words = " ".join(filter(None, [site["operator"], site["operator_id"], site["name"]]))
    for k, _, n in BRANDS:
        if n.search(words):
            return k
    return None


def open_static(path):
    if path:
        return open(path, "rb"), path
    last = None
    for url in D.STATIC_URLS:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "EVailability index (github.com/RemcoNLD/apps)"})
            return urllib.request.urlopen(req, timeout=180), url
        except Exception as e:  # try the other host
            last = e
    raise SystemExit(f"Could not download the inventory: {last}")


def main():
    t0 = time.time()
    src, where = open_static(sys.argv[1] if len(sys.argv) > 1 else None)
    n_sites = n_points = 0
    out, per_brand, ops = [], {}, {}
    for s in D.read_sites(src):
        n_sites += 1
        n_points += len(s["points"])
        if s["lat"] is None or s["lon"] is None or not s["points"]:
            continue
        fast = [p for p in s["points"] if (p["kw"] or 0) >= FAST_KW]
        if not fast:
            continue
        b = brand_of(s)
        per_brand[b or "-"] = per_brand.get(b or "-", 0) + 1
        ops[s["operator"] or "?"] = ops.get(s["operator"] or "?", 0) + 1
        pts = [p for p in s["points"] if p["id"]]
        out.append([s["id"], b, (s["operator"] or "")[:40], round(s["lat"], 5), round(s["lon"], 5),
                    max(p["kw"] or 0 for p in fast), (s["name"] or "")[:60],
                    [p["id"] for p in pts], [p["kw"] for p in pts]])
    out.sort(key=lambda r: (r[1] is None, r[1] or "", r[0]))
    doc = {
        "built": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "source": "MOBI.E / NAP Portugal (evChargingInfra, DATEX II)",
        "licence": "Open access (Livre acesso); credit MOBI.E / NAP Portugal",
        "fields": ["siteId", "brand", "operator", "lat", "lon", "maxKw", "name", "pointIds", "pointKw"],
        "sites": out,
    }
    with open(OUT, "w") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(OUT)
    print(f"Read {where}: {n_sites} sites, {n_points} points in {time.time() - t0:.1f} s")
    print(f"Fast sites (>= {FAST_KW} kW): {len(out)} -> {OUT} ({size / 1024:.0f} kB)")
    print("Per brand:", ", ".join(f"{k} {v}" for k, v in sorted(per_brand.items(), key=lambda x: -x[1])))
    print("Top operators:", ", ".join(f"{k} {v}" for k, v in sorted(ops.items(), key=lambda x: -x[1])[:25]))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(f"### Portugal index\n\n{n_sites} sites, {n_points} points read; {len(out)} fast sites, "
                    f"{size / 1024:.0f} kB, {time.time() - t0:.0f} s.\n\n"
                    "Top operators of fast sites: " + ", ".join(f"{k} ({v})" for k, v in
                                                          sorted(ops.items(), key=lambda x: -x[1])[:25]) + "\n")


if __name__ == "__main__":
    main()
