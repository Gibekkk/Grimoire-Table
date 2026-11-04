# Default token art for every monster, from the CC0 "Dungeon Crawl Stone Soup"
# tile set (https://opengameart.org/content/dungeon-crawl-32x32-tiles).
# Download "Dungeon Crawl Stone Soup Full_0.zip" from that page, then:
#     python3 monster_tokens.py path/to/that.zip
# Copies the tiles in use to assets/monster-tokens/ and sets `token` on each
# monster in data/monsters.json. First matching rule wins; anything unmatched
# falls back to a generic tile for its creature type.
import json, os, re, sys, zipfile
from collections import Counter

MONSTERS = "../../data/monsters.json"
OUT = "../../assets/monster-tokens"
ZIP = sys.argv[1]

RULES = [
    # Dragons, by colour (wyrmlings are drakes)
    (r"green dragon wyrmling", "forest_drake"), (r"black dragon wyrmling", "swamp_drake"),
    (r"white dragon wyrmling", "ice_beast"), (r"blue dragon wyrmling", "storm_dragon"),
    (r"red dragon", "fire_drake"), (r"black dragon", "swamp_dragon"), (r"green dragon", "dragon"), (r"blue dragon", "storm_dragon"), (r"white dragon", "ice_dragon"),
    (r"gold dragon", "golden_dragon"), (r"silver dragon", "quicksilver_dragon"), (r"brass dragon", "eastern_dragon"), (r"bronze dragon", "iron_dragon"), (r"copper dragon", "steam_dragon"),
    (r"shadow dragon", "shadow_dragon"), (r"dracolich", "bone_dragon"), (r"faerie dragon", "butterfly"), (r"pseudodragon", "lindwurm"), (r"half-dragon", "draconic_base-red"),
    (r"dragon turtle", "snapping_turtle"), (r"wyvern", "wyvern"),
    # Elementals, genies, giants
    (r"air elemental|invisible stalker|elemental cataclysm", "air_elemental"), (r"earth elemental|galeb duhr|xorn", "earth_elemental"), (r"fire elemental|magmin", "fire_elemental"),
    (r"water elemental|water weird", "water_elemental"), (r"efreeti|azer", "efreet"), (r"djinni|dao|marid", "efreet"), (r"mephit", "white_imp"),
    (r"fire giant", "fire_giant"), (r"frost giant", "frost_giant"), (r"hill giant", "hill_giant"), (r"stone giant", "stone_giant"), (r"cloud giant|storm giant", "titan"),
    (r"cyclops", "cyclops"), (r"ettin", "ettin"), (r"fomorian", "two_headed_ogre"), (r"empyrean|colossus", "antaeus"), (r"ogre zombie", "zombie_ogre"), (r"ogre|ogrillon", "ogre"), (r"oni", "ogre_mage"), (r"troll", "troll"),
    # Undead
    (r"death knight", "death_knight"), (r"demilich", "curse_skull"), (r"flameskull", "flying_skull"), (r"archlich|lich", "lich"), (r"mummy lord", "greater_mummy"), (r"mummy", "mummy"),
    (r"vampire", "vampire"), (r"ghast", "necrophage"), (r"ghoul", "ghoul"), (r"wraith", "wraith"), (r"wight", "wight"), (r"specter|poltergeist|banshee", "phantom"), (r"ghost", "ghost"), (r"shadow demon", "shadow_demon"), (r"^shadow$", "shadow"),
    (r"revenant", "revenant"), (r"beholder zombie", "giant_eyeball"), (r"zombie", "zombie_small"), (r"warhorse skeleton", "skeleton_quadruped_large"), (r"minotaur skeleton", "skeleton_humanoid_large"), (r"skeleton", "skeletal_warrior"),
    (r"crawling claw", "crawling_corpse"), (r"will-o", "insubstantial_wisp"), (r"bone naga|spirit naga|guardian naga", "guardian_naga"),
    # Beholders, aberrations, oozes
    (r"beholder|death tyrant", "great_orb_of_eyes"), (r"spectator|nothic", "giant_eyeball"), (r"gibbering mouther", "macabre_mass"), (r"mind flayer", "deep_elf_sorcerer"), (r"intellect devourer", "brain_worm"),
    (r"aboleth", "tentacled_starspawn"), (r"chuul|otyugh|grell|roper", "tentacled_monstrosity"), (r"cloaker|darkmantle", "shadow_imp"), (r"flumph", "jellyfish"), (r"slaad", "blink_frog"),
    (r"gelatinous cube", "azure_jelly"), (r"black pudding", "death_ooze"), (r"gray ooze", "ooze"), (r"ochre jelly", "brown_ooze"), (r"blob of annihilation", "pulsating_lump"), (r"mimic", "shapeshifter"), (r"doppelganger", "glowing_shapeshifter"),
    # Fiends
    (r"pit fiend", "pit_fiend"), (r"balor", "balrug"), (r"ice devil", "ice_devil"), (r"bone devil", "skeletal_warrior"), (r"horned devil", "red_devil"), (r"barbed devil|spined devil", "hairy_devil"), (r"bearded devil|chain devil", "iron_devil"), (r"erinyes", "blue_devil"),
    (r"lemure", "lemure"), (r"manes", "manes"), (r"imp", "imp"), (r"quasit", "quasit"), (r"dretch", "orange_demon"), (r"succubus|incubus", "mara"), (r"marilith", "lamia"), (r"glabrezu|goristro", "executioner"), (r"hezrou|barlgura|nalfeshnee", "green_death"), (r"vrock|chasme", "hellwing"),
    (r"yochlol", "ooze"), (r"cambion", "demonspawn"), (r"arcanaloth|mezzoloth|nycaloth|ultroloth", "cacodemon"), (r"rakshasa", "rakshasa"), (r"hell hound", "hell_hound"), (r"nightmare", "hell_hog"), (r"larva|larvae", "worm"),
    # Celestials and fey
    (r"solar|planetar|deva", "angel"), (r"couatl", "mana_viper"), (r"unicorn|pegasus", "shedu"), (r"sphinx", "sphinx"), (r"dryad", "dryad"), (r"satyr", "satyr"), (r"pixie|sprite", "spriggan"), (r"hag", "kirke"), (r"animal lord", "beast"),
    # Monstrosities
    (r"basilisk", "basilisk"), (r"behir", "lava_snake"), (r"manticore", "manticore"), (r"chimera", "hydrataur"), (r"hydra", "hydra_5"), (r"griffon", "griffon"), (r"hippogriff", "hippogriff"), (r"harpy", "harpy"), (r"peryton", "hippogriff"), (r"owlbear", "grizzly_bear"), (r"medusa", "greater_naga"), (r"lamia", "lamia"), (r"minotaur", "minotaur"), (r"centaur", "centaur_warrior"), (r"drider|ettercap", "orb_spider"),
    (r"purple worm", "swamp_worm"), (r"remorhaz", "lava_worm"), (r"bulette|ankheg|umber hulk", "boulder_beetle"), (r"carrion crawler", "giant_centipede"), (r"rust monster", "boring_beetle"), (r"hook horror", "unseen_horror"), (r"grick", "spiny_worm"), (r"kraken", "kraken_head"), (r"tarrasque", "juggernaut"), (r"displacer beast", "death_yak"), (r"blink dog|death dog", "hound"), (r"worg", "warg"), (r"winter wolf", "ice_beast"), (r"yeti", "ice_fiend"), (r"cockatrice", "caustic_shrike"), (r"axe beak", "caustic_shrike"), (r"roc", "griffon"), (r"stirge", "giant_mosquito"), (r"gorgon", "death_yak"), (r"phase spider", "orb_spider"), (r"piercer", "giant_slug"),
    # Constructs and plants
    (r"clay golem", "clay_golem"), (r"flesh golem", "flesh_golem"), (r"iron golem", "iron_golem"), (r"stone golem", "stone_golem"), (r"shield guardian|helmed horror|animated armor", "guardian_golem"), (r"animated flying sword|animated broom", "spectral_axe"), (r"rug of smothering", "shadow_imp"), (r"modron", "orb_of_electricity"), (r"homunculus", "white_imp"), (r"gargoyle", "gargoyle"), (r"scarecrow", "training_dummy"),
    (r"treant|awakened tree|tree blight|gulthias", "treant"), (r"twig blight|needle blight|awakened shrub", "bush_2"), (r"vine blight", "thorn_hunter"), (r"shambling mound", "briar_patch"), (r"myconid|fungus", "wandering_mushroom"),
    # Peoples
    (r"goblin boss|goblin hexer|goblin", "goblin"), (r"hobgoblin", "hobgoblin"), (r"bugbear", "big_kobold"), (r"kobold", "kobold"), (r"gnoll", "gnoll"), (r"kuo-toa|bullywug", "giant_toad"), (r"lizardfolk|troglodyte", "salamander"), (r"sahuagin|merrow", "merfolk_impaler"), (r"merfolk", "merfolk_fighter"), (r"salamander", "salamander_firebrand"),
    (r"githyanki|githzerai", "deep_elf_blademaster"), (r"yuan-ti", "naga_warrior"), (r"kenku|aarakocra", "kenku_winged"), (r"thri-kreen", "giant_mite"), (r"quaggoth|grimlock", "deep_troll"), (r"jackalwere|jackal", "jackal"), (r"werebear", "black_bear"), (r"wereboar", "hog"), (r"wererat", "green_rat"), (r"weretiger|werewolf", "wolf"),
    (r"archmage|^mage|wizard", "wizard"), (r"archpriest|priest", "orc_high_priest"), (r"cultist", "necromancer"), (r"druid", "enchantress_human"), (r"knight", "hell_knight"), (r"gladiator|warrior|berserker|tough|guard|bandit|pirate", "human"), (r"assassin|spy|scout", "deep_elf_master_archer"), (r"commoner|noble|performer", "human_slave"),
    # Beasts
    (r"polar bear", "polar_bear"), (r"black bear", "black_bear"), (r"brown bear", "grizzly_bear"), (r"dire wolf", "warg"), (r"wolf", "wolf"), (r"swarm of bats|giant bat|^bat", "giant_bat"), (r"swarm of ravens|raven", "raven"), (r"swarm of rats|giant rat|^rat", "grey_rat"), (r"swarm of insects", "killer_bee"), (r"swarm of piranhas|piranha", "giant_goldfish"), (r"swarm of venomous|snake", "snake"),
    (r"allosaurus|tyrannosaurus|triceratops|ankylosaurus|plesiosaurus", "komodo_dragon"), (r"pteranodon", "wyvern"), (r"archelon", "alligator_snapping_turtle"), (r"mammoth|elephant", "elephant"), (r"hippopotamus|rhinoceros", "yak"), (r"crocodile", "crocodile"), (r"shark|killer whale", "shark"), (r"octopus|squid", "kraken_head"), (r"crab", "fire_crab"),
    (r"giant wasp", "red_wasp"), (r"giant centipede", "giant_centipede"), (r"giant fire beetle", "giant_beetle"), (r"giant wolf spider", "wolf_spider"), (r"giant spider|spider", "redback"), (r"scorpion", "giant_scorpion"), (r"lizard", "giant_lizard"), (r"frog|toad", "giant_frog"), (r"boar", "hog"), (r"goat", "sheep"), (r"horse|warhorse|pony|mule|camel|elk|deer", "yak"),
    (r"eagle|hawk|owl|vulture", "raven"), (r"seahorse", "electric_eel"), (r"lion|tiger|panther|cat$", "hound"), (r"mastiff|hyena", "war_dog"), (r"ape|baboon", "monstrous"), (r"badger|weasel", "quokka"),
]
FALLBACK = {
    "aberration": "tentacled_monstrosity", "beast": "beast", "celestial": "angel", "construct": "stone_golem", "dragon": "dragon", "elemental": "air_elemental", "fey": "faun",
    "fiend": "red_devil", "giant": "hill_giant", "humanoid": "human", "monstrosity": "chaos_spawn", "ooze": "ooze", "plant": "plant", "swarm": "killer_bee", "undead": "ghoul"
}

