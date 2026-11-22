#!/usr/bin/env python3
"""France live status: transport.data.gouv.fr's national IRVE dynamic file (CSV, ~9.5 MB) → a small fr-status.json.

Usage:  python3 tools/build-fr-status.py <out.json> [dynamic.csv]
        Runs every 5 minutes in .github/workflows/fr-live.yml (started by the Worker's timer), which
        force-pushes the result to the branch "live-fr" (one commit, no history, no Pages build).
        The Worker reads it by commit id, like Portugal's pt-status.json.

Why outside the Worker: reading the whole national file took 17-30 ms CPU, over the free Worker plan's
~10 ms (Error 1102 after a few reads in a row), so France used to be tap-only. This job reads it, keeps
only the points of data/fr-fast-sites.json and writes ~100-200 kB the Worker reads at next to no cost.

Output: {at, index, url, bytes, secs, rows, codes, s: {"<site index>": [codes, ages]}}
  site index: the site's position in data/fr-fast-sites.json (the Worker calls it fr<i>).
  codes: one letter per point in the index's pdcIds order: F free, U in use, O out of order,
         ? unknown, - not in the live file.
  ages:  minutes from the point's horodatage (its last change) to "at" (null if missing).
Rows can appear twice: the newest horodatage wins. Exit code 0 when written, 1 when the feed failed.

Source: transport.data.gouv.fr, Licence Ouverte 2.0. Standard library only.
"""
import csv, datetime, io, json, os, sys, time, urllib.request

INDEX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "fr-fast-sites.json")
DYNAMIC_URL = "https://transport.data.gouv.fr/resources/84098/download"


def parse_time(s):
    if not s:
        return None
    try:
        t = datetime.datetime.fromisoformat(s.strip().replace(" ", "T").replace("Z", "+00:00"))
        return t if t.tzinfo else t.replace(tzinfo=datetime.timezone.utc)
    except ValueError:
        return None


def code(etat, occ):
    etat, occ = (etat or "").strip().lower(), (occ or "").strip().lower()
    if etat == "hors_service":
        return "O"
    if occ in ("occupe", "reserve"):
        return "U"
    if occ == "libre" and etat == "en_service":
        return "F"
    return "?"


def read_rows(text, wanted):
    """→ {id: (etat, occupation, horodatage)} for the wanted ids, newest horodatage per id."""
    rows, n = {}, 0
    reader = csv.reader(io.StringIO(text))
    head = [h.strip().lower() for h in next(reader)]
    col = lambda name, d: head.index(name) if name in head else d
    ci, ce, co, ch = col("id_pdc_itinerance", 0), col("etat_pdc", 1), col("occupation_pdc", 2), col("horodatage", 3)
    for r in reader:
        n += 1
        if len(r) <= max(ci, ce, co, ch):
            continue
        pid = r[ci].strip()
        if pid not in wanted:
            continue
        prev = rows.get(pid)
        if prev is None or r[ch] > prev[2]:
            rows[pid] = (r[ce], r[co], r[ch])
    return rows, n


def main():
    out_path = sys.argv[1]
    local = sys.argv[2] if len(sys.argv) > 2 else None
    with open(INDEX) as f:
        idx = json.load(f)
    wanted = {pid for site in idx["sites"] for pid in site[5]}
    t0 = time.time()
    if local:
        data, url = open(local, "rb").read(), local
    else:
        req = urllib.request.Request(DYNAMIC_URL, headers={"User-Agent": "EVailability live (github.com/RemcoNLD/apps)"})
        # The proxy sometimes resets the connection (2 of 12 runs on 22 Nov 2026); a missed run leaves
        # France 10 minutes old, so try again a few times within the 5-minute slot before giving up.
        data = None
        for attempt, wait in enumerate((0, 5, 15, 30)):
            if wait:
                print(f"Retrying in {wait} s")
                time.sleep(wait)
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    data, url = r.read(), r.geturl()
                break
            except Exception as e:
                print(f"Feed not reachable (try {attempt + 1}): {e}")
                last_error = e
        if data is None:
            summary([f"Feed not reachable after 4 tries: {last_error}"])
            sys.exit(1)
    rows, n = read_rows(data.decode("utf-8-sig", errors="replace"), wanted)
    at = datetime.datetime.now(datetime.timezone.utc)
    s, hits = {}, 0
    for i, site in enumerate(idx["sites"]):
        letters, ages = [], []
        for pid in site[5]:
            row = rows.get(pid)
            if not row:
                letters.append("-"); ages.append(None)
                continue
            hits += 1
            letters.append(code(row[0], row[1]))
            t = parse_time(row[2])
            ages.append(None if t is None else max(0, round((at - t).total_seconds() / 60)))
        if any(c != "-" for c in letters):
            s[str(i)] = ["".join(letters), ages]
    if n < 1000 or not s:
        print(f"Only {n} rows read, {len(s)} sites matched: not publishing")
        summary([f"Only {n} rows read, {len(s)} sites matched: not published."])
        sys.exit(1)
    doc = {
        "at": at.strftime("%Y-%m-%dT%H:%M:%SZ"), "index": idx["built"], "url": url, "bytes": len(data),
        "secs": round(time.time() - t0, 1), "rows": n,
        "codes": "F free, U in use, O out of order, ? unknown, - not in the live file; ages: minutes before at",
        "source": "transport.data.gouv.fr", "s": s,
    }
    with open(out_path, "w") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    report = [
        f"{len(data) / 1e6:.1f} MB from {url}, {n} rows, read in {doc['secs']} s",
        f"matched {hits} points at {len(s)} of {len(idx['sites'])} indexed fast sites (index {idx['built']})",
        f"output {os.path.getsize(out_path) / 1024:.0f} kB",
    ]
    print("\n".join(report))
    summary(report)


def summary(lines):
    p = os.environ.get("GITHUB_STEP_SUMMARY")
    if p:
        with open(p, "a") as f:
            f.write("### France live\n\n" + "\n".join(f"- {l}" for l in lines) + "\n")


if __name__ == "__main__":
    main()
