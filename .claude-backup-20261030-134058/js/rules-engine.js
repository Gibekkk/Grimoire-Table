// Core rules math for D&D 2024, kept isolated from UI/data-fetching code.

export const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"];
export const ABILITY_NAMES = { str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" };

export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];

export const POINT_BUY_COST = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
export const POINT_BUY_BUDGET = 27;

export function pointBuyTotalCost(scores) {
  return ABILITIES.reduce((sum, a) => sum + (POINT_BUY_COST[scores[a]] ?? 999), 0);
}

export function abilityModifier(score) {
  return Math.floor((score - 10) / 2);
}

// Effective ability score: honors a per-ability manual override (a DM effect,
// a curse, a homebrew ruling) so every downstream calculation stays consistent.
export function effectiveAbilityScore(character, ability) {
  const override = character.abilityOverrides?.[ability];
  return override != null ? override : character.abilityScores[ability];
}
export function effectiveAbilityModifier(character, ability) {
  return abilityModifier(effectiveAbilityScore(character, ability));
}

export function formatModifier(mod) {
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

// Proficiency bonus by total character level (PHB 2024 table).
export function proficiencyBonus(level) {
  if (level >= 17) return 6;
  if (level >= 13) return 5;
  if (level >= 9) return 4;
  if (level >= 5) return 3;
  return 2;
}

export function skillModifier(character, skill, allSkills) {
  const def = allSkills.find(s => s.id === skill.id ?? skill);
  const skillId = def ? def.id : skill.id;
  const override = character.skillOverrides?.[skillId];
  if (override != null) return override;
  const abilityKey = def ? def.ability : skill.ability;
  const base = effectiveAbilityModifier(character, abilityKey);
  const isProficient = character.skillProficiencies?.includes(skillId);
  const isExpert = character.skillExpertise?.includes(skillId);
  const pb = proficiencyBonus(totalLevel(character));
  let bonus = 0;
  if (isExpert) bonus = pb * 2;
  else if (isProficient) bonus = pb;
  return base + bonus;
}

export function savingThrowModifier(character, ability) {
  const override = character.savingThrowOverrides?.[ability];
  if (override != null) return override;
  const base = effectiveAbilityModifier(character, ability);
  const pb = proficiencyBonus(totalLevel(character));
  const proficient = character.savingThrowProficiencies?.includes(ability);
  return base + (proficient ? pb : 0);
}

export function passivePerception(character, allSkills) {
  return 10 + skillModifier(character, { id: "perception" }, allSkills);
}

// AC from equipped armor (if any) plus Dex, following each armor's Dex-bonus cap,
// falling back to Unarmored Defense for Barbarian/Monk levels (any class entry,
// so multiclass characters keep it), then plain 10+Dex.
export function estimateArmorClass(character, equippedArmor, hasShield) {
  if (character.armorClassOverride) return character.armorClassOverride;
  const dexMod = effectiveAbilityModifier(character, 'dex');
  const shieldBonus = hasShield ? 2 : 0;

  if (equippedArmor) {
    let dexPart = 0;
    if (equippedArmor.dexBonus === "full") dexPart = dexMod;
    else if (equippedArmor.dexBonus === "max2") dexPart = Math.min(2, dexMod);
    return equippedArmor.baseAC + dexPart + shieldBonus;
  }

  const classIds = getClassEntries(character).map(e => e.classId);
  const conMod = effectiveAbilityModifier(character, 'con');
  const wisMod = effectiveAbilityModifier(character, 'wis');
  const options = [10 + dexMod + shieldBonus];
  if (classIds.includes("barbarian")) options.push(10 + dexMod + conMod + shieldBonus);
  if (classIds.includes("monk") && !hasShield) options.push(10 + dexMod + wisMod);
  return Math.max(...options);
}

// Max HP across every class entry (PHB 2024): the first class's first level takes
// the full Hit Die, every other level takes the fixed average (die/2 + 1). Con mod
// applies per level, plus Dwarven Toughness / Tough feat bonuses. `classes` may be
// a ruleset.classes list or (legacy callers) a single class definition.
export function maxHitPoints(character, classes, extras = {}) {
  const list = Array.isArray(classes) ? classes : (classes ? [classes] : []);
  const entries = getClassEntries(character);
  if (!entries.length || !list.length) return character.hp?.max || 0;
  const conMod = effectiveAbilityModifier(character, 'con');
  let total = 0, levels = 0;
  entries.forEach((e, idx) => {
    const cls = list.find(c => c.id === e.classId) || (list.length === 1 ? list[0] : null);
    const die = cls?.hitDie || 8;
    for (let l = 1; l <= (e.level || 0); l++) {
      total += (idx === 0 && l === 1) ? die : Math.floor(die / 2) + 1;
      levels++;
    }
  });
  if (levels === 0) levels = character.level || 1;
  total += conMod * levels;
  total += (extras.hpPerLevel || 0) * levels;
  return Math.max(1, total);
}

// Extra HP per level from species (Dwarf) and feats (Tough), looked up from the ruleset.
export function hpPerLevelBonus(character, ruleset) {
  let bonus = 0;
  const sp = ruleset?.species?.find(s => s.id === character.speciesId);
  if (sp?.hpPerLevel) bonus += sp.hpPerLevel;
  characterFeatIds(character, ruleset).forEach(id => {
    const f = ruleset?.feats?.find(x => x.id === id);
    if (f?.grants?.hpPerLevel) bonus += f.grants.hpPerLevel;
  });
  return bonus;
}

// Every feat a character has: background origin feat, Human Versatile feat, and
// feats picked at ASI levels (character.feats[]).
export function characterFeatIds(character, ruleset) {
  const records = character.feats || [];
  const ids = records.map(f => f?.featId).filter(Boolean);
  // Characters from the old builder have no feats[] records for their origin feats
  if (!records.some(f => f.source === "background")) {
    const bg = ruleset?.backgrounds?.find(b => b.id === character.backgroundId);
    if (bg?.featId) ids.push(bg.featId);
  }
  if (character.speciesChoices?.versatile && !records.some(f => f.source === "versatile")) ids.push(character.speciesChoices.versatile);
  return ids;
}

export function computeMaxHp(character, ruleset) {
  return maxHitPoints(character, ruleset.classes, { hpPerLevel: hpPerLevelBonus(character, ruleset) });
}

export function applyBackgroundAsi(baseScores, background, choice) {
  // choice: { mode: 'twoOne', plusTwo: 'str', plusOne: 'dex' } or { mode: 'allOne' }
  const scores = { ...baseScores };
  if (!background) return scores;
  if (choice?.mode === "allOne") {
    background.abilityScores.forEach(a => { scores[a] = Math.min(20, (scores[a] || 8) + 1); });
  } else if (choice?.mode === "twoOne" && choice.plusTwo && choice.plusOne) {
    scores[choice.plusTwo] = Math.min(20, (scores[choice.plusTwo] || 8) + 2);
    scores[choice.plusOne] = Math.min(20, (scores[choice.plusOne] || 8) + 1);
  }
  return scores;
}

export function rollDie(sides) {
  return 1 + Math.floor(secureRandom() * sides);
}

// XP-to-level thresholds (PHB 2024, unchanged from the 2014 table).
export const XP_THRESHOLDS = [
  0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000,
  85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000
];

export function levelForXp(xp) {
  let level = 1;
  for (let i = 0; i < XP_THRESHOLDS.length; i++) {
    if (xp >= XP_THRESHOLDS[i]) level = i + 1;
  }
  return Math.min(20, level);
}

export function xpForNextLevel(level) {
  return level >= 20 ? null : XP_THRESHOLDS[level];
}

export function initiativeModifier(character, ruleset) {
  const base = effectiveAbilityModifier(character, 'dex');
  // Alert (2024): add Proficiency Bonus to Initiative
  const alert = ruleset ? characterFeatIds(character, ruleset).includes("alert") : false;
  return base + (alert ? proficiencyBonus(totalLevel(character)) : 0);
}

// Attack ability for a weapon: finesse weapons use whichever of Str/Dex is higher.
export function weaponAbilityModifier(character, weapon) {
  const strMod = effectiveAbilityModifier(character, 'str');
  const dexMod = effectiveAbilityModifier(character, 'dex');
  if (weapon.ability === "finesse") return Math.max(strMod, dexMod);
  if (weapon.ability === "dex") return dexMod;
  return strMod;
}

const hasFeat = (character, id) => (character.feats || []).some(f => f.featId === id);
const hasProp = (weapon, re) => (weapon.properties || []).some(p => re.test(p));

export function weaponAttackBonus(character, weapon, item) {
  // Monster/NPC actions carry their printed attack bonus directly, since it
  // doesn't cleanly decompose into ability mod + proficiency the way a PC's does.
  if (weapon.flatAttackBonus != null) return weapon.flatAttackBonus;
  const abilMod = weaponAbilityModifier(character, weapon);
  const proficient = (item?.weaponData?.proficient ?? item?.proficient) !== false; // assume proficient unless flagged otherwise
  const pb = proficient ? proficiencyBonus(totalLevel(character)) : 0;
  const magicBonus = (item?.attackBonus || 0) + (item?.weaponData?.attackBonus || 0);
  const archery = weapon.ranged && hasFeat(character, "archery") ? 2 : 0; // Fighting Style: Archery
  return abilMod + pb + magicBonus + archery;
}

export function weaponDamageBonus(character, weapon, item) {
  if (weapon.flatDamageBonus != null) return weapon.flatDamageBonus;
  let bonus = weaponAbilityModifier(character, weapon) + (item?.damageBonus || 0) + (item?.weaponData?.damageBonus || 0);
  // Fighting Styles: Dueling (one-handed melee), Thrown Weapon Fighting
  if (!weapon.ranged && !hasProp(weapon, /^Two-Handed/) && hasFeat(character, "dueling")) bonus += 2;
  if (hasProp(weapon, /^Thrown/) && hasFeat(character, "thrown-weapon-fighting")) bonus += 2;
  return bonus;
}

// Cryptographically-sourced random float in [0, 1) — used so dice results
// can't be predicted or replayed by inspecting Math.random's PRNG state.
export function secureRandom() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 4294967296;
}

