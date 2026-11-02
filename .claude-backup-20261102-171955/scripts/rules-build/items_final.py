# Magic items (DMG 2024): headings found by their "Type, Rarity (Requires Attunement)"
# line, names cleaned by items_names.py plus the explicit fixes below.
import re, json, items_names as N, clean, textfix
FIX = {
 "Ammunition +1, +2, of +3": "Ammunition, +1, +2, or +3", "And Location": "Amulet of Proof against Detection and Location",
 "Reproaching Shield": "Arrow-Catching Shield", "Axe of the Dwarves Colors": "Axe of the Dwarvish Lords", "Bawa Yaoa's Dancing Broom": "Baba Yaga's Dancing Broom",
 "Back of Beans": "Bag of Beans", "Daern of Enor": "Dagger of Venom", "Daern Ysgard Amulet": "Dark Shard Amulet", "Drifiglobe": "Driftglobe",
 "Dust of Sneezing and Holding": "Dust of Sneezing and Choking", "Epreeti Bottle": "Efreeti Bottle", "Ersatz Elven": "Ersatz Eye",
 "Figurine of Wondrous": "Figurine of Wondrous Power", "Ofjumping Boat": "Folding Boat", "Green of Seeing": "Gem of Seeing", "Hat Eye": "Hag Eye",
 "War of Vermin": "Hat of Vermin", "Heward's Handy Caverns": "Heward's Handy Haversack", "Heward's Handy Spice": "Heward's Handy Spice Pouch",
 "Horn Ofsilent Alarm": "Horn of Silent Alarm", "Horseshoes Ofa Zephyr": "Horseshoes of a Zephyr", "Instrument Ofillusions": "Instrument of Illusions",
 "Ring Ofjumping": "Ring of Jumping", "Ring Ofx-ray Vision": "Ring of X-ray Vision", "Tron Flask": "Iron Flask", "Lute of Thunderous Jumping": "Lute of Thunderous Thumping",
 "Manta of Bottle Health": "Manual of Bodily Health", "Manual of Quickness of": "Manual of Quickness of Action", "Nine Flies Stalker": "Nine Lives Stealer",
 "Nolzur's Marvelous Points": "Nolzur's Marvelous Pigments", "Poi of Etherealness": "Oil of Etherealness", "Horse of Dwarvenkind": "Orb of Dragonkind",
 "Horse of Time": "Orb of Time", "Potion of Clairvopance": "Potion of Clairvoyance", "Rod of Tyrant Summoning": "Ring of Djinni Summoning",
 "Ring of Elemental Com-": "Ring of Elemental Command", "Rope of Security": "Rod of Security", "Rope of the Space Deep": "Rod of the Pact Keeper",
 "Shield +1, +2, of +3": "Shield, +1, +2, or +3", "Stars of Healing": "Staff of Healing", "Stars of Striding": "Staff of Striking",
 "Sra of Warning Secrets": "Staff of Swarming Insects", "Stone of Gops Luck Blackstone": "Stone of Good Luck (Luckstone)", "Sword of Has": "Sword of Kas",
 "Talking Bottle": "Talking Doll", "Wand of Ruins": "Wand of Orcus", "Wand of the War Mace +1, +2, of +3": "Wand of the War Mage, +1, +2, or +3",
 "Wand of Weeks": "Wand of Web", "Weapon +1, +2, of +3": "Weapon, +1, +2, or +3", "Well of Many Wraps": "Well of Many Worlds",
 "Belt of Dwarvenkind": "Belt of Dwarvenkind", "Moonstruck Sword": "Moon-Touched Sword", "Armor #1, +2, of +3": "Armor, +1, +2, or +3", "Crystal Ball": "Crystal Ball",
}
ELEMENTALS = ["Bowl of Commanding Water Elementals", "Brazier of Commanding Fire Elementals", "Stone of Controlling Earth Elementals"]
t = open('txt/dmg-items.txt').read().split('\n')
hits = json.load(open('items_hits.json'))
def slug(n): return re.sub(r"[^a-z0-9]+", "-", n.lower().replace("'", "")).strip('-')
items, el = [], 0
for k, hit in enumerate(hits):
    raw = hit['name'] or ''
    if raw.lower().startswith('this rod has a flanged head'): name = "Rod of Lordly Might"
    elif raw.strip().upper() == 'ELEMENTALS': name = ELEMENTALS[el]; el += 1
    else:
        name = N.clean_name(raw)
        name = FIX.get(name, name)
    # type line can wrap onto the next line (long attunement requirement)
    tl = hit['typeline']; i = hit['i'] + 1
    # skip the physical lines already folded into the type line
    extra = tl.count(' ') - t[hit['i']].strip().count(' ')
    while extra > 0 and i < len(t):
        if t[i].strip(): extra -= t[i].strip().count(' ') + 1
        i += 1
    while i < len(t) and not t[i].strip(): i += 1
    while i < len(t) and (tl.count('(') > tl.count(')') or re.match(r"\s*\(\+?\d\)|\s*(Rare|Very Rare|Legendary|Uncommon)\b", t[i])):
        tl += ' ' + t[i].strip(); i += 1
        while i < len(t) and not t[i].strip(): i += 1
    end = hits[k + 1]['i'] - 2 if k + 1 < len(hits) else min(len(t), i + 80)
    body = [l for l in t[i:end] if not l.startswith('@@') and not re.fullmatch(r"\s*\d{1,3}\s*", l) and not re.search(r"CHAPTER\s*7|MAGIC ITEMS A", l.replace(' ', ''), re.I)]
    # drop trailing heading lines that belong to the next item
    while body and (not body[-1].strip() or (body[-1].strip().isupper() and len(body[-1].strip()) < 50)): body.pop()
    body = [l for l in body if l.strip()]
    desc = textfix.fix(clean.clean('\n'.join(body)))
    desc = re.sub(r"\n{2,}", "\n", desc).strip()
    m = re.match(r"(Wondrous Item|Armor|Weapon|Potion|Ring|Rod|Scroll|Staff|Wand)\s*(\(([^)]*)\))?\s*,\s*(.*)$", tl, re.I)
    itype, sub, rest = (m.group(1).title(), m.group(3), m.group(4)) if m else ("Wondrous Item", None, tl)
    rest = rest.lstrip("‘'\" ")
    rar = re.match(r"(Rarity Vari\w*|Varies|Common|Uncommon|Very Rare|Rare|Legendary|Artifact)", rest, re.I)
    rarity = "Varies" if (not rar or rar.group(1).lower().startswith(("rarity", "vari"))) else rar.group(1).title()
    if re.search(r"\(\+1\).*\(\+?2\)|or Very Rare|, or ", rest.split("(Requires")[0]): rarity = "Varies"
    att = re.search(r"Requires Attunement(?:\s*(?:by|with)\s*([^)]*))?", rest, re.I)
    charges = re.search(r"has (\d+|\w+) charges", desc)
    flat = desc.replace('\n', ' ')
    bonus = re.search(r"\+(\d)\s+bonus to (?:attack (?:rolls )?and damage rolls|Armor Class|AC)", flat)
    acb = re.search(r"\+(\d)\s+bonus to (?:Armor Class|AC)", flat)
    saveb = re.search(r"\+(\d)\s+bonus to (?:Armor Class and )?saving throws", flat)
    atkb = re.search(r"\+(\d)\s+bonus to attack (?:rolls )?and damage rolls", flat)
    sents = re.split(r"(?<=[.!?])\s", desc.replace('\n', ' '))
    items.append(dict(id=slug(name), name=name, type=itype, subtype=(sub or "").strip() or None, rarity=rarity,
        attunement=bool(att), attunementBy=(att.group(1).strip(" .") if att and att.group(1) else None),
        charges=charges.group(1) if charges else None, bonus=int(bonus.group(1)) if bonus else None,
        acBonus=int(acb.group(1)) if acb and itype not in ("Armor",) else None, saveBonus=int(saveb.group(1)) if saveb else None,
        attackBonus=int(atkb.group(1)) if atkb else None, variable=bool(re.search(r"\+1, \+2, or \+3", name)),
        summary=" ".join(sents[:2])[:300], description=desc, source="DMG 2024"))
