// Pure character-building logic shared by the creator wizard and the level-up flow:
// what a class/background/species/feat combination grants, which choices are still
// open, and turning a finished wizard state into a character document + inventory.
import { findById } from "./data-loader.js";
import {
  ABILITIES, applyBackgroundAsi, computeMaxHp, parseWeightLb, parseCostToGp,
  entrySpellcasting, maxSpellLevelFor, XP_THRESHOLDS, effectiveAbilityScore
} from "./rules-engine.js";

export const STANDARD_LANGUAGES_FALLBACK = ["Common", "Common Sign Language", "Draconic", "Dwarvish", "Elvish", "Giant", "Gnomish", "Goblin", "Halfling", "Orc"];

export function newBuildState(ruleset) {
  return {
    step: 0,
    classId: null, backgroundId: null, speciesId: null,
    startLevel: 1, hpMethod: "fixed", hpRolls: {}, subclassId: null,
    levelChoices: {}, // class level → { mode: "asi"|"feat", split: "two"|"oneone", a, b, featId, featAbility }
    speciesChoices: {}, size: null,
    abilityMethod: "standard",
    baseScores: { str: null, dex: null, con: null, int: null, wis: null, cha: null },
    rolledPool: null,
    asiChoice: { mode: "twoOne", plusTwo: null, plusOne: null },
    skillChoices: [], expertise: [], classTools: [], backgroundTool: null, languages: [],
    classChoices: { fightingStyle: null, divineOrder: null, primalOrder: null, invocations: [] },
    weaponMasteries: [],
    featChoices: {}, // keyed by source: "background" | "versatile" → { skills, tools, list, ability, cantrips, spell }
    cantrips: [], preparedSpells: [], spellbook: [],
    classEquip: "A", bgEquip: "A",
    name: "", portraitBase64: null, alignment: ruleset.alignments?.[4] || "True Neutral", backstory: "",
    appearance: { height: "", weight: "", eyes: "", hair: "", skin: "", age: "", gender: "", faith: "", faction: "" },
    personalityTraits: "", ideals: "", bonds: "", flaws: "", lifestyle: ""
  };
}

export const toolCatalog = (ruleset) => ruleset.equipment.tools || ruleset.equipment.gear.filter(g => g.kind === "tool" && !g.alias);
export const toolsByCategory = (ruleset, cat) => toolCatalog(ruleset).filter(t => t.toolCategory === cat);

export function selectedDefs(state, ruleset) {
  return {
    cls: findById(ruleset.classes, state.classId),
    bg: findById(ruleset.backgrounds, state.backgroundId),
    sp: findById(ruleset.species, state.speciesId)
  };
}

export function speciesOption(sp, choices, choiceId) {
  const ch = sp?.choices?.find(c => c.id === choiceId);
  return ch?.options?.find?.(o => o.id === choices?.[choiceId]) || null;
}

// Origin feats this build gets, each with a stable source key for its sub-choices.
export function originFeats(state, ruleset) {
  const { bg } = selectedDefs(state, ruleset);
  const out = [];
  if (bg?.featId) out.push({ source: "background", feat: findById(ruleset.feats, bg.featId), list: bg.featList || null });
  if (state.speciesChoices?.versatile) out.push({ source: "versatile", feat: findById(ruleset.feats, state.speciesChoices.versatile), list: null });
  return out.filter(x => x.feat);
}

// Skills granted without a class pick: background, species (Keen Senses / Skillful), Skilled feat.
export function grantedSkills(state, ruleset) {
  const { bg, sp } = selectedDefs(state, ruleset);
  const set = new Set(bg?.skills || []);
  if (sp?.id === "elf" && state.speciesChoices.keenSenses) set.add(state.speciesChoices.keenSenses);
  if (sp?.id === "human" && state.speciesChoices.skillful) set.add(state.speciesChoices.skillful);
  originFeats(state, ruleset).forEach(({ source, feat }) => {
    if (feat.id === "skilled") (state.featChoices[source]?.skills || []).forEach(s => set.add(s));
  });
  return set;
}

