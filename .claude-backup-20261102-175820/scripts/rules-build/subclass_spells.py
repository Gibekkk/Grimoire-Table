# Always-prepared subclass spells (PHB 2024), keyed by subclass id → class level → spell names.
# Circle of the Land picks one terrain; its lists are keyed "arid"/"polar"/"temperate"/"tropical".
S = {
 'life-domain': {3: 'Aid, Bless, Cure Wounds, Lesser Restoration', 5: 'Mass Healing Word, Revivify', 7: 'Aura of Life, Death Ward', 9: 'Greater Restoration, Mass Cure Wounds'},
 'light-domain': {3: 'Burning Hands, Faerie Fire, Scorching Ray, See Invisibility', 5: 'Daylight, Fireball', 7: 'Arcane Eye, Wall of Fire', 9: 'Flame Strike, Scrying'},
 'trickery-domain': {3: 'Charm Person, Disguise Self, Invisibility, Pass without Trace', 5: 'Hypnotic Pattern, Nondetection', 7: 'Confusion, Dimension Door', 9: 'Dominate Person, Modify Memory'},
 'war-domain': {3: 'Guiding Bolt, Magic Weapon, Shield of Faith, Spiritual Weapon', 5: "Crusader's Mantle, Spirit Guardians", 7: 'Fire Shield, Freedom of Movement', 9: 'Hold Monster, Steel Wind Strike'},
 'oath-of-devotion': {3: 'Protection from Evil and Good, Shield of Faith', 5: 'Aid, Zone of Truth', 9: 'Beacon of Hope, Dispel Magic', 13: 'Freedom of Movement, Guardian of Faith', 17: 'Commune, Flame Strike'},
 'oath-of-glory': {3: 'Guiding Bolt, Heroism', 5: 'Enhance Ability, Magic Weapon', 9: 'Haste, Protection from Energy', 13: 'Compulsion, Freedom of Movement', 17: "Legend Lore, Yolande's Regal Presence"},
 'oath-of-the-ancients': {3: 'Ensnaring Strike, Speak with Animals', 5: 'Misty Step, Moonbeam', 9: 'Plant Growth, Protection from Energy', 13: 'Ice Storm, Stoneskin', 17: 'Commune with Nature, Tree Stride'},
 'oath-of-vengeance': {3: "Bane, Hunter's Mark", 5: 'Hold Person, Misty Step', 9: 'Haste, Protection from Energy', 13: 'Banishment, Dimension Door', 17: 'Hold Monster, Scrying'},
 'circle-of-the-moon': {3: 'Cure Wounds, Moonbeam, Starry Wisp', 5: 'Conjure Animals', 7: 'Fount of Moonlight', 9: 'Mass Cure Wounds'},
 'circle-of-the-sea': {3: 'Fog Cloud, Gust of Wind, Ray of Frost, Shatter, Thunderwave', 5: 'Lightning Bolt, Water Breathing', 7: 'Control Water, Ice Storm', 9: 'Conjure Elemental, Hold Monster'},
 'archfey-patron': {3: 'Calm Emotions, Faerie Fire, Misty Step, Phantasmal Force, Sleep', 5: 'Blink, Plant Growth', 7: 'Dominate Beast, Greater Invisibility', 9: 'Dominate Person, Seeming'},
 'celestial-patron': {3: 'Aid, Cure Wounds, Guiding Bolt, Lesser Restoration, Light, Sacred Flame', 5: 'Daylight, Revivify', 7: 'Guardian of Faith, Wall of Fire', 9: 'Greater Restoration, Summon Celestial'},
 'fiend-patron': {3: 'Burning Hands, Command, Scorching Ray, Suggestion', 5: 'Fireball, Stinking Cloud', 7: 'Fire Shield, Wall of Fire', 9: 'Geas, Insect Plague'},
 'great-old-one-patron': {3: "Detect Thoughts, Dissonant Whispers, Phantasmal Force, Tasha's Hideous Laughter", 5: 'Clairvoyance, Hunger of Hadar', 7: 'Confusion, Summon Aberration', 9: 'Modify Memory, Telekinesis'},
 'aberrant-sorcery': {3: 'Arms of Hadar, Calm Emotions, Detect Thoughts, Dissonant Whispers, Mind Sliver', 5: 'Hunger of Hadar, Sending', 7: "Evard's Black Tentacles, Summon Aberration", 9: "Rary's Telepathic Bond, Telekinesis"},
 'clockwork-sorcery': {3: 'Aid, Alarm, Lesser Restoration, Protection from Evil and Good', 5: 'Dispel Magic, Protection from Energy', 7: 'Freedom of Movement, Summon Construct', 9: 'Greater Restoration, Wall of Force'},
 'draconic-sorcery': {3: "Alter Self, Chromatic Orb, Command, Dragon's Breath", 5: 'Fear, Fly', 7: 'Arcane Eye, Charm Monster', 9: 'Legend Lore, Summon Dragon'},
 'fey-wanderer': {3: 'Charm Person', 5: 'Misty Step', 9: 'Summon Fey', 13: 'Dimension Door', 17: 'Mislead'},
 'gloom-stalker': {3: 'Disguise Self', 5: 'Rope Trick', 9: 'Fear', 13: 'Greater Invisibility', 17: 'Seeming'},
}
LAND = {
 'arid': {3: 'Blur, Burning Hands, Fire Bolt', 5: 'Fireball', 7: 'Blight', 9: 'Wall of Stone'},
 'polar': {3: 'Fog Cloud, Hold Person, Ray of Frost', 5: 'Sleet Storm', 7: 'Ice Storm', 9: 'Cone of Cold'},
 'temperate': {3: 'Misty Step, Shocking Grasp, Sleep', 5: 'Lightning Bolt', 7: 'Freedom of Movement', 9: 'Tree Stride'},
 'tropical': {3: 'Acid Splash, Ray of Sickness, Web', 5: 'Stinking Cloud', 7: 'Polymorph', 9: 'Insect Plague'},
}
import re
def slug(n): return re.sub(r"[^a-z0-9]+", "-", n.lower().replace("'", "")).strip('-')
def resolve(table, spell_ids):
    out = {}
    for lvl, names in table.items():
        ids = [slug(n.strip()) for n in names.split(',')]
        bad = [i for i in ids if i not in spell_ids]
        if bad: raise SystemExit(f"Unknown subclass spells: {bad}")
        out[str(lvl)] = ids
    return out
