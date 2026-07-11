#!/usr/bin/env python3
"""Pre-ship audit script. Run before every package. Zero tolerance."""
import datetime
# Auto-stamp APP_VERSION on every audit run
with open('index.html', 'r') as fh:
    html = fh.read()
new_ver = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M')
import re as _re
html2 = _re.sub(r"const APP_VERSION = '\d+'", f"const APP_VERSION = '{new_ver}'", html)
if html2 != html:
    with open('index.html', 'w') as fh: fh.write(html2)
    print(f"✓ APP_VERSION stamped: {new_ver}")

import re, subprocess, os, sys

c = open('index.html').read()
s = c.find('<script>') + len('<script>')
e = c.rfind('</script>')
js = c[s:e]
errors = []

# 1. Frontend JS syntax
with open('/tmp/full.js','w') as f: f.write(js)
r = subprocess.run(['node','--check','/tmp/full.js'], capture_output=True)
if r.returncode != 0:
    errors.append(f"SYNTAX index.html: {r.stderr.decode()[:150]}")

# 2. All backend files
for d, files in [('netlify/functions', os.listdir('netlify/functions')),
                 ('netlify/functions/lib', os.listdir('netlify/functions/lib'))]:
    for f in files:
        if f.endswith('.mjs'):
            r = subprocess.run(['node','--check',f'{d}/{f}'], capture_output=True)
            if r.returncode != 0:
                errors.append(f"SYNTAX {d}/{f}: {r.stderr.decode()[:100]}")

# 3. Undeclared variables in render functions
render_check = {
    'renderScoreboard': ['hrCarryover','liveLabel','rostersLiveAt'],
    'renderRostersEdit': ['irSlots','irMode','hrCarryover','liveLabel'],
}
fn_positions = [(m.group(1), m.start()) for m in re.finditer(r'\n(?:async )?function (\w+)\s*\(', js)]
fn_bodies = {n: js[p:(fn_positions[i+1][1] if i+1<len(fn_positions) else len(js))]
             for i,(n,p) in enumerate(fn_positions)}
for fn_name, vars_check in render_check.items():
    body = fn_bodies.get(fn_name, '')
    for var in vars_check:
        uses = [m for m in re.finditer(rf'(?<![.\w])\b{var}\b(?!\s*[=:])', body)]
        if uses and not re.search(rf'\bconst {var}\b|\blet {var}\b', body):
            errors.append(f"UNDECLARED '{var}' in {fn_name} ({len(uses)}x uses, 0 declarations)")

# 4. onclick → undefined functions
html_part = c[:s] + c[e:]
onclick_calls = set(re.findall(r'onclick="(\w+)\(', html_part) + re.findall(r"onclick='(\w+)\(", html_part))
defined = set(re.findall(r'(?:async )?function (\w+)\s*\(', js))
builtins = {'navigate','parseInt','Math','Date','JSON','console','window','document',
            'location','setTimeout','clearInterval','setInterval','encodeURIComponent',
            'decodeURIComponent','String','Object','Array','Notification','navigator'}
for fn in onclick_calls:
    if fn not in defined and fn not in builtins:
        errors.append(f"ONCLICK calls undefined: {fn}()")

if errors:
    print(f"\n🚫 DO NOT SHIP — {len(errors)} issue(s):\n")
    for err in errors: print(f"  ❌ {err}")
    sys.exit(1)
else:
    print("✅ Audit passed — safe to ship")
    sys.exit(0)