export function allSkillProficiencies(state, ruleset) {
  const set = grantedSkills(state, ruleset);
  state.skillChoices.forEach(s => set.add(s));
  return [...set];
}

// Choices a class needs at a given (starting) level.
export function classLevel1Needs(cls, level = 1) {
  if (!cls) return {};
  const prog = (label) => cls.progression?.find(p => p.label === label)?.values?.[Math.max(0, Math.min(19, level - 1))];
  let expertise = 0;
  if (cls.id === "rogue") expertise = level >= 6 ? 4 : 2;
  if (cls.id === "bard") expertise = level >= 9 ? 4 : level >= 2 ? 2 : 0;
  if (cls.id === "ranger") expertise = level >= 9 ? 2 : 0;
  return {
    weaponMasteries: prog("Weapon Mastery") || cls.weaponMastery?.[level - 1] || cls.weaponMasteryCount || 0,
    fightingStyle: cls.id === "fighter" || (["paladin", "ranger"].includes(cls.id) && level >= 2),
    divineOrder: cls.id === "cleric",
    primalOrder: cls.id === "druid",
    invocations: cls.id === "warlock" ? (prog("Invocations") || 1) : 0,
    expertise,
    extraLanguage: cls.id === "rogue" ? 1 : 0,
    subclass: level >= (cls.subclassLevel || 3)
  };
}

// Class levels (≤ starting level) that grant an Ability Score Improvement / feat (19 = Epic Boon).
export function asiLevelsFor(cls, level) {
  if (!cls) return [];
  const lv = (cls.asiLevels || [4, 8, 12, 16]).filter(l => l <= level);
  if (level >= 19) lv.push(19);
  return lv;
}

// The class entry the build will have, used for spellcasting lookups.
export function buildEntry(state) {
  return { classId: state.classId, level: state.startLevel || 1, subclassId: state.subclassId || null };
}
export function buildCasting(state, ruleset) {
  return state.classId ? entrySpellcasting(buildEntry(state), ruleset.classes) : null;
}
export function buildMaxSpellLevel(state, ruleset) {
  return state.classId ? maxSpellLevelFor(buildEntry(state), ruleset.classes) : 0;
}
export function spellbookSize(state) { return 6 + 2 * ((state.startLevel || 1) - 1); }

// Feats offered at ASI levels in the builder. Origin feats whose own sub-choices the
// builder doesn't collect here are left for the sheet's manual "Add a feat".
const BUILDER_EXCLUDED_FEATS = new Set(["magic-initiate", "skilled", "musician", "crafter", "ability-score-improvement"]);
export function levelFeatOptions(state, ruleset, classLevel) {
  const taken = new Set([...originFeats(state, ruleset).map(f => f.feat.id), state.classChoices.fightingStyle,
    ...Object.entries(state.levelChoices).filter(([l, c]) => parseInt(l, 10) !== classLevel && c.mode === "feat").map(([, c]) => c.featId)]);
  const scores = scoresBeforeLevel(state, ruleset, classLevel);
  const pseudo = { abilityScores: scores, abilityOverrides: {} };
  const cats = classLevel >= 19 ? ["epic-boon", "general", "origin"] : ["general", "origin"];
  const casting = buildCasting(state, ruleset);
  const training = trainingFor(state, ruleset);
  return ruleset.feats.filter(f => cats.includes(f.category) && !BUILDER_EXCLUDED_FEATS.has(f.id) && (f.repeatable || !taken.has(f.id)) && (() => {
    const p = f.prerequisite;
    if (!p) return true;
    if (p.level && classLevel < p.level) return false;
    if (p.abilitiesAny && !p.abilitiesAny.some(a => effectiveAbilityScore(pseudo, a) >= (p.abilityMin || 13))) return false;
    if (p.spellcasting && !casting) return false;
    if (p.armor && !training.armorTraining.includes(p.armor)) return false;
    return true;
  })());
}

