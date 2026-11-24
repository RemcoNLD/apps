import json, time, urllib.request, urllib.error, re, gzip
B="https://dotnl.ndw.nu/api/rest/geojson/dynamic-road-status/charge-point-data/v1/features"
def get(url):
    t=time.time(); req=urllib.request.Request(url,headers={"Accept":"application/json","Accept-Encoding":"gzip","User-Agent":"probe"})
    try:
        with urllib.request.urlopen(req,timeout=120) as r:
            raw=r.read(); enc=r.headers.get("Content-Encoding")
    except urllib.error.HTTPError as e:
        return None, 0, e.read()[:300], time.time()-t
    body=gzip.decompress(raw) if enc=="gzip" else raw
    return json.loads(body), len(raw), len(body), time.time()-t
for d in [2.0,1.0,0.5,0.25,0.1]:
    bb=f"4.6,52.0,{4.6+d:.2f},{52.0+d/2:.2f}"
    j,z,n,s=get(f"{B}?bbox={bb}")
    print("BOX",d,bb,"wire",z,"bytes",n if j is not None else n,"secs",round(s,1),"features",len(j["features"]) if j else None, flush=True)
# full NL with 0.5 deg tiles (lon) x 0.25 (lat)
tot=0;bytes_=0;fast=0;ion=[];ops={};t0=time.time();fails=0
lat=50.7
while lat<53.6:
    lon=3.3
    while lon<7.3:
        bb=f"{lon:.2f},{lat:.2f},{lon+0.5:.2f},{lat+0.25:.2f}"
        j,z,n,s=get(f"{B}?bbox={bb}")
        if j is None: fails+=1; print("fail",bb,n); lon+=0.5; continue
        bytes_+=z
        for x in j.get("features",[]):
            tot+=1;p=x.get("properties",{})
            av=p.get("availabilities") or []
            kw=max([(e.get("power_max") or 0)/1000 for e in av] or [0])
            if kw>=50:
                fast+=1; op=p.get("operator_name") or "?"; ops[op]=ops.get(op,0)+1
                if re.search("ionity",str(p.get("operator_name")),re.I) or p.get("cpo_id")=="IOY": ion.append(x)
        lon+=0.5
    lat+=0.25
print("NL tiles: features",tot,"wire bytes",bytes_,"secs",round(time.time()-t0),"fails",fails)
print("fast locations",fast)
print("ops", sorted(ops.items(), key=lambda kv:-kv[1])[:50])
print("ionity",len(ion))
if ion: print(json.dumps(ion[0])[:1800])
