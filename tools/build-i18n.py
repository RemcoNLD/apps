# Writes the Dutch and Portuguese text tables (tools/i18n_data.py) into evailability.html. Run after editing i18n_data.py.
# The Help manual and intro slides per language are in evailability.html itself (HELP_I18N, SLIDES_I18N).
import json, sys
import os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import i18n_data
EXACT=i18n_data.EXACT; PATTERNS=i18n_data.PATTERNS
EXACT.pop("Best", None)
nl={k:v[0] for k,v in EXACT.items() if v[0]!=k}; pt={k:v[1] for k,v in EXACT.items() if v[1]!=k}
tables="// ---- languages: English (default), Dutch, Portuguese (pt-PT). Generated from i18n_data.py.\nconst I18N_TEXT = "+json.dumps({"nl":nl,"pt":pt},ensure_ascii=False,indent=0)+";\nconst I18N_PATTERNS = "+json.dumps([list(x) for x in PATTERNS],ensure_ascii=False)+";\n"
p=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'evailability.html'); s=open(p).read()
a=s.index('// ---- languages: English (default), Dutch, Portuguese (pt-PT). Generated from i18n_data.py.')
b=s.index('// Help manual and intro texts in Dutch and Portuguese', a)
s=s[:a]+tables+s[b:]
open(p,'w').write(s)
print("tables", len(nl), len(pt), len(PATTERNS))