export function masteryWeapons(cls, ruleset) {
  const all = ruleset.equipment.weapons;
  if (!cls) return [];
  if (cls.id === "barbarian") return all.filter(w => !w.ranged);
  if (cls.id === "rogue") return all.filter(w => w.category === "simple" || w.properties.some(p => /^(Finesse|Light)/.test(p)));
  return all;
}

export function cantripCount(state, ruleset) {
  const { cls } = selectedDefs(state, ruleset);
  const sc = buildCasting(state, ruleset);
  let n = sc?.cantrips?.[(state.startLevel || 1) - 1] || 0;
  if (cls?.id === "cleric" && state.classChoices.divineOrder === "thaumaturge") n += 1;
  if (cls?.id === "druid" && state.classChoices.primalOrder === "magician") n += 1;
  return n;
}
export function preparedCount(state, ruleset) {
  return buildCasting(state, ruleset)?.prepared?.[(state.startLevel || 1) - 1] || 0;
}
// level: exact spell level, or { max } for every leveled spell up to max.
export function classSpellList(ruleset, listId, level) {
  return ruleset.spells.filter(s => s.classes.includes(listId) && (level == null || (typeof level === "object" ? s.level >= 1 && s.level <= level.max : s.level === level)));
}
export function hasSpellStep(state, ruleset) {
  return !!buildCasting(state, ruleset) || originFeats(state, ruleset).some(f => f.feat.id === "magic-initiate");
}

// Removes choices made invalid by an upstream change (e.g. switching class drops
// its skill picks; switching background drops picks it now grants for free).
export function sanitize(state, ruleset) {
  const { cls, bg, sp } = selectedDefs(state, ruleset);
  const granted = grantedSkills(state, ruleset);
  if (cls) {
    const opts = cls.skillChoices.options === "any" ? null : new Set(cls.skillChoices.options);
    state.skillChoices = state.skillChoices.filter(s => (!opts || opts.has(s)) && !granted.has(s)).slice(0, cls.skillChoices.count);
    const needs = classLevel1Needs(cls, state.startLevel || 1);
    const allowed = new Set(masteryWeapons(cls, ruleset).map(w => w.id));
    state.weaponMasteries = state.weaponMasteries.filter(id => allowed.has(id)).slice(0, needs.weaponMasteries);
    if (!needs.fightingStyle) state.classChoices.fightingStyle = null;
    if (!needs.divineOrder) state.classChoices.divineOrder = null;
    if (!needs.primalOrder) state.classChoices.primalOrder = null;
    if (!needs.invocations) state.classChoices.invocations = [];
    const profs = new Set(allSkillProficiencies(state, ruleset));
    state.expertise = state.expertise.filter(s => profs.has(s)).slice(0, needs.expertise);
    const sc = buildCasting(state, ruleset);
    if (!sc) { state.cantrips = []; state.preparedSpells = []; state.spellbook = []; }
    else {
      const list = sc.list;
      const maxLvl = buildMaxSpellLevel(state, ruleset);
      const okC = new Set(classSpellList(ruleset, list, 0).map(s => s.id));
      const okL = new Set(classSpellList(ruleset, list, { max: maxLvl }).map(s => s.id));
      state.cantrips = state.cantrips.filter(id => okC.has(id)).slice(0, cantripCount(state, ruleset));
      state.spellbook = sc.spellbook ? state.spellbook.filter(id => okL.has(id)).slice(0, spellbookSize(state)) : [];
      const pool = sc.spellbook ? new Set(state.spellbook) : okL;
      state.preparedSpells = state.preparedSpells.filter(id => pool.has(id)).slice(0, preparedCount(state, ruleset));
    }
    if (!needs.subclass || !cls.subclasses.some(x => x.id === state.subclassId)) { if (!needs.subclass) state.subclassId = null; else if (state.subclassId && !cls.subclasses.some(x => x.id === state.subclassId)) state.subclassId = null; }
    const asiSet = new Set(asiLevelsFor(cls, state.startLevel || 1).map(String));
    Object.keys(state.levelChoices).forEach(l => { if (!asiSet.has(l)) delete state.levelChoices[l]; });
    Object.keys(state.hpRolls).forEach(l => { if (parseInt(l, 10) > (state.startLevel || 1)) delete state.hpRolls[l]; });
    state.classTools = state.classTools.slice(0, cls.toolChoices?.count || 0);
    if (!cls.equipmentOptions.some(o => o.id === state.classEquip)) state.classEquip = cls.equipmentOptions[0]?.id || "A";
  }
  if (bg) {
    if (!bg.abilityScores.includes(state.asiChoice.plusTwo)) state.asiChoice.plusTwo = null;
    if (!bg.abilityScores.includes(state.asiChoice.plusOne)) state.asiChoice.plusOne = null;
    if (!bg.toolChoice) state.backgroundTool = null;
  }
  if (sp) {
    if (!sp.size.includes(state.size)) state.size = sp.size.length === 1 ? sp.size[0] : null;
    const validIds = new Set((sp.choices || []).map(c => c.id));
    Object.keys(state.speciesChoices).forEach(k => { if (!validIds.has(k)) delete state.speciesChoices[k]; });
  }
  // feat sub-choices for feats no longer present
  const sources = new Set(originFeats(state, ruleset).map(f => f.source));
  Object.keys(state.featChoices).forEach(k => { if (!sources.has(k)) delete state.featChoices[k]; });
  originFeats(state, ruleset).forEach(({ source, feat, list }) => {
    const fc = state.featChoices[source] || (state.featChoices[source] = {});
    if (feat.id !== fc.featId) { Object.keys(fc).forEach(k => delete fc[k]); fc.featId = feat.id; }
    if (feat.id === "magic-initiate" && list) fc.list = list;
  });
  const maxLang = 2 + (classLevel1Needs(cls, state.startLevel || 1).extraLanguage || 0);
  state.languages = state.languages.slice(0, maxLang);
  return state;
}

