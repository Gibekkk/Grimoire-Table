import re, json
t = open('txt/dmg-items.txt').read()
lines = t.split('\n')
TYPE = re.compile(r"^\s*(Wondrous Item|Armor|Weapon|Potion|Ring|Rod|Scroll|Staff|Wand)\s*(\([^)]*\))?\s*,\s*[\u2018'\x22]?\s*(Common|Uncommon|Rare|Very Rare|Legendary|Artifact|Varies|Rarity Vari\w*)(.*)$", re.I)
START = re.compile(r"^\s*(Wondrous Item|Armor|Weapon|Potion|Ring|Rod|Scroll|Staff|Wand)\s*[(,]")
hits = []
for i, l in enumerate(lines):
    if not START.match(l): continue
    joined, j = l.strip(), i
    # a long base-item list can wrap the type line before the rarity
    m = TYPE.match(joined)
    while (joined.count('(') > joined.count(')') or not m or re.search(r"\bVery$", joined)) and j < i + 6:
        j += 1
        if j < len(lines) and lines[j].strip() and not lines[j].startswith('@@'):
            joined += ' ' + lines[j].strip()
            m = TYPE.match(joined)
    if not m: continue
    l = joined
    name = None
    for j in range(i - 1, max(i - 6, -1), -1):
        s = lines[j].strip()
        if s and not s.startswith('@@') and not re.fullmatch(r"\d+", s):
            name = s; break
    hits.append(dict(i=i, name=name, typeline=l.strip()))
json.dump(hits, open('items_hits.json', 'w'), indent=1)
print(len(hits))
for h in hits[:400:8]: print(repr(h['name']), '|', h['typeline'][:70])