// Seeded PRNG (mulberry32) so every connected client can render the same
// physical tumble animation for a shared roll without shipping physics state.
export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Multiclassing
// ---------------------------------------------------------------------------
// character.classes: [{ classId, level, subclassId }]. Falls back to the
// legacy single classId/level fields for characters created before multiclass support.
export function getClassEntries(character) {
  if (character.classes?.length) return character.classes;
  return character.classId ? [{ classId: character.classId, level: character.level || 1, subclassId: character.subclassId || null }] : [];
}
export function totalLevel(character) {
  const entries = getClassEntries(character);
  return entries.reduce((sum, e) => sum + (e.level || 0), 0) || character.level || 1;
}
export function primaryClassEntry(character) {
  return getClassEntries(character)[0] || null;
}

// ---------------------------------------------------------------------------
// Unarmed strike (PHB 2024: 1 + Str modifier Bludgeoning; Monk uses Martial Arts die)
// ---------------------------------------------------------------------------
export function unarmedStrikeWeapon(character, classesList) {
  const cls = classesList?.find(c => c.id === primaryClassEntry(character)?.classId);
  const level = totalLevel(character);
  let dice = "1d1"; // flat 1 + mod by default (2024 PHB unarmed strike)
  if (cls?.id === "monk") {
    dice = level >= 17 ? "1d12" : level >= 11 ? "1d10" : level >= 5 ? "1d8" : "1d6";
  }
  return {
    id: "unarmed-strike", name: "Unarmed Strike", ability: cls?.id === "monk" ? "finesse" : "str",
    damageDice: dice, damageType: "bludgeoning", ranged: false, ammoType: null,
    range: "5 ft.", properties: ["Melee"]
  };
}

