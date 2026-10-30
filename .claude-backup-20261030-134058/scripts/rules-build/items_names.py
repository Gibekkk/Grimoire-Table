# Fix OCR'd magic item headings: word-level correction against the DMG's own
# vocabulary, then snap to a name seen in the DMG's treasure tables when close.
import re, json, difflib, collections, os
full = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'txt/dmg-full.txt')).read()
WORDS = set(w.strip().lower() for w in open('/usr/share/dict/words') if w.strip().isalpha())
cap = collections.Counter(w for w in re.findall(r"\b[A-Z][a-z’']{2,}\b", full))
VOCAB = {w.lower() for w, c in cap.items() if c >= 3} | {w for w in WORDS if len(w) > 2}
SMALL = {'of', 'the', 'and', 'or', 'a', 'an', 'in', 'from', 'against', 'to', 'x'}
table = set()
for m in re.finditer(r"(?:^|\s)\d{2}(?:\s?[-–]\s?\d{2})?\s{1,5}([A-Z][A-Za-z’' ,+\-]{3,48}?)(?=\s{2,}|$)", full, re.M):
    n = re.sub(r"\s+", " ", m.group(1)).strip(" ,")
    if " " in n or len(n) > 5: table.add(n)
ITEM_WORDS = set("""boots cloak gem goggles rod staff sword wand ring robe orb potion oathbow ioun heward bag belt bracers brooch cap circlet cube dagger deck decanter dust efreeti elixir figurine gauntlets gloves hammer hat helm horn horseshoes instrument javelin lantern mace manual medallion mirror necklace oil pearl periapt pipes rope scarab scimitar shield slippers sphere stone talisman tome trident wings tyrant night seeing elvenkind jumping displacement darkness striding springing levitation protection resistance invisibility flying wizardry warning sharpness wounding vengeance answering holding tricks beans eyes eagle charming minute arrow armor plate leather chain mail breastplate studded glamoured mithral adamantine dwarven elven energy bow vicious defender dragon slayer giant flame tongue frost brand holy avenger luck blessing evasion feather falling free action regeneration shooting stars telekinesis warmth water walking spell storing turning mind shielding animal influence djinni summoning elemental command three wishes x-ray vision absorption alertness lordly might rulership security""".split())
for h in json.load(open('items_hits.json')):
    n = h.get('name') or ''
    if n.isupper(): ITEM_WORDS.update(w.lower() for w in re.findall(r"[A-Za-z]+", n) if len(w) > 2)
for n in table: ITEM_WORDS.update(w.lower() for w in re.findall(r"[A-Za-z]+", n) if len(w) > 2)
OF_VARIANTS = {'of', 'or', 'ofa'}
def fix_word(w):
    core = re.sub(r"[^A-Za-z’']", "", w)
    if not core: return w
    lw = core.lower()
    if lw in ('or', 'of'): return 'of'
    if lw in SMALL: return core
    if lw in ITEM_WORDS: return core
    m = difflib.get_close_matches(lw, [v for v in ITEM_WORDS if abs(len(v) - len(lw)) <= 2], 1, 0.6)
    if m: return m[0]
    if lw in VOCAB: return core
    m = difflib.get_close_matches(lw, [v for v in VOCAB if abs(len(v) - len(lw)) <= 2], 1, 0.6)
    return m[0] if m else core
def title(words):
    out = []
    for i, w in enumerate(words):
        lw = w.lower()
        out.append(lw if (lw in SMALL and i) else (w[:1].upper() + w[1:].lower() if w.isupper() or w.islower() else w[:1].upper() + w[1:].lower()))
    return " ".join(out).replace("’", "'")
tl = {re.sub(r"[^a-z]", "", n.lower()): n.replace("’", "'") for n in table}
def clean_name(raw):
    raw = re.sub(r"^[‘'\"`]+", "", raw or "").strip()
    raw = re.sub(r"[’'](s)\b", r"'\1", raw, flags=re.I)
    raw = re.sub(r"\b[Oo][Ff](?=[a-z]{3,})", "of ", raw)          # "Ofjumping" -> "of jumping"
    raw = re.sub(r"\b[Oo][Ff][Aa]\b", "of a", raw)
    words = raw.replace("’", "'").split()
    fixed = []
    for w in words:
        poss = re.match(r"(.+?)('s)$", w, re.I)
        base, suf = (poss.group(1), "'s") if poss else (w, "")
        fixed.append(fix_word(base) + suf)
    name = title(fixed)
    key = re.sub(r"[^a-z]", "", name.lower())
    m = difflib.get_close_matches(key, tl.keys(), 1, 0.86)
    if m:
        cand = re.sub(r"\s*\(.*$", "", tl[m[0]]).strip(" ,")
        if len(cand) > 3: name = title(cand.split())
    return name
if __name__ == "__main__":
    hits = json.load(open('items_hits.json'))
    for h in hits[::6]: print(repr(h['name']), '->', clean_name(h['name']))
