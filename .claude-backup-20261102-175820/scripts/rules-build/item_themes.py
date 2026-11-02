# Tags each DMG magic item with its treasure theme (Arcana, Armaments,
# Implements, Relics) from the DMG 2024 "Magic Item Tables" (pp. 330-335 of
# the PDF), so monster loot can be rolled to fit a monster's Treasure tag.
# Geometric: every table row is assigned to the nearest theme heading above it
# in the same column (carrying over from the previous page), then rows are
# fuzzy-matched to item names.
import subprocess, re, html, json, sys, difflib
PDF = sys.argv[1] if len(sys.argv) > 1 else "../../docs/Dungeon Master's Guide (2024).pdf"
ITEMS = "../../data/magic-items.json"
WORD = re.compile(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</word>')
THEMES = ("ARCANA", "ARMAMENTS", "IMPLEMENTS", "RELICS")

def words(p):
    out = subprocess.run(['pdftotext', '-f', str(p), '-l', str(p), '-bbox', PDF, '-'], capture_output=True, text=True).stdout
    return [(float(a), float(b), float(c), html.unescape(t)) for a, b, c, d, t in WORD.findall(out)]

rows = []          # (theme, text)
carry = None       # theme of the last heading on the previous page (bottom-right column)
for p in range(330, 336):
    ws = words(p)
    heads = [(x0, y0, next(t for t in THEMES if t in w.upper())) for x0, y0, x1, w in ws if any(t in w for t in THEMES)]
    # line building: words sharing a baseline and close together
    ws.sort(key=lambda w: (round(w[1] / 3), w[0]))
    lines = []
    for x0, y0, x1, t in ws:
        if lines and abs(lines[-1]["y"] - y0) < 3 and x0 - lines[-1]["x1"] < 14:
            lines[-1]["t"] += " " + t; lines[-1]["x1"] = x1
        else:
            lines.append({"x0": x0, "x1": x1, "y": y0, "t": t})
    for ln in lines:
        # a table spans up to two d100|item sub-columns to the right of its heading
        above = [hd for hd in heads if hd[1] <= ln["y"] + 1 and hd[0] <= ln["x0"] + 60]
        theme = max(above, key=lambda hd: (hd[1], hd[0]))[2] if above else carry
        if theme: rows.append((theme, ln["t"]))
    if heads:
        carry = max(heads, key=lambda hd: (hd[0] > 300, hd[1]))[2]

def norm(s):
    s = re.sub(r'^[\d\-‘’\'\s]+', '', s)
    return re.sub(r'[^a-z]', '', s.lower())

items = json.load(open(ITEMS))
normed = [(theme, norm(t)) for theme, t in rows if len(norm(t)) > 3]
hit = 0
# An item can sit in several theme tables (e.g. Potion of Healing), so themes is a list
for it in items:
    n = norm(it["name"])
    found = set()
    for theme, t in normed:
        r = 1.0 if t == n else (0.95 if t.startswith(n) and len(n) > 6 else difflib.SequenceMatcher(None, n, t).ratio())
        if r >= 0.84: found.add(theme.capitalize())
    it.pop("theme", None)
    if found:
        it["themes"] = sorted(found); hit += 1
    else:
        # Fallback by type when the table row couldn't be read
        typ = (it.get("type") or "").lower()
        it["themes"] = ["Armaments" if typ in ("armor", "weapon", "ammunition") else "Arcana" if typ in ("ring", "rod", "scroll", "staff", "wand") else "Implements" if typ == "potion" else "Relics"]
json.dump(items, open(ITEMS, "w"), indent=1, ensure_ascii=False)
from collections import Counter
print(f"themes: {hit}/{len(items)} matched from tables;", Counter(t for i in items for t in i["themes"]))
