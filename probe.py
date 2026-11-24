import json, time, urllib.request, re, gzip
B="https://dotnl.ndw.nu/api/rest/geojson/dynamic-road-status/charge-point-data/v1/features"
def get(url):
    t=time.time(); req=urllib.request.Request(url,headers={"Accept":"application/json","Accept-Encoding":"gzip","User-Agent":"probe"})
    with urllib.request.urlopen(req,timeout=120) as r:
        raw=r.read(); enc=r.headers.get("Content-Encoding")
    body=gzip.decompress(raw) if enc=="gzip" else raw
    return json.loads(body), len(raw), len(body), time.time()-t
for bb in ["3.3,50.7,7.3,53.6"]:
    try:
        d,z,n,s=get(f"{B}?bbox={bb}")
        f=d.get("features",[])
        print("FULL",bb,"wire",z,"bytes",n,"secs",round(s,1),"features",len(f))
        fast=0; ion=[]; ops={}
        for x in f:
            p=x.get("properties",{})
            av=p.get("availabilities") or []
            kw=max([(e.get("power_max") or 0)/1000 for e in av] or [0])
            if kw>=50:
                fast+=1; op=p.get("operator_name") or "?"; ops[op]=ops.get(op,0)+1
            if re.search("ionity",str(p.get("operator_name"))+str(p.get("cpo_id")),re.I) or p.get("cpo_id")=="IOY":
                ion.append(x)
        print("fast locations",fast)
        print("ops", sorted(ops.items(), key=lambda kv:-kv[1])[:40])
        print("ionity",len(ion))
        if ion: print(json.dumps(ion[0])[:1500])
        print("keys", list(f[0].keys()), list(f[0]["properties"].keys()))
    except Exception as e: print("FULL fail",bb,e)
