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
// falling back to unarmored formulas for Barbarian/Monk, then plain 10+Dex.
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

  const conMod = effectiveAbilityModifier(character, 'con');
  if (character.classId === "barbarian") return 10 + dexMod + conMod + shieldBonus;
  if (character.classId === "monk") {
    const wisMod = effectiveAbilityModifier(character, 'wis');
    return 10 + dexMod + wisMod + shieldBonus;
  }
  return 10 + dexMod + shieldBonus;
}

export function maxHitPoints(character, classDef) {
  if (!classDef) return character.hp?.max || 0;
  const conMod = effectiveAbilityModifier(character, 'con');
  const level = character.level || 1;
  // Level 1: max die + Con mod. Each level after: average roll (die/2 + 1) + Con mod.
  const avgPerLevel = Math.floor(classDef.hitDie / 2) + 1;
  return classDef.hitDie + conMod + (level - 1) * (avgPerLevel + conMod);
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

export function initiativeModifier(character) {
  return effectiveAbilityModifier(character, 'dex');
}

// Attack ability for a weapon: finesse weapons use whichever of Str/Dex is higher.
export function weaponAbilityModifier(character, weapon) {
  const strMod = effectiveAbilityModifier(character, 'str');
  const dexMod = effectiveAbilityModifier(character, 'dex');
  if (weapon.ability === "finesse") return Math.max(strMod, dexMod);
  if (weapon.ability === "dex") return dexMod;
  return strMod;
}

export function weaponAttackBonus(character, weapon, item) {
  // Monster/NPC actions carry their printed attack bonus directly, since it
  // doesn't cleanly decompose into ability mod + proficiency the way a PC's does.
  if (weapon.flatAttackBonus != null) return weapon.flatAttackBonus;
  const abilMod = weaponAbilityModifier(character, weapon);
  const proficient = item?.proficient !== false; // assume proficient unless flagged otherwise
  const pb = proficient ? proficiencyBonus(totalLevel(character)) : 0;
  const magicBonus = item?.attackBonus || 0;
  return abilMod + pb + magicBonus;
}

export function weaponDamageBonus(character, weapon, item) {
  if (weapon.flatDamageBonus != null) return weapon.flatDamageBonus;
  return weaponAbilityModifier(character, weapon) + (item?.damageBonus || 0);
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
const NON_CASTER_CLASSES = new Set(["barbarian", "fighter", "monk", "rogue"]); // fighter/rogue get subclass casting later — out of scope for the starter table

export function spellSlotTable(character) {
  const entries = getClassEntries(character);
  const warlockEntry = entries.find(e => e.classId === "warlock");
  const casterLevel = entries.reduce((sum, e) => {
    if (e.classId === "warlock") return sum;
    if (HALF_CASTER_CLASSES.has(e.classId)) return sum + Math.floor((e.level || 0) / 2);
    if (!NON_CASTER_CLASSES.has(e.classId)) return sum + (e.level || 0);
    return sum;
  }, 0);
  const slots = FULL_CASTER_SLOTS[Math.max(0, Math.min(20, casterLevel))] || [];
  const pact = warlockEntry ? WARLOCK_SLOTS[Math.max(1, Math.min(20, warlockEntry.level || 1))] : null;
  return { slots, pact }; // slots[0] = level-1 slots, slots[1] = level-2, etc. pact = { count, level }
}

// ---------------------------------------------------------------------------
// Currency (5-coin system: cp, sp, ep, gp, pp) — all convert to GP for totals.
// ---------------------------------------------------------------------------
export const COIN_TO_GP = { cp: 0.01, sp: 0.1, ep: 0.5, gp: 1, pp: 10 };
export function currencyTotalGp(currency) {
  return Object.entries(COIN_TO_GP).reduce((sum, [coin, rate]) => sum + (currency?.[coin] || 0) * rate, 0);
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
  switch (resource.kind) {
    case "fixed-1": return 1;
    case "fixed-2": return 2;
    case "monk-level":
    case "sorcerer-level": return classLevel;
    case "ability-mod-cha": return Math.max(1, effectiveAbilityModifier(character, 'cha'));
    case "channel-divinity": return classLevel >= 18 ? 3 : classLevel >= 6 ? 2 : 1;
    case "rage-uses": return classLevel >= 20 ? 99 : classLevel >= 17 ? 6 : classLevel >= 12 ? 5 : classLevel >= 6 ? 4 : classLevel >= 3 ? 3 : 2;
    case "paladin-lay-on-hands-pool": return classLevel * 5;
    default: return 1;
  }
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
