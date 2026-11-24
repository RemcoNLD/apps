import importlib.util, time, collections
spec = importlib.util.spec_from_file_location("occ", "occ.py"); occ = importlib.util.module_from_spec(spec); spec.loader.exec_module(occ)
ops = collections.Counter()
def brand_of(f, brands):
    p = f.get("properties") or {}; ops[p.get("operator_name") or "?"] += 1; return "any"
occ.brand_of = brand_of
t = time.time(); found = occ.nl_scan([])
print("ALL fast NL sites:", len(found), "calls", occ.PACE.calls, "secs", round(time.time() - t))
boxes = {(round(s[1], 2), round(s[2], 2)) for s, _ in found.values()}
print("status boxes per run:", len(boxes))
c = collections.Counter()
for s, _ in found.values(): pass
fast_ops = collections.Counter()
