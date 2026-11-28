#!/usr/bin/env python3
"""Occupancy profiles: what is "usual" per site, weekday and 5-minute slot (28 Nov 2026, option D).

Remco's idea (28 Nov 14:00): keep one row per weekday per site, a running average that a new day
changes by 1/7 once six weeks are in: avg = (avg * n + x) / (n + 1), n at most 6. So nothing grows
with time: 7 rows of 288 slots per site. Each slot has its own n (a slot without a reading doesn't
count). Next to the average free chargers, the share of days the slot was full (0 free), the same way.

"Don't throw anything away" (Remco, 28 Nov 14:04): every finished day is folded in once and then
stored whole, as read, on branch occ-archive (days/<date>.json.gz with every site of that local
date, logs/log-<date>.jsonl the job's run log of that day). The 5-minute job only drops a day from
its tiles after it was archived (profile.json "folded" on branch occ).

Usage (in .github/workflows/occupancy.yml):
  occ-profile.py check <occ dir>             prints the dates waiting to be folded (one per line)
  occ-profile.py fold <occ dir> <archive dir> folds them: archive files and profiles in <archive dir>,
                                              today's usual row in each tile ("u"), and
                                              <occ dir>/profile.json.new (moved into place by the
                                              workflow only after the archive was pushed)

Files on branch occ-archive:
  days/<YYYY-MM-DD>.json.gz  {v, date, slotMin, sites: {key: {b, cc, tz, lat, lon, n, t, d: <288>}}}
  logs/log-<YYYY-MM-DD>.jsonl
  prof/p_<lat>_<lon>.json    {v, sites: {key: [7 rows, Monday first; "" or 288 × 4 characters]}}
                             per slot: average free × 10 in 2 base-36 characters, the share full as
                             1 base-36 character (0..35 → 0..1), n (0..6); "...." never read
Tile field (branch occ, t_*.json): sites[key].u = {w: <local date>, a: 288 × 2 (average × 10, ".."
none), f: 288 × 1 (share full 0..35, "." none)}, only when a third of the slots have a usual value.
A slot is usual when its own weekday has n >= 2; Monday to Thursday also borrow from each other
(weighted by n) until then.
"""
import datetime
import glob
import gzip
import json
import os
import sys
import time
from zoneinfo import ZoneInfo

SLOT_MIN = 5
SLOTS = 24 * 60 // SLOT_MIN
ALPHA = "0123456789abcdefghijklmnopqrstuvwxyz"
N_MAX = 6            # a new day weighs 1 / (N_MAX + 1) once the slot has N_MAX days
BRIDGE = 30 // SLOT_MIN   # a reading holds until the next one across a gap of at most 30 min (as the chart)
MIN_N = 2            # days needed before a slot counts as usual
GROUP = (0, 1, 2, 3)  # Monday..Thursday borrow from each other while a weekday has fewer than MIN_N
LAST_TZ = ZoneInfo("Atlantic/Madeira")  # the westernmost day the job keeps (PT); a date is done once it's over there
DONE_SLACK = datetime.timedelta(minutes=10)
PROFILE = "profile.json"


def b36(n, width):
    n = max(0, min(36 ** width - 1, int(round(n))))
    s = ""
    for _ in range(width):
        s = ALPHA[n % 36] + s
        n //= 36
    return s


def un36(s):
    n = 0
    for ch in s:
        n = n * 36 + ALPHA.index(ch)
    return n


def load_state(occ):
    try:
        return json.load(open(os.path.join(occ, PROFILE)))
    except Exception:
        return {"v": 1, "folded": []}


def tiles(occ):
    out = {}
    for path in sorted(glob.glob(os.path.join(occ, "t_*.json"))):
        try:
            out[os.path.basename(path)] = json.load(open(path))
        except Exception as e:
            print("Unreadable", path, e)
    return out