z = zipfile.ZipFile(ZIP)
tiles = {}
for n in z.namelist():
    if n.lower().endswith(".png") and "/monster/" in n.lower():
        tiles.setdefault(os.path.basename(n)[:-4].lower(), n)

def resolve(base):
    for name in (f"{base}_new", base, f"{base}_old"):
        if name in tiles: return name
    raise SystemExit(f"no tile called {base}")

missing = sorted({t for _, t in RULES} | set(FALLBACK.values()) - {None})
missing = [t for t in missing if not any(f"{t}{x}" in tiles for x in ("_new", "", "_old"))]
if missing: raise SystemExit(f"no such tiles: {missing}")

monsters = json.load(open(MONSTERS))
used, how = set(), Counter()
for m in monsters:
    name = m["name"].lower()
    # whole words only: "roc" must not match "crocodile", nor "oni" "demoniac"
    tile = next((t for rx, t in RULES if re.search(rf"\b(?:{rx})(?:s|es)?\b", name)), None)
    how["rule" if tile else "type"] += 1
    if not tile:
        ctype = m.get("creatureType", "").lower()
        tile = next((v for k, v in FALLBACK.items() if k in ctype), "chaos_spawn")
        print("  by type:", m["name"], "->", tile)
    real = resolve(tile)
    m["token"] = f"{real}.png"
    used.add(real)

os.makedirs(OUT, exist_ok=True)
for f in os.listdir(OUT):
    if f.endswith(".png") and f[:-4] not in used: os.remove(os.path.join(OUT, f))
for real in used:
    with open(os.path.join(OUT, f"{real}.png"), "wb") as f: f.write(z.read(tiles[real]))
with open(MONSTERS, "w") as f:
    f.write("[\n" + ",\n".join(json.dumps(m, ensure_ascii=False, separators=(",", ":")) for m in monsters) + "\n]\n")
with open(os.path.join(OUT, "CREDITS.txt"), "w") as f:
    f.write("Monster token art: Dungeon Crawl Stone Soup tiles (RLTiles and the Crawl Stone Soup artists).\n"
            "Released under CC0 1.0 (public domain dedication); no attribution required, credit given anyway.\n"
            "Source: https://opengameart.org/content/dungeon-crawl-32x32-tiles\n"
            "Licence: https://creativecommons.org/publicdomain/zero/1.0/\n"
            "These are closest-match fantasy creatures, not official art of the monsters they stand in for.\n")
print(f"tokens: {len(used)} tiles for {len(monsters)} monsters;", dict(how))