// ---------------------------------------------------------------------------
// Weapon range (for display next to Attack)
// ---------------------------------------------------------------------------
export function weaponRangeLabel(weapon) {
  if (!weapon) return "\u2014";
  const thrown = (weapon.properties || []).find(p => /^Thrown/i.test(p));
  const ammo = (weapon.properties || []).find(p => /^Ammunition/i.test(p));
  const reach = (weapon.properties || []).some(p => /^Reach/i.test(p));
  if (weapon.range) return weapon.range;
  if (ammo) return ammo.match(/\(([^)]+)\)/)?.[1] + " ft." || "Ranged";
  if (thrown) return thrown.match(/\(([^)]+)\)/)?.[1] + " ft. (thrown)" || "Thrown";
  return reach ? "10 ft. (reach)" : "5 ft.";
}

// ---------------------------------------------------------------------------
// Spell save DC and attack bonus
// ---------------------------------------------------------------------------
export function spellSaveDc(character, spellcastingAbility) {
  return 8 + proficiencyBonus(totalLevel(character)) + effectiveAbilityModifier(character, spellcastingAbility);
}
export function spellAttackBonus(character, spellcastingAbility) {
  return proficiencyBonus(totalLevel(character)) + effectiveAbilityModifier(character, spellcastingAbility);
}