// Scores after the background bonus and every level ASI/feat increase below `beforeLevel`.
export function scoresBeforeLevel(state, ruleset, beforeLevel = 99) {
  const { bg } = selectedDefs(state, ruleset);
  const scores = applyBackgroundAsi(state.baseScores, bg, state.asiChoice);
  Object.keys(state.levelChoices).map(Number).sort((a, b) => a - b).filter(l => l < beforeLevel).forEach(l => {
    const c = state.levelChoices[l];
    if (c.mode === "asi") {
      if (c.split === "oneone") { if (c.a) scores[c.a] = Math.min(20, scores[c.a] + 1); if (c.b) scores[c.b] = Math.min(20, scores[c.b] + 1); }
      else if (c.a) scores[c.a] = Math.min(20, scores[c.a] + 2);
    } else if (c.mode === "feat" && c.featAbility) {
      const feat = findById(ruleset.feats, c.featId);
      scores[c.featAbility] = Math.min(feat?.asi?.max || 20, scores[c.featAbility] + 1);
    }
  });
  return scores;
}
export function finalScores(state, ruleset) {
  return scoresBeforeLevel(state, ruleset, 99);
}

export function toolProficiencies(state, ruleset) {
  const { cls, bg } = selectedDefs(state, ruleset);
  const tools = new Set();
  (cls?.tools || []).forEach(t => tools.add(t));
  state.classTools.forEach(id => { const t = findById(toolCatalog(ruleset), id); if (t) tools.add(t.name); });
  if (bg) {
    if (bg.toolChoice) { const t = findById(toolCatalog(ruleset), state.backgroundTool); if (t) tools.add(t.name); }
    else if (bg.tool) tools.add(bg.tool);
  }
  originFeats(state, ruleset).forEach(({ source }) => {
    (state.featChoices[source]?.tools || []).forEach(id => { const t = findById(toolCatalog(ruleset), id); if (t) tools.add(t.name); });
  });
  return [...tools];
}

