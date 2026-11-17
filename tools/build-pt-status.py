#!/usr/bin/env python3
"""Portugal live status: MOBI.E evActualStatus (DATEX II, ~36-40 MB) → a small pt-status.json.

Usage:  python3 tools/build-pt-status.py <out.json> [previous.json] [dynamic.xml]
        Runs every 5 minutes in .github/workflows/pt-live.yml, which force-pushes the result to the
        branch "live" (one commit, no history, no Pages build). The Worker reads it from
        raw.githubusercontent.com/RemcoNLD/apps/live/pt-status.json.

Why outside the Worker: the national file is far too big to read within the free Worker plan's ~10 ms
CPU (France's 9.5 MB already failed). This job reads it, keeps only the fast stalls of
data/pt-fast-sites.json and writes ~50-100 kB.

Output: {pub, at, etag, index, url, bytes, secs, codes, s: {siteId: [codes, ages]}}
  codes: one letter per point in the index's point order: F free, U in use, O out of order, ? unknown,
         - not in the live file.  ages: minutes from the point's lastUpdated to pub (null if missing).
Exit code 0 always; prints "CHANGED=1" or "CHANGED=0" for the workflow (0: 304 / same publication).

Source: MOBI.E / NAP Portugal (open access). Standard library only.
"""
import datetime, gzip, json, os, sys, time, urllib.error, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pt_datex as D  # noqa: E402

INDEX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "pt-fast-sites.json")
PUBLISH_EVERY_S = 300   # measured by carregamento-pt: rebuilt every 5 min, complete ~45-70 s later
READY_MARGIN_S = 80
MAX_WAIT_S = 170

# DATEX II RefillPointStatusEnum → app letter. Anything else counts as unknown and is listed in the summary.
CODE = {
    "available": "F",
    "charging": "U", "occupied": "U", "reserved": "U", "blocked": "U", "inuse": "U", "busy": "U",
    "outoforder": "O", "faulted": "O", "inoperative": "O", "unavailable": "O", "closed": "O",
    "removed": "O", "outofstock": "O", "out_of_order": "O",
    "unknown": "?", "planned": "?",
}


def parse_time(s):
    if not s:
        return None
    try:
        t = datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
        return t if t.tzinfo else t.replace(tzinfo=datetime.timezone.utc)
    except ValueError:
        return None


class Counting:
    def __init__(self, f):
        self.f, self.n = f, 0

    def read(self, size=-1):
        b = self.f.read(size)
        self.n += len(b)
        return b


def download(etag):
    """→ (stream or None for 304, info dict)."""
    last = None
    for url in D.DYNAMIC_URLS:
        h = {"User-Agent": "EVailability live (github.com/RemcoNLD/apps)", "Accept-Encoding": "gzip"}
        if etag:
            h["If-None-Match"] = etag
        t0 = time.time()
        try:
            r = urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=120)
        except urllib.error.HTTPError as e:
            if e.code == 304:
                return None, {"url": url, "http": 304, "etag": etag, "wait": round(time.time() - t0, 1)}
            last = f"{url}: HTTP {e.code}"
            continue
        except Exception as e:
            last = f"{url}: {e}"
            continue
        info = {"url": url, "http": r.status, "wait": round(time.time() - t0, 1),
                **{k: r.headers.get(v) for k, v in (("etag", "ETag"), ("encoding", "Content-Encoding"),
                   ("length", "Content-Length"), ("modified", "Last-Modified"), ("cache", "Cache-Control"))}}
        raw = Counting(r)
        stream = gzip.GzipFile(fileobj=raw) if (info["encoding"] or "").lower() == "gzip" else raw
        return (stream, raw), info
    raise SystemExit(f"Feed not reachable: {last}")


def load_index():
    with open(INDEX) as f:
        idx = json.load(f)
    by_site, by_point = {}, {}
    for site_id, _b, _op, _lat, _lon, _kw, _n, pids, _pkw in idx["sites"]:
        by_site[site_id] = {pid: i for i, pid in enumerate(pids)}
        for i, pid in enumerate(pids):
            by_point.setdefault(pid, []).append((site_id, i))
    return idx, by_site, by_point


