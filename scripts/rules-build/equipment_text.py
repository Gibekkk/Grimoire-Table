# Adds the Player's Handbook (2024) chapter 6 descriptions to data/equipment.json:
# every Adventuring Gear entry ("ACID (25 GP)" + text), every tool (Ability /
# Utilize / Craft), and the weapon property and mastery definitions, so the item
# compendium and loot can show what an item does. Reads txt/phb-cols.txt (build.sh).
import json, re
from clean import clean
from textfix import fix

EQUIP = "../../data/equipment.json"
lines = open("txt/phb-cols.txt").read().split("\n")
# Chapter 6 runs from the Weapons section to the last "CHAPTER 6" page footer
end = max(i for i, l in enumerate(lines) if re.search(r"CHAPTER\s*6", l)) + 60
start = next(i for i, l in enumerate(lines) if re.match(r"^\s*WEAPONS\s*$", l) and i > end - 4000)

def letters(s): return re.sub(r"[^a-z]", "", s.lower())

# A heading is an all-caps line (the OCR adds stray spaces and dashes), with an optional price
HEAD = re.compile(r"^[-~_\s·•.,=:]*([A-Z][A-Z'’ ,.\-/]{2,48}?)\s*(\(([^)]*)[)~]?)?\s*$")
def heading(l):
    m = HEAD.match(l)
    if not m or re.search(r"CHAPTER|@@", l): return None
    name = m.group(1).strip()
    if len(letters(name)) < 3 or sum(c.isupper() for c in name) < 0.7 * sum(c.isalpha() for c in name): return None
    return name, (m.group(3) or "").strip()

entries = []  # (letters key, raw heading, price, body lines)
cur = None
for l in lines[start:end]:
    if l.startswith("@@") or re.search(r"CHAPTER\s*6", l): continue
    hd = heading(l.strip())
    if hd:
        cur = (letters(hd[0]), hd[0], hd[1], []); entries.append(cur)
    elif cur is not None:
        cur[3].append(l)

# OCR leftovers: page footers and numbers, rule lines, l/I/O read for digits
TIDY = [(r"CHAPTER\s*6\s*[I|]\s*EQUIPMEN\s*T?\s*~?\d*", ""), (r"\bDC\s*[lI1]\s*([0-9])", r"DC 1\1"), (r"\b[lI]\s+lb\.", "1 lb."),
        (r"\((I|l)O GP\)", "(10 GP)"), (r"\(\s*[lI]\s+(GP|SP|CP)\)", r"(1 \1)"), (r"(\s[-~_=·•]+)+\s*$", ""), (r"\s+\d{2,3}\s*$", ""), (r"\s{2,}", " ")]
def body(ls):
    text = fix(clean("\n".join(ls).strip()))
    text = re.sub(r"\s*\n\s*", " ", text).strip()
    for a, b in TIDY: text = re.sub(a, b, text).strip()
    return text

# Keyed by letters, and by sorted words so "CLOTHES, FINE" matches "Fine Clothes".
# A priced entry (an item) beats an unpriced heading of the same name (a rule).
def wordkey(s): return " ".join(sorted(letters(w) for w in re.sub(r"\(.*?\)", "", s).replace(",", " ").split() if letters(w)))
found, priced = {}, set()
for key, name, price, ls in entries:
    t = body(ls)
    if len(t) <= 15: continue
    for k in (key, wordkey(name)):
        if k not in found or (price and k not in priced):
            found[k] = t
            if price: priced.add(k)

# Items described under a shared entry
SHARED = {"instrument": "musicalinstrument", "gaming": "gamingset", "ammo": "ammunition"}
INSTRUMENTS = {"Bagpipes", "Drum", "Dulcimer", "Flute", "Horn", "Lute", "Lyre", "Pan Flute", "Shawm", "Viol"}
GAMING = {"Dice Set", "Dragonchess Set", "Playing Cards", "Three-Dragon Ante Set"}