export function knownLanguages(state, ruleset) {
  const { cls } = selectedDefs(state, ruleset);
  const langs = ["Common", ...state.languages];
  if (cls?.id === "rogue") langs.push("Thieves' Cant");
  if (cls?.id === "druid") langs.push("Druidic");
  return [...new Set(langs)];
}

export function trainingFor(state, ruleset) {
  const { cls } = selectedDefs(state, ruleset);
  const armor = new Set(cls?.armorTraining || []);
  const weapons = new Set(cls?.weaponTraining || []);
  if (state.classChoices.divineOrder === "protector") { armor.add("heavy"); weapons.add("martial"); }
  if (state.classChoices.primalOrder === "warden") { armor.add("medium"); weapons.add("martial"); }
  return { armorTraining: [...armor], weaponTraining: [...weapons] };
}

// Species spells/cantrips that are always known (Light Bearer, Elven/Gnomish lineage, Fiendish Legacy).
export function speciesCantrips(sp, choices) {
  const out = [...(sp?.cantrips || [])];
  (sp?.choices || []).forEach(ch => {
    if (ch.type !== "option") return;
    const opt = ch.options.find(o => o.id === choices?.[ch.id]);
    (opt?.cantrips || []).forEach(c => out.push(c));
  });
  return [...new Set(out)];
}

export function featRecords(state, ruleset) {
  return originFeats(state, ruleset).map(({ source, feat }) => {
    const fc = state.featChoices[source] || {};
    const choices = {};
    if (feat.id === "skilled") { choices.skills = fc.skills || []; choices.tools = fc.tools || []; }
    if (feat.id === "magic-initiate") Object.assign(choices, { list: fc.list, ability: fc.ability, cantrips: fc.cantrips || [], spell: fc.spell || null });
    if (feat.id === "musician" || feat.id === "crafter") choices.tools = fc.tools || [];
    return { featId: feat.id, source, choices };
  });
}

