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
  const abilityKey = def ? def.ability : skill.ability;
  const base = abilityModifier(character.abilityScores[abilityKey]);
  const isProficient = character.skillProficiencies?.includes(def ? def.id : skill.id);
  const isExpert = character.skillExpertise?.includes(def ? def.id : skill.id);
  const pb = proficiencyBonus(character.level || 1);
  let bonus = 0;
  if (isExpert) bonus = pb * 2;
  else if (isProficient) bonus = pb;
  return base + bonus;
}

export function savingThrowModifier(character, ability) {
  const base = abilityModifier(character.abilityScores[ability]);
  const pb = proficiencyBonus(character.level || 1);
  const proficient = character.savingThrowProficiencies?.includes(ability);
  return base + (proficient ? pb : 0);
}

export function passivePerception(character, allSkills) {
  return 10 + skillModifier(character, { id: "perception" }, allSkills);
}

// Rough AC estimate: unarmored (10 + Dex) unless the character records armor explicitly.
export function estimateArmorClass(character) {
  if (character.armorClassOverride) return character.armorClassOverride;
  const dexMod = abilityModifier(character.abilityScores.dex);
  const conMod = abilityModifier(character.abilityScores.con);
  if (character.classId === "barbarian" && !character.equippedArmor) {
    return 10 + dexMod + conMod;
  }
  if (character.classId === "monk" && !character.equippedArmor) {
    const wisMod = abilityModifier(character.abilityScores.wis);
    return 10 + dexMod + wisMod;
  }
  return 10 + dexMod;
}

export function maxHitPoints(character, classDef) {
  if (!classDef) return character.hp?.max || 0;
  const conMod = abilityModifier(character.abilityScores.con);
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