def due_dates(occ, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    last_done = (now - DONE_SLACK).astimezone(LAST_TZ).date().isoformat()  # dates before this are over everywhere
    folded = set(load_state(occ).get("folded") or [])
    dates = set()
    for doc in tiles(occ).values():
        for rec in (doc.get("sites") or {}).values():
            dates.update((rec.get("d") or {}).keys())
    return sorted(d for d in dates if d < last_done and d not in folded)


def bridged(day):
    """Readings of one day as numbers (None = no reading), a reading held across gaps of <= 30 min."""
    vals = [None if ch not in ALPHA else ALPHA.index(ch) for ch in (day or "").ljust(SLOTS, ".")[:SLOTS]]
    last = -1
    for i, v in enumerate(vals):
        if v is None:
            continue
        if last >= 0 and 1 < i - last <= BRIDGE:
            for j in range(last + 1, i):
                vals[j] = vals[last]
        last = i
    return vals


def row_read(row):
    """[(avg, full, n)] for 288 slots from a stored row ("" = nothing yet)."""
    if not row:
        return [(0.0, 0.0, 0)] * SLOTS
    out = []
    for i in range(SLOTS):
        c = row[i * 4:i * 4 + 4]
        if len(c) < 4 or c[3] == "." or c[3] == "0":
            out.append((0.0, 0.0, 0))
        else:
            out.append((un36(c[:2]) / 10, un36(c[2]) / 35, int(c[3])))
    return out


def row_write(cells):
    return "".join("...." if n == 0 else b36(a * 10, 2) + b36(f * 35, 1) + str(n) for a, f, n in cells)


def fold_day(cells, vals):
    """Remco's running average: (avg × n + x) / (n + 1), n at most N_MAX; slots without a reading stay."""
    out = []
    for (a, f, n), x in zip(cells, vals):
        if x is None:
            out.append((a, f, n))
            continue
        full = 1.0 if x == 0 else 0.0
        out.append(((a * n + x) / (n + 1), (f * n + full) / (n + 1), min(N_MAX, n + 1)))
    return out


def usual_row(rows, weekday):
    """Today's usual line from a site's 7 rows: own weekday with n >= MIN_N, else (Mon–Thu) the group."""
    own = row_read(rows[weekday])
    group = [row_read(rows[w]) for w in GROUP] if weekday in GROUP else None
    a, f, have = [], [], 0
    for i in range(SLOTS):
        avg, full, n = own[i]
        if n < MIN_N and group:
            tn = sum(g[i][2] for g in group)
            if tn >= MIN_N:
                avg = sum(g[i][0] * g[i][2] for g in group) / tn
                full = sum(g[i][1] * g[i][2] for g in group) / tn
                n = tn
        if n >= MIN_N:
            a.append(b36(avg * 10, 2))
            f.append(b36(full * 35, 1))
            have += 1
        else:
            a.append("..")
            f.append(".")
    return ("".join(a), "".join(f)) if have >= SLOTS // 3 else None


def fold(occ, arch, now=None):
    t0 = time.time()
    now = now or datetime.datetime.now(datetime.timezone.utc)
    dates = due_dates(occ, now)
    docs = tiles(occ)
    os.makedirs(os.path.join(arch, "days"), exist_ok=True)
    os.makedirs(os.path.join(arch, "logs"), exist_ok=True)
    os.makedirs(os.path.join(arch, "prof"), exist_ok=True)
    profs = {}

    def prof(tile):
        if tile not in profs:
            path = os.path.join(arch, "prof", "p_" + tile[2:])
            try:
                profs[tile] = json.load(open(path))
            except Exception:
                profs[tile] = {"v": 1, "sites": {}}
        return profs[tile]

    stats = {"dates": dates, "days": {}}
    for date in dates:
        weekday = datetime.date.fromisoformat(date).weekday()
        day_sites, folded_sites = {}, 0
        for tile, doc in docs.items():
            for key, rec in (doc.get("sites") or {}).items():
                day = (rec.get("d") or {}).get(date)
                if not day:
                    continue
                day_sites[key] = {k: rec.get(k) for k in ("b", "cc", "tz", "lat", "lon", "n", "t")} | {"d": day}
                vals = bridged(day)
                if not any(v is not None for v in vals):
                    continue
                rows = prof(tile)["sites"].setdefault(key, [""] * 7)
                rows[weekday] = row_write(fold_day(row_read(rows[weekday]), vals))
                folded_sites += 1
        with gzip.open(os.path.join(arch, "days", f"{date}.json.gz"), "wt", encoding="utf-8") as f:
            json.dump({"v": 1, "date": date, "slotMin": SLOT_MIN, "sites": day_sites}, f, ensure_ascii=False, separators=(",", ":"))
        log_path = os.path.join(occ, f"log-{date}.jsonl")
        if os.path.exists(log_path):
            with open(log_path, "rb") as src, open(os.path.join(arch, "logs", f"log-{date}.jsonl"), "wb") as dst:
                dst.write(src.read())
        stats["days"][date] = {"sites": len(day_sites), "folded": folded_sites}
        print(f"Folded {date} (weekday {weekday}): {len(day_sites)} sites archived, {folded_sites} with readings in the profile")

    # Today's usual line in every tile (the site's own local date); profiles of tiles not folded today are read too.
    usual = 0
    for tile, doc in docs.items():
        p = prof(tile)
        for key, rec in (doc.get("sites") or {}).items():
            rows = p["sites"].get(key)
            today = now.astimezone(ZoneInfo(rec.get("tz") or "Europe/Amsterdam")).date()
            u = usual_row(rows, today.weekday()) if rows else None
            if u:
                rec["u"] = {"w": today.isoformat(), "a": u[0], "f": u[1]}
                usual += 1
            else:
                rec.pop("u", None)
        with open(os.path.join(occ, tile), "w") as f:
            json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    for tile, p in profs.items():
        if p["sites"]:
            with open(os.path.join(arch, "prof", "p_" + tile[2:]), "w") as f:
                json.dump(p, f, separators=(",", ":"))

    state = load_state(occ)
    state["folded"] = sorted(set(state.get("folded") or []) | set(dates))
    state["last"] = {"at": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "dates": dates, "days": stats["days"],
                     "usual": usual, "profiles": sum(len(p["sites"]) for p in profs.values()),
                     "secs": round(time.time() - t0, 1)}
    with open(os.path.join(occ, PROFILE + ".new"), "w") as f:
        json.dump(state, f, separators=(",", ":"))
    print("Profiles:", json.dumps(state["last"]))


def main():
    if os.environ.get("OCC_PROFILE_NOW"):  # tests only
        fixed = datetime.datetime.fromisoformat(os.environ["OCC_PROFILE_NOW"])
        global due_dates, fold
        _due, _fold = due_dates, fold
        due_dates = lambda occ, now=None: _due(occ, fixed)
        fold = lambda occ, arch, now=None: _fold(occ, arch, fixed)
    if len(sys.argv) >= 3 and sys.argv[1] == "check":
        print("\n".join(due_dates(sys.argv[2])))
    elif len(sys.argv) >= 4 and sys.argv[1] == "fold":
        fold(sys.argv[2], sys.argv[3])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