export function buildCharacter(state, ruleset, user) {
  const { cls, bg, sp } = selectedDefs(state, ruleset);
  const scores = finalScores(state, ruleset);
  const training = trainingFor(state, ruleset);
  const character = {
    ownerUid: user.uid,
    ownerName: user.displayName,
    name: state.name.trim(),
    portraitBase64: state.portraitBase64 || null,
    classId: cls.id,
    classes: [{ classId: cls.id, level: state.startLevel || 1, subclassId: state.subclassId || null }],
    subclassId: state.subclassId || null,
    speciesId: sp.id,
    speciesChoices: { ...state.speciesChoices },
    size: state.size || sp.size[0],
    backgroundId: bg.id,
    alignment: state.alignment,
    backstory: state.backstory,
    appearance: { ...state.appearance },
    personalityTraits: state.personalityTraits || "", ideals: state.ideals || "", bonds: state.bonds || "", flaws: state.flaws || "",
    lifestyle: state.lifestyle || "",
    level: state.startLevel || 1,
    xp: XP_THRESHOLDS[(state.startLevel || 1) - 1] || 0,
    abilityScores: scores,
    baseAbilityScores: { ...state.baseScores },
    abilityMethod: state.abilityMethod,
    backgroundAsi: { ...state.asiChoice },
    abilityOverrides: {},
    skillOverrides: {},
    savingThrowOverrides: {},
    skillProficiencies: allSkillProficiencies(state, ruleset),
    skillExpertise: [...state.expertise],
    savingThrowProficiencies: [...new Set([...cls.savingThrows, ...Object.values(state.levelChoices).filter(c => c.mode === "feat" && c.featId === "resilient" && c.featAbility).map(c => c.featAbility)])],
    toolProficiencies: toolProficiencies(state, ruleset),
    languages: knownLanguages(state, ruleset),
    armorTraining: training.armorTraining,
    weaponTraining: training.weaponTraining,
    classChoices: {
      [cls.id]: {
        fightingStyle: state.classChoices.fightingStyle || null,
        divineOrder: state.classChoices.divineOrder || null,
        primalOrder: state.classChoices.primalOrder || null,
        invocations: [...state.classChoices.invocations],
        landTerrain: state.classChoices.landTerrain || null
      }
    },
    feats: featRecords(state, ruleset),
    // legacy shape still read by older sheet code paths
    featChoices: (() => {
      const skilled = featRecords(state, ruleset).find(f => f.featId === "skilled");
      return skilled ? { skilled: { skills: skilled.choices.skills } } : {};
    })(),
    equipmentChoice: state.classEquip,
    backgroundEquipmentChoice: state.bgEquip,
    weaponMasteries: [...state.weaponMasteries],
    spellsKnown: {
      cantrips: [...state.cantrips],
      spellbook: [...state.spellbook],
      species: speciesCantrips(sp, state.speciesChoices)
    },
    spellsPrepared: [...new Set([...state.cantrips, ...state.preparedSpells])],
    hp: { current: null, max: null, temp: 0 },
    hitDiceUsed: 0,
    acAdjustments: [],
    inspiration: sp.id === "human",
    currency: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
    resourcesUsed: {},
    spellSlotsUsed: {},
    pactSlotsUsed: 0,
    campaignId: null,
    notes: "",
    personality: "",
    createdWith: "2024-builder"
  };
  if (state.classChoices.fightingStyle) character.feats.push({ featId: state.classChoices.fightingStyle, source: `class-${cls.id}-${cls.id === "fighter" ? 1 : 2}`, choices: {} });
  Object.keys(state.levelChoices).map(Number).sort((a, b) => a - b).forEach(l => {
    const c = state.levelChoices[l];
    if (c.mode === "asi") character.feats.push({ featId: "ability-score-improvement", source: `class-${cls.id}-${l}`, choices: { increases: c.split === "oneone" ? { [c.a]: 1, [c.b]: 1 } : { [c.a]: 2 } } });
    else if (c.featId) character.feats.push({ featId: c.featId, source: `class-${cls.id}-${l}`, choices: c.featAbility ? { ability: c.featAbility } : {} });
  });
  let maxHp = computeMaxHp(character, ruleset);
  if (state.hpMethod === "roll") {
    const avg = Math.floor(cls.hitDie / 2) + 1;
    for (let l = 2; l <= (state.startLevel || 1); l++) if (state.hpRolls[l]) maxHp += state.hpRolls[l] - avg;
    maxHp = Math.max(1, maxHp);
  }
  character.hp = { current: maxHp, max: maxHp, temp: 0 };
  return character;
}

