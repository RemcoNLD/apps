# Draws icons/evailability-icon.svg (the home-screen icon). PNGs are rendered from it in a browser at 180 (apple-touch-icon), 192, 512 and 32.
import math
G,R,A='#43b96d','#e0574f','#f0a43a'
def ring(cx,cy,r,w,segs,gap_deg=9):
    C=2*math.pi*r; n=len(segs); per=C/n; gap=C*gap_deg/360
    out=[f'<g transform="translate({cx} {cy}) rotate(-90)">']
    for i,c in enumerate(segs):
        out.append(f'<circle r="{r}" fill="none" stroke="{c}" stroke-width="{w}" stroke-dasharray="{per-gap:.2f} {C-per+gap:.2f}" stroke-dashoffset="{-(i*per+gap/2):.2f}"/>')
    out.append('</g>')
    return ''.join(out)
def bolt(cx,cy,s):
    return f'<path transform="translate({cx} {cy}) scale({s})" d="M1.3-5.6-3.1 1.1h2.7l-.9 4.5 4.6-6.9H.6z" fill="{A}"/>'
svg=f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<defs>
 <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22303c"/><stop offset="1" stop-color="#151b20"/></linearGradient>
 <radialGradient id="glow" cx=".72" cy=".55" r=".5"><stop offset="0" stop-color="#43b96d" stop-opacity=".22"/><stop offset="1" stop-color="#43b96d" stop-opacity="0"/></radialGradient>
 <linearGradient id="road" gradientUnits="userSpaceOnUse" x1="0" y1="170" x2="0" y2="1024"><stop offset="0" stop-color="#4f5c66" stop-opacity="0"/><stop offset=".35" stop-color="#55626c" stop-opacity=".75"/><stop offset="1" stop-color="#5f6c76"/></linearGradient>
 <linearGradient id="edge" gradientUnits="userSpaceOnUse" x1="0" y1="170" x2="0" y2="1024"><stop offset="0" stop-color="#f3f1ea" stop-opacity="0"/><stop offset="1" stop-color="#f3f1ea" stop-opacity=".85"/></linearGradient>
</defs>
<rect width="1024" height="1024" fill="url(#bg)"/>
<rect width="1024" height="1024" fill="url(#glow)"/>
<path d="M392 170h28L700 1024H40z" fill="url(#road)"/>
<path d="M392 170 40 1024M420 170 700 1024" stroke="url(#edge)" stroke-width="10" fill="none" opacity=".6"/>
<path d="M406 170 370 1024" stroke="url(#edge)" stroke-width="18" stroke-dasharray="70 80" fill="none"/>
{ring(478,262,34,12,[G,G,R,G])}{bolt(478,262,3.1)}
{ring(560,420,72,22,[G,R,G,G,R])}{bolt(560,420,6.4)}
{ring(728,694,178,50,[G,G,R,G,G,R])}{bolt(728,694,15.5)}
</svg>'''
open('icons/evailability-icon.svg','w').write(svg)
