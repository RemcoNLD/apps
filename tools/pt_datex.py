"""Streaming readers for Portugal's MOBI.E feeds on the National Access Point (DATEX II 3.x XML).

  static   https://ev-nap.mobie.pt/integration/nap/evChargingInfra   (~180 MB, sites and points)
  dynamic  https://ev-nap.mobie.pt/integration/nap/evActualStatus    (~36-40 MB, rebuilt every 5 min)

Open access ("Livre acesso" on the NAP); credit "MOBI.E / NAP Portugal".
Standard library only. Both files are read one site at a time and each site is dropped from the tree
once read, so memory stays small whatever the file size. Namespaces are ignored (local names only).
Element names follow the DATEX II energy-infrastructure model as the Portuguese collectors read it
(mobilidade-dados-pt/carregamento-pt, coletor/parse.py).
"""
import xml.etree.ElementTree as ET

STATIC_URLS = ["https://ev-nap.mobie.pt/integration/nap/evChargingInfra",
               "https://pgm.mobie.pt/integration/nap/evChargingInfra"]
DYNAMIC_URLS = ["https://ev-nap.mobie.pt/integration/nap/evActualStatus",
                "https://pgm.mobie.pt/integration/nap/evActualStatus"]


def ln(tag):
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else None


def child(el, name):
    if el is None:
        return None
    for c in el:
        if ln(c.tag) == name:
            return c
    return None


def desc(el, name):
    if el is None:
        return None
    for d in el.iter():
        if d is not el and ln(d.tag) == name:
            return d
    return None


def text(el):
    if el is None or el.text is None:
        return None
    t = el.text.strip()
    return t or None


def value(el):
    """Multilingual text (values/value) or plain text."""
    if el is None:
        return None
    v = desc(el, "value")
    return text(v) if v is not None else text(el)


def num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def kw(v):
    x = num(v)
    if x is None:
        return None
    return x / 1000 if x > 1000 else x  # DATEX gives watts in some feeds, kW in others


def _walk(src, want):
    """Yield (element, parent) for every closed element named `want`, then drop it from the tree."""
    stack = []
    for ev, el in ET.iterparse(src, events=("start", "end")):
        if ev == "start":
            stack.append(el)
            continue
        stack.pop()
        if ln(el.tag) == want:
            parent = stack[-1] if stack else None
            yield el, parent
            if parent is not None:
                parent.remove(el)
            el.clear()


def read_sites(src):
    """Static file → one dict per energyInfrastructureSite:
    {id, name, operator, lat, lon, points: [{id, ext, kw, connectors}]}"""
    for el, _ in _walk(src, "energyInfrastructureSite"):
        op = child(el, "operator")
        lat = num(text(desc(el, "latitude")))
        lon = num(text(desc(el, "longitude")))
        points = []
        for rp in el.iter():
            if ln(rp.tag) != "refillPoint":
                continue
            conns = [c for c in rp if ln(c.tag) == "connector"]
            powers = [p for c in conns if (p := kw(text(child(c, "maxPowerAtSocket")))) is not None]
            avail = kw(text(child(rp, "availableChargingPower")))
            best = max(powers) if powers else avail
            points.append({
                "id": rp.get("id"),
                "ext": text(child(rp, "externalIdentifier")),
                "kw": round(best, 1) if best is not None else None,
                "connectors": sorted({t for c in conns if (t := text(child(c, "connectorType")))}),
            })
        yield {
            "id": el.get("id"),
            "name": value(child(el, "name")),
            "operator": value(child(op, "name")) if op is not None else None,
            "operator_id": op.get("id") if op is not None else None,
            "lat": lat, "lon": lon, "points": points,
        }


def read_status(src, on_publication=None):
    """Dynamic file → (site_id or None, point_id, status, lastUpdated) per refillPointStatus.
    on_publication(text) is called once with the first <publicationTime>."""
    stack, site, pub_seen = [], None, False
    for ev, el in ET.iterparse(src, events=("start", "end")):
        if ev == "start":
            stack.append(el)
            if ln(el.tag) == "energyInfrastructureSiteStatus":
                site = None
            continue
        stack.pop()
        name = ln(el.tag)
        if not pub_seen and name == "publicationTime":
            pub_seen = True
            if on_publication:
                on_publication(text(el))
            continue
        if name == "reference" and stack and ln(stack[-1].tag) == "energyInfrastructureSiteStatus":
            site = el.get("id")
            continue
        if name == "refillPointStatus":
            ref = child(el, "reference")
            pid = ref.get("id") if ref is not None else el.get("id")
            st = child(el, "status")
            if st is None:
                st = desc(el, "status")
            if pid:
                yield site, pid, text(st) or "", text(child(el, "lastUpdated"))
            if stack:
                stack[-1].remove(el)
            el.clear()
        elif name == "energyInfrastructureSiteStatus":
            if len(stack):
                stack[-1].remove(el)
            el.clear()
