# Adds each monster's Treasure tags (Monster Manual 2025 "Habitat ...; Treasure: ..."
# line of its family) to data/monsters.json as `treasure: [...]`, used by the VTT's
# loot roller. A monster takes the first Treasure line on its stat block's page,
# else the closest one on an earlier page. The PDF is 3 pages ahead of book pages.
import subprocess, re, json, sys
PDF = sys.argv[1] if len(sys.argv) > 1 else "../../docs/Monster Manual (2025).pdf"
MONSTERS = "../../data/monsters.json"
OFFSET = 3
TAGS = [("arcana", "Arcana"), ("armament", "Armaments"), ("implement", "Implements"), ("ndividual", "Individual"), ("relic", "Relics"), ("none", "None"), ("any", "Any")]

pages = int(re.search(r'Pages:\s+(\d+)', subprocess.run(['pdfinfo', PDF], capture_output=True, text=True).stdout).group(1))
text = subprocess.run(['pdftotext', '-layout', PDF, '-'], capture_output=True, text=True).stdout.split('\f')
per_page = {}
for i, page in enumerate(text[:pages], start=1):
    found = []
    lines = page.split('\n')
    for j, line in enumerate(lines):
        m = re.search(r'Treasure\s*:\s*(.*)', line)
        if not m or 'Theme' in line: continue
        # the tag list may wrap ("Treasure: Armaments,\n Individual")
        raw = m.group(1).split('   ')[0]
        if raw.rstrip().endswith(',') and j + 1 < len(lines): raw += lines[j + 1].strip().split('   ')[0]
        key = re.sub(r'[^a-z,]', '', raw.lower())
        tags = [name for frag in key.split(',') for k, name in TAGS if k in frag][:3]
        if tags: found.append(sorted(set(tags), key=tags.index))
    if found: per_page[i] = found

monsters = json.load(open(MONSTERS))
last = ["None"]
hits = 0
for m in monsters:
    pm = re.search(r'p\.(\d+)', m.get("source", ""))
    if not pm: continue
    p = int(pm.group(1)) + OFFSET
    tags = per_page.get(p, [None])[0]
    q = p
    while tags is None and q > 1:
        q -= 1
        tags = per_page[q][-1] if q in per_page else None
    m["treasure"] = tags or ["None"]
    hits += 1
# keep the file's one-monster-per-line layout
with open(MONSTERS, "w") as f:
    f.write("[\n" + ",\n".join(json.dumps(m, ensure_ascii=False, separators=(",", ":")) for m in monsters) + "\n]\n")
from collections import Counter
print(f"treasure tags on {hits}/{len(monsters)} monsters;", Counter(t for m in monsters for t in m.get("treasure", [])))