# Potions of Healing are one entry with a table in the DMG; split into the four potions
for it in list(items):
    if 'healing' in it['name'].lower() and it['type'] == 'Potion' and 'depends on the potion' in it['description'].replace('\n', ' '):
        items.remove(it)
        for nm, dice, rar, cost in [("Potion of Healing", "2d4+2", "Common", 50), ("Potion of Greater Healing", "4d4+4", "Uncommon", 100), ("Potion of Superior Healing", "8d4+8", "Rare", 1000), ("Potion of Supreme Healing", "10d4+20", "Very Rare", 10000)]:
            items.append(dict(id=slug(nm), name=nm, type="Potion", subtype=None, rarity=rar, attunement=False, attunementBy=None, charges=None, bonus=None, healDice=dice,
                summary=f"You regain {dice} Hit Points when you drink this potion.", description=f"You regain {dice} Hit Points when you drink this potion. Whatever its potency, the potion's red liquid glimmers when agitated.", source="DMG 2024"))
items.sort(key=lambda i: i['name'])
seen = {}
for it in items:
    if it['id'] in seen: it['id'] += '-2'
    seen[it['id']] = 1
json.dump(items, open('../../data/magic-items.json', 'w'), indent=0, ensure_ascii=False)
import collections
print(len(items), collections.Counter(i['rarity'] for i in items), collections.Counter(i['type'] for i in items))
print(sum(1 for i in items if len(i['description']) < 60), [i['name'] for i in items if len(i['description']) < 60][:10])