// ---------------------------------------------------------------------------
// Spell slots by caster level (PHB 2024, unchanged from 2014 tables).
// full = Bard/Cleric/Druid/Sorcerer/Wizard, half = Paladin/Ranger (round up from level/2),
// warlock = Pact Magic (few slots, always highest level, recharges on short rest).
// ---------------------------------------------------------------------------
const FULL_CASTER_SLOTS = {
  1: [2], 2: [3], 3: [4, 2], 4: [4, 3], 5: [4, 3, 2], 6: [4, 3, 3], 7: [4, 3, 3, 1],
  8: [4, 3, 3, 2], 9: [4, 3, 3, 3, 1], 10: [4, 3, 3, 3, 2], 11: [4, 3, 3, 3, 2, 1],
  12: [4, 3, 3, 3, 2, 1], 13: [4, 3, 3, 3, 2, 1, 1], 14: [4, 3, 3, 3, 2, 1, 1],
  15: [4, 3, 3, 3, 2, 1, 1, 1], 16: [4, 3, 3, 3, 2, 1, 1, 1], 17: [4, 3, 3, 3, 2, 1, 1, 1, 1],
  18: [4, 3, 3, 3, 3, 1, 1, 1, 1], 19: [4, 3, 3, 3, 3, 2, 1, 1, 1], 20: [4, 3, 3, 3, 3, 2, 2, 1, 1]
};
const WARLOCK_SLOTS = {
  1: { count: 1, level: 1 }, 2: { count: 2, level: 1 }, 3: { count: 2, level: 2 }, 4: { count: 2, level: 2 },
  5: { count: 2, level: 3 }, 6: { count: 2, level: 3 }, 7: { count: 2, level: 4 }, 8: { count: 2, level: 4 },
  9: { count: 2, level: 5 }, 10: { count: 2, level: 5 }, 11: { count: 3, level: 5 }, 12: { count: 3, level: 5 },
  13: { count: 3, level: 5 }, 14: { count: 3, level: 5 }, 15: { count: 3, level: 5 }, 16: { count: 3, level: 5 },
  17: { count: 4, level: 5 }, 18: { count: 4, level: 5 }, 19: { count: 4, level: 5 }, 20: { count: 4, level: 5 }
};
const HALF_CASTER_CLASSES = new Set(["paladin", "ranger"]);
const NON_CASTER_CLASSES = new Set(["barbarian", "fighter", "monk", "rogue"]);
const THIRD_CASTER_SUBCLASSES = new Set(["eldritch-knight", "arcane-trickster"]);