def snapshot(stream, idx, by_site, by_point):
    pub = {}
    letters = {sid: ["-"] * len(m) for sid, m in by_site.items()}
    ages = {sid: [None] * len(m) for sid, m in by_site.items()}
    times = {sid: [None] * len(m) for sid, m in by_site.items()}
    raw_states, rows, hits = {}, 0, 0
    for site, pid, status, updated in D.read_status(stream, lambda t: pub.setdefault("t", t)):
        rows += 1
        raw_states[status] = raw_states.get(status, 0) + 1
        if site in by_site and pid in by_site[site]:
            where = [(site, by_site[site][pid])]
        else:
            where = by_point.get(pid, [])
            if len(where) != 1:
                continue  # unknown, or a bare id used at several sites: can't tell which
        sid, i = where[0]
        hits += 1
        letters[sid][i] = CODE.get(status.replace(" ", "").lower(), "?")
        times[sid][i] = parse_time(updated)
    pub_t = parse_time(pub.get("t")) or datetime.datetime.now(datetime.timezone.utc)
    s = {}
    for sid in letters:
        if all(c == "-" for c in letters[sid]):
            continue
        a = [None if t is None else max(0, round((pub_t - t).total_seconds() / 60)) for t in times[sid]]
        s[sid] = [("".join(letters[sid])), a]
    return pub_t, s, raw_states, rows, hits


def main():
    out_path = sys.argv[1]
    prev = {}
    if len(sys.argv) > 2 and os.path.exists(sys.argv[2]):
        try:
            prev = json.load(open(sys.argv[2]))
        except Exception:
            prev = {}
    dyn = sys.argv[3] if len(sys.argv) > 3 else None
    idx, by_site, by_point = load_index()
    t0 = time.time()
    if dyn:
        res, info = (open(dyn, "rb"), None), {"url": dyn, "http": 200}
    else:
        res, info = download(prev.get("etag"))
        # Same version as last time: wait for the next publication (once), like carregamento-pt does.
        last_pub = parse_time(prev.get("pub"))
        if res is None and last_pub:
            due = last_pub + datetime.timedelta(seconds=PUBLISH_EVERY_S + READY_MARGIN_S)
            now = datetime.datetime.now(datetime.timezone.utc)
            while due <= now:
                due += datetime.timedelta(seconds=PUBLISH_EVERY_S)
            wait = (due - now).total_seconds()
            if wait <= MAX_WAIT_S:
                print(f"304: waiting {wait:.0f} s for the next publication")
                time.sleep(wait)
                res, info = download(prev.get("etag"))
    report = [f"http {info['http']} from {info['url']} (first byte {info.get('wait')} s)"]
    for k in ("etag", "encoding", "length", "modified", "cache"):
        if info.get(k):
            report.append(f"{k}: {info[k]}")
    if res is None:
        print("\n".join(report + ["Not modified: nothing to write", "CHANGED=0"]))
        summary(report + ["Not modified (304)."])
        return
    stream, raw = res
    pub_t, s, raw_states, rows, hits = snapshot(stream, idx, by_site, by_point)
    secs = round(time.time() - t0, 1)
    nbytes = getattr(raw, "n", None) or (os.path.getsize(dyn) if dyn else None)
    pub_iso = pub_t.strftime("%Y-%m-%dT%H:%M:%SZ")
    same = prev.get("pub") == pub_iso
    doc = {
        "pub": pub_iso, "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "etag": info.get("etag"), "index": idx["built"], "url": info["url"], "bytes": nbytes, "secs": secs,
        "codes": "F free, U in use, O out of order, ? unknown, - not in the live file; ages: minutes before pub",
        "source": "MOBI.E / NAP Portugal", "s": s,
    }
    with open(out_path, "w") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    age = (datetime.datetime.now(datetime.timezone.utc) - pub_t).total_seconds()
    report += [
        f"publicationTime {pub_iso} ({age:.0f} s before the end of the read)" + (" — same as last time" if same else ""),
        f"{(nbytes or 0) / 1e6:.1f} MB read and parsed in {secs} s; {rows} point statuses",
        f"matched {hits} points at {len(s)} of {len(idx['sites'])} indexed fast sites",
        f"output {os.path.getsize(out_path) / 1024:.0f} kB",
        "raw states: " + ", ".join(f"{k or '(empty)'} {v}" for k, v in sorted(raw_states.items(), key=lambda x: -x[1])),
    ]
    print("\n".join(report))
    print("CHANGED=0" if same else "CHANGED=1")
    summary(report)


def summary(lines):
    p = os.environ.get("GITHUB_STEP_SUMMARY")
    if p:
        with open(p, "a") as f:
            f.write("### Portugal live\n\n" + "\n".join(f"- {l}" for l in lines) + "\n")


if __name__ == "__main__":
    main()