def lookup(name, group=None):
    if name in INSTRUMENTS: return found.get(SHARED["instrument"])
    if name in GAMING: return found.get(SHARED["gaming"])
    if group == "ammo": return found.get(SHARED["ammo"])
    k = letters(re.sub(r"\(.*?\)", "", name))
    for cand in (k, k.rstrip("s"), k + "s", wordkey(name)):
        if cand in found: return found[cand]
    return None

eq = json.load(open(EQUIP))
hits = 0
for group in ("gear", "tools", "ammo"):
    for it in eq[group]:
        d = lookup(it["name"], group)
        if d:
            it["description"] = d; hits += 1
        else:
            it.pop("description", None)

PROPS = ["Ammunition", "Finesse", "Heavy", "Light", "Loading", "Range", "Reach", "Thrown", "Two-Handed", "Versatile"]
MASTERY = ["Cleave", "Graze", "Nick", "Push", "Sap", "Slow", "Topple", "Vex"]
# Properties and masteries share names with other chapter-6 headings ("LIGHT" armor), so
# take the first definition after each section's own heading
def section_defs(section_head, names):
    i0 = next(i for i, e in enumerate(entries) if e[0] == letters(section_head))
    out = {}
    for key, name, price, ls in entries[i0 + 1:i0 + 1 + 3 * len(names)]:
        n = next((x for x in names if letters(x) == key), None)
        if n and n not in out: out[n] = body(ls)
    return out
eq["properties"] = section_defs("Properties", PROPS)
eq["masteries"] = section_defs("Mastery Properties", MASTERY)
# Definitions the scan breaks across a page or column, or garbles, corrected against the book
FIX = {
    "Light": "When you take the Attack action on your turn and attack with a Light weapon, you can make one extra attack as a Bonus Action later on the same turn. That extra attack must be made with a different Light weapon, and you don't add your ability modifier to the extra attack's damage unless that modifier is negative.",
    "Thrown": "If a weapon has the Thrown property, you can throw the weapon to make a ranged attack, and you can draw that weapon as part of the attack. If the weapon is a Melee weapon, use the same ability modifier for the attack and damage rolls that you use for a melee attack with that weapon.",
    "Two-Handed": "A Two-Handed weapon requires two hands when you attack with it.",
    "Versatile": "A Versatile weapon can be used with one or two hands. A damage value in parentheses appears with the property. The weapon deals that damage when used with two hands to make a melee attack.",
}
MFIX = {
    "Cleave": "If you hit a creature with a melee attack roll using this weapon, you can make a melee attack roll with the weapon against a second creature within 5 feet of the first that is also within your reach. On a hit, the second creature takes the weapon's damage, but don't add your ability modifier to that damage unless that modifier is negative. You can make this extra attack only once per turn.",
    "Nick": "When you make the extra attack of the Light property, you can make it as part of the Attack action instead of as a Bonus Action. You can make this extra attack only once per turn.",
    "Topple": "If you hit a creature with this weapon, you can force the creature to make a Constitution saving throw (DC 8 plus the ability modifier used to make the attack roll and your Proficiency Bonus). On a failed save, the creature has the Prone condition.",
    "Vex": "If you hit a creature with this weapon and deal damage to the creature, you have Advantage on your next attack roll against that creature before the end of your next turn.",
}
eq["properties"].update(FIX)
eq["masteries"].update(MFIX)
eq["properties"] = {k: eq["properties"][k] for k in PROPS if k in eq["properties"]}
json.dump(eq, open(EQUIP, "w"), indent=0, ensure_ascii=False)  # the file's existing layout
total = sum(len(eq[g]) for g in ("gear", "tools", "ammo"))
print(f"equipment text: {hits}/{total} gear/tools/ammo described; {len(eq['properties'])} properties, {len(eq['masteries'])} masteries")
missing = sorted({it["name"] for g in ("gear", "tools", "ammo") for it in eq[g] if "description" not in it})
print("no text:", missing)