// Caster level per PHB 2024 multiclassing: full levels + half (rounded up) for
// Paladin/Ranger + a third (rounded down) for Eldritch Knight/Arcane Trickster.
// A single-class caster simply uses its own column (a level 1 Paladin has 2 slots).
export function casterLevel(character) {
  const entries = getClassEntries(character).filter(e => e.classId !== "warlock");
  const contributions = entries.map(e => {
    const lvl = e.level || 0;
    if (HALF_CASTER_CLASSES.has(e.classId)) return { half: true, value: lvl / 2 };
    if (NON_CASTER_CLASSES.has(e.classId)) return { third: true, value: THIRD_CASTER_SUBCLASSES.has(subclassSlug(e.subclassId)) && lvl >= 3 ? lvl / 3 : 0 };
    return { value: lvl };
  }).filter(c => c.value > 0);
  if (contributions.length === 1) {
    const c = contributions[0];
    return c.half ? Math.ceil(c.value) : c.third ? Math.floor(c.value) : c.value;
  }
  return contributions.reduce((sum, c) => sum + (c.half ? Math.ceil(c.value) : Math.floor(c.value)), 0);
}

export function subclassSlug(subclassId) {
  return subclassId ? String(subclassId).toLowerCase().replace(/'/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : null;
}

export function spellSlotTable(character) {
  const entries = getClassEntries(character);
  const warlockEntry = entries.find(e => e.classId === "warlock");
  const cl = casterLevel(character);
  const slots = FULL_CASTER_SLOTS[Math.max(0, Math.min(20, cl))] || [];
  const pact = warlockEntry ? WARLOCK_SLOTS[Math.max(1, Math.min(20, warlockEntry.level || 1))] : null;
  return { slots, pact }; // slots[0] = level-1 slots, slots[1] = level-2, etc. pact = { count, level }
}

// The spellcasting block that applies to a class entry: the class's own, or the
// subclass's (Eldritch Knight / Arcane Trickster) once that subclass is chosen.
export function entrySpellcasting(entry, classes) {
  const cls = classes.find(c => c.id === entry.classId);
  if (!cls) return null;
  if (cls.spellcasting) return cls.spellcasting;
  const sub = (cls.subclasses || []).find(s => (s.id || subclassSlug(s.name || s)) === subclassSlug(entry.subclassId));
  return sub?.spellcasting || null;
}

// How many cantrips / prepared spells a class entry allows at its level (0 when none).
export function spellLimits(entry, classes) {
  const sc = entrySpellcasting(entry, classes);
  const idx = Math.max(0, Math.min(19, (entry.level || 1) - 1));
  return { cantrips: sc?.cantrips?.[idx] || 0, prepared: sc?.prepared?.[idx] || 0, spellcasting: sc };
}

// Highest spell level a class entry can prepare at its level.
export function maxSpellLevelFor(entry, classes) {
  const sc = entrySpellcasting(entry, classes);
  if (!sc) return 0;
  const lvl = entry.level || 1;
  if (sc.type === "pact") return WARLOCK_SLOTS[Math.min(20, lvl)].level;
  const effective = sc.type === "half" ? Math.ceil(lvl / 2) : sc.type === "third" ? Math.floor(lvl / 3) : lvl;
  const slots = FULL_CASTER_SLOTS[Math.max(0, Math.min(20, effective))] || [];
  return slots.length;
}

// ---------------------------------------------------------------------------
// Currency (5-coin system: cp, sp, ep, gp, pp) — all convert to GP for totals.
// ---------------------------------------------------------------------------
export const COIN_TO_GP = { cp: 0.01, sp: 0.1, ep: 0.5, gp: 1, pp: 10 };
export function currencyTotalGp(currency) {
  return Object.entries(COIN_TO_GP).reduce((sum, [coin, rate]) => sum + (currency?.[coin] || 0) * rate, 0);
}

// Pays `costGp` from a purse, smallest coins first, breaking larger coins and
// returning change in gp/sp/cp. Returns the new purse, or null if it can't afford it.
const COIN_CP = { cp: 1, sp: 10, ep: 50, gp: 100, pp: 1000 };
export function spendCoins(currency, costGp) {
  let due = Math.round(costGp * 100);
  const purse = { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0, ...(currency || {}) };
  const total = Object.entries(COIN_CP).reduce((s, [c, v]) => s + (purse[c] || 0) * v, 0);
  if (total < due) return null;
  for (const coin of ["cp", "sp", "ep", "gp", "pp"]) {
    if (due <= 0) break;
    const v = COIN_CP[coin];
    const use = Math.min(purse[coin], Math.ceil(due / v));
    purse[coin] -= use;
    due -= use * v;
  }
  let change = -due; // overpaid with a larger coin
  for (const coin of ["gp", "sp", "cp"]) {
    const n = Math.floor(change / COIN_CP[coin]);
    purse[coin] += n; change -= n * COIN_CP[coin];
  }
  return purse;
}

// ---------------------------------------------------------------------------
// Item weight/value parsing (equipment.json stores human strings like "3 lb." / "15 GP")
// ---------------------------------------------------------------------------
export function parseWeightLb(weightStr) {
  if (!weightStr) return 0;
  const m = String(weightStr).match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}
export function parseCostToGp(costStr) {
  if (!costStr) return 0;
  const m = String(costStr).match(/([\d.]+)\s*(CP|SP|EP|GP|PP)/i);
  if (!m) return 0;
  return parseFloat(m[1]) * COIN_TO_GP[m[2].toLowerCase()];
}

// ---------------------------------------------------------------------------
// Rest resolution
// ---------------------------------------------------------------------------
export function maxResourceUses(resource, character, classLevel) {
  if (!resource) return 0;
  const lvl = Math.max(1, Math.min(20, classLevel || 1));
  switch (resource.kind) {
    case "table": return resource.table?.[lvl - 1] || 0;
    case "fixed": return resource.value || 1;
    case "level": return lvl * (resource.mult || 1) + (resource.add || 0);
    case "pb": return proficiencyBonus(totalLevel(character));
    case "ability": return Math.max(resource.min ?? 1, effectiveAbilityModifier(character, resource.ability));
    // legacy kinds (pre-2024-data characters / custom Firestore data)
    case "fixed-1": return 1;
    case "fixed-2": return 2;
    case "monk-level":
    case "sorcerer-level": return lvl;
    case "ability-mod-cha": return Math.max(1, effectiveAbilityModifier(character, 'cha'));
    case "channel-divinity": return lvl >= 18 ? 4 : lvl >= 6 ? 3 : 2;
    case "rage-uses": return lvl >= 17 ? 6 : lvl >= 12 ? 5 : lvl >= 6 ? 4 : lvl >= 3 ? 3 : 2;
    case "paladin-lay-on-hands-pool": return lvl * 5;
    default: return 1;
  }
}

// Does a resource recharge fully on a Short Rest (or partially, per shortRestRegain)?
export function shortRestRecovery(resource, classLevel) {
  if (!resource) return 0;
  if (resource.recharge === "shortRest") return Infinity;
  if (resource.shortRestFromLevel && classLevel >= resource.shortRestFromLevel) return Infinity;
  return resource.shortRestRegain || 0;
}

// Multiclass prerequisites: the class's `multiclassPrereq` abilities at 13+, all of
// them or any one of them per `multiclassPrereqMode` (Fighter is Str OR Dex).
export function meetsMulticlassPrereq(character, cls) {
  if (!cls?.multiclassPrereq?.length) return true;
  const test = a => effectiveAbilityScore(character, a) >= 13;
  return cls.multiclassPrereqMode === "any" ? cls.multiclassPrereq.some(test) : cls.multiclassPrereq.every(test);
}

// ---------------------------------------------------------------------------
// Cover (PHB 2024 p.19606): applied as an AC adjustment when a token overlaps
// a cover-flagged map component. Total Cover blocks targeting entirely rather
// than granting a bonus, so it isn't modeled as an AC number.
// ---------------------------------------------------------------------------
export const COVER_AC_BONUS = { half: 2, threeQuarters: 5, total: null };
export const COVER_LABELS = { half: "Half Cover", threeQuarters: "Three-Quarters Cover", total: "Total Cover" };

export const ACTION_ECONOMY_TYPES = ["action", "bonusAction", "reaction", "movement"];

// One grid square = 5 ft (PHB 2024 standard).
export const FEET_PER_GRID = 5;