// Inventory items (in insertion order) for the chosen class + background packages.
// Packs become containers holding their contents; armor the character is trained in
// and up to two weapons start equipped.
export function startingInventory(state, ruleset) {
  const { cls, bg } = selectedDefs(state, ruleset);
  const classOpt = cls.equipmentOptions.find(o => o.id === state.classEquip) || cls.equipmentOptions[0];
  const specs = [...(classOpt?.items || [])];
  if (cls.id === "monk" && classOpt?.id === "A" && state.classTools[0]) specs.push({ category: "gear", catalogId: state.classTools[0], quantity: 1 });
  if (state.bgEquip === "A") specs.push(...(bg.equipment?.items || []));
  const gold = (classOpt?.gold || 0) + (state.bgEquip === "A" ? (bg.equipment?.gold || 0) : (bg.goldAlternative || 50));
  const training = trainingFor(state, ruleset);
  const out = [];
  let equippedWeapons = 0, equippedArmor = false, equippedShield = false;
  const resolveGearId = (id) => {
    if (id === "tool-choice") return state.backgroundTool;
    if (id === "musical-instrument") return state.classTools[0] || "lute";
    if (id === "gaming-set") return "dice-set";
    return id;
  };
  for (const spec of specs) {
    if (spec.category === "weapon") {
      const e = findById(ruleset.equipment.weapons, spec.catalogId); if (!e) continue;
      const proficient = training.weaponTraining.includes(e.category) ||
        (training.weaponTraining.includes("martial-light") && e.properties.some(p => /^Light/.test(p))) ||
        (training.weaponTraining.includes("martial-finesse-light") && e.properties.some(p => /^(Finesse|Light)/.test(p)));
      const equip = equippedWeapons < 2;
      if (equip) equippedWeapons++;
      out.push({
        type: "weapon", name: e.name, quantity: spec.quantity, equipped: equip, isCustom: false, catalogId: e.id,
        weightLb: parseWeightLb(e.weight), valueGp: parseCostToGp(e.cost),
        weaponData: { damageDice: e.damageDice, damageType: e.damageType, ability: e.ability, ranged: e.ranged, ammoType: e.ammoType, properties: e.properties, mastery: e.mastery, proficient, attackBonus: 0, damageBonus: 0 }
      });
    } else if (spec.category === "armor") {
      const e = findById(ruleset.equipment.armor, spec.catalogId); if (!e) continue;
      const trained = training.armorTraining.includes(e.armorType);
      let equip = false;
      if (trained && e.armorType === "shield" && !equippedShield) { equip = true; equippedShield = true; }
      if (trained && e.armorType !== "shield" && !equippedArmor) { equip = true; equippedArmor = true; }
      out.push({
        type: "armor", name: e.name, quantity: spec.quantity, equipped: equip, isCustom: false, catalogId: e.id,
        weightLb: parseWeightLb(e.weight), valueGp: parseCostToGp(e.cost),
        armorData: { armorType: e.armorType, baseAC: e.baseAC, dexBonus: e.dexBonus, strengthRequirement: e.strengthRequirement, stealthDisadvantage: e.stealthDisadvantage }
      });
    } else if (spec.category === "ammo") {
      const e = findById(ruleset.equipment.ammo, spec.catalogId); if (!e) continue;
      out.push({ type: "ammo", name: e.name.replace(/\s*\(\d+\)/, ""), quantity: e.quantity * spec.quantity, ammoType: e.ammoType, isCustom: false, catalogId: e.id, weightLb: parseWeightLb(e.weight) / e.quantity, valueGp: parseCostToGp(e.cost) / e.quantity });
    } else if (spec.category === "gear") {
      const id = resolveGearId(spec.catalogId);
      const e = findById(ruleset.equipment.gear, id); if (!e) continue;
      const item = { type: "gear", name: e.name, quantity: spec.quantity, isCustom: false, catalogId: e.id, isContainer: !!e.isContainer || e.kind === "pack", weightLb: e.kind === "pack" ? 0 : parseWeightLb(e.weight), valueGp: parseCostToGp(e.cost) };
      if (e.kind === "pack") {
        // The pack's own container (Backpack / Chest) becomes the parent item; the rest goes inside it.
        const contents = (e.contents || []).map(c => ({ c, ce: findById(ruleset.equipment.gear, c.catalogId) })).filter(x => x.ce);
        const holder = contents.find(x => x.ce.isContainer);
        if (holder) {
          item.name = `${holder.ce.name} (${e.name})`;
          item.catalogId = holder.ce.id;
          item.weightLb = parseWeightLb(holder.ce.weight);
        }
        item.packContents = contents.filter(x => x !== holder).map(({ c, ce }) => (
          { type: "gear", name: ce.name, quantity: c.quantity, isCustom: false, catalogId: ce.id, isContainer: !!ce.isContainer, weightLb: parseWeightLb(ce.weight), valueGp: parseCostToGp(ce.cost) }
        ));
      }
      out.push(item);
    }
  }
  return { items: out, gold };
}

export const ABILITY_KEYS = ABILITIES;
