// Creature rules for the VTT (PHB 2024 Rules Glossary / DMG 2024 treasure):
// sizes, conditions and what they do, damage defenses, grapple geometry, and
// monster loot. Pure functions; the VTT panel and creature panel do the I/O.
import { rollDie, abilityModifier } from "../rules-engine.js";

export const SIZES = [
  { id: "tiny", label: "Tiny", squares: 0.5, space: "2½ ft" },
  { id: "small", label: "Small", squares: 1, space: "5 ft" },
  { id: "medium", label: "Medium", squares: 1, space: "5 ft" },
  { id: "large", label: "Large", squares: 2, space: "10 ft" },
  { id: "huge", label: "Huge", squares: 3, space: "15 ft" },
  { id: "gargantuan", label: "Gargantuan", squares: 4, space: "20 ft" }
];

export const CONDITIONS = ["Blinded", "Charmed", "Deafened", "Frightened", "Grappled", "Incapacitated", "Invisible", "Paralyzed", "Petrified", "Poisoned", "Prone", "Restrained", "Stunned", "Unconscious"];
export const DAMAGE_TYPES = ["acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic", "piercing", "poison", "psychic", "radiant", "slashing", "thunder"];

// One-line reminders shown on the creature panel
export const CONDITION_TEXT = {
  Blinded: "Can't see; auto-fails sight checks. Attacks against it have Advantage; its attacks have Disadvantage.",
  Charmed: "Can't attack the charmer; the charmer has Advantage on social checks against it.",
  Deafened: "Can't hear; auto-fails hearing checks.",
  Frightened: "Disadvantage on checks and attacks while the source is in sight; can't move closer to it.",
  Grappled: "Speed 0. Disadvantage on attacks against anyone but the grappler. The grappler can drag it.",
  Incapacitated: "No actions, Bonus Actions or Reactions; loses Concentration; can't speak.",
  Invisible: "Advantage on Initiative and its attacks; attacks against it have Disadvantage.",
  Paralyzed: "Incapacitated, Speed 0. Fails Str/Dex saves. Attacks against it have Advantage; hits within 5 ft are Critical Hits.",
  Petrified: "Incapacitated, Speed 0. Fails Str/Dex saves; Resistance to all damage; immune to Poisoned.",
  Poisoned: "Disadvantage on attack rolls and ability checks.",
  Prone: "Can only crawl or stand up. Disadvantage on attacks. Attacks against it have Advantage within 5 ft, else Disadvantage.",
  Restrained: "Speed 0. Disadvantage on attacks and Dex saves. Attacks against it have Advantage.",
  Stunned: "Incapacitated. Fails Str/Dex saves. Attacks against it have Advantage.",
  Unconscious: "Incapacitated and Prone, Speed 0. Fails Str/Dex saves. Attacks against it have Advantage; hits within 5 ft are Critical Hits."
};

// Short labels for the badges drawn on tokens
export const CONDITION_ABBR = { Blinded: "Bl", Charmed: "Ch", Deafened: "De", Frightened: "Fr", Grappled: "Gr", Incapacitated: "In", Invisible: "Iv", Paralyzed: "Pa", Petrified: "Pe", Poisoned: "Po", Prone: "Pr", Restrained: "Re", Stunned: "St", Unconscious: "Un" };

export const SPEED_ZERO = ["Grappled", "Paralyzed", "Petrified", "Restrained", "Unconscious"];
const INCAPACITATING = ["Incapacitated", "Paralyzed", "Petrified", "Stunned", "Unconscious"];
const FAILS_STR_DEX = ["Paralyzed", "Petrified", "Stunned", "Unconscious"];

export function sizeSquares(size) {
  const first = String(size || "").trim().split(/\s+/)[0]?.toLowerCase();
  return SIZES.find(s => s.id === first)?.squares || 1;
}
export function sizeIdForSquares(w) {
  return SIZES.find(s => s.squares === w && s.id !== "small")?.id || null;
}

export function isIncapacitated(conditions = []) {
  return conditions.some(c => INCAPACITATING.includes(c));
}
export function hasSpeedZero(conditions = []) {
  return conditions.some(c => SPEED_ZERO.includes(c));
}

// Conditions that come along with another one (shown greyed, not stored)
export function impliedConditions(conditions = []) {
  const out = new Set();
  if (conditions.some(c => ["Paralyzed", "Petrified", "Stunned", "Unconscious"].includes(c))) out.add("Incapacitated");
  if (conditions.includes("Unconscious")) out.add("Prone");
  conditions.forEach(c => out.delete(c));
  return [...out];
}

// Toggling a condition on keeps related ones in step (Unconscious knocks you Prone;
// you stay Prone when it ends, per the rules).
export function withCondition(conditions = [], name, on) {
  const set = new Set(conditions);
  if (on) {
    set.add(name);
    if (name === "Unconscious") set.add("Prone");
  } else set.delete(name);
  return [...set];
}

// d20 mode for this creature's own attack rolls, with the reasons.
// `vsGrappler` is true when the target is the creature grappling it.
export function attackMode(conditions = [], exhaustion = 0, { vsGrappler = false } = {}) {
  const dis = [], adv = [];
  ["Blinded", "Frightened", "Poisoned", "Prone", "Restrained"].forEach(c => { if (conditions.includes(c)) dis.push(c); });
  if (conditions.includes("Grappled") && !vsGrappler) dis.push("Grappled");
  if (conditions.includes("Invisible")) adv.push("Invisible");
  const mode = adv.length && !dis.length ? "advantage" : dis.length && !adv.length ? "disadvantage" : "normal";
  return { mode, reasons: [...adv.map(r => `+${r}`), ...dis.map(r => `−${r}`)], penalty: -2 * (exhaustion || 0) };
}

// Saving throw adjustments: auto-fail Str/Dex when paralyzed etc., Disadvantage on Dex when Restrained.
export function saveRule(ability, conditions = [], exhaustion = 0) {
  if ((ability === "str" || ability === "dex") && conditions.some(c => FAILS_STR_DEX.includes(c))) {
    return { autoFail: true, reason: conditions.find(c => FAILS_STR_DEX.includes(c)), mode: "normal", penalty: 0 };
  }
  const mode = ability === "dex" && conditions.includes("Restrained") ? "disadvantage" : "normal";
  return { autoFail: false, mode, reason: mode === "disadvantage" ? "Restrained" : null, penalty: -2 * (exhaustion || 0) };
}

// What attackers get against this creature
export function defenseNotes(conditions = []) {
  const notes = [];
  if (conditions.some(c => ["Blinded", "Paralyzed", "Petrified", "Restrained", "Stunned", "Unconscious"].includes(c))) notes.push("Attacks against it have Advantage");
  if (conditions.includes("Prone")) notes.push("Prone: Advantage within 5 ft, Disadvantage from farther");
  if (conditions.includes("Invisible")) notes.push("Attacks against it have Disadvantage");
  if (conditions.some(c => c === "Paralyzed" || c === "Unconscious")) notes.push("Hits from within 5 ft are Critical Hits");
  return notes;
}

// "Poison, Thunder; Exhaustion, Grappled" -> damage types + condition names
export function parseDefenses(m = {}) {
  const dmg = (s) => DAMAGE_TYPES.filter(t => new RegExp(`\\b${t}\\b`, "i").test(s || ""));
  const conds = (s) => [...CONDITIONS, "Exhaustion"].filter(c => new RegExp(`\\b${c}\\b`, "i").test(s || ""));
  return {
    resist: dmg(m.resistances),
    vulnerable: dmg(m.vulnerabilities),
    immune: dmg(m.immunities),
    condImmune: conds(m.immunities)
  };
}

// Resistances a character gets from its species / lineage / draconic ancestry
export function innateResistances(character, ruleset) {
  const sp = (ruleset?.species || []).find(s => s.id === character?.speciesId);
  if (!sp) return [];
  const opts = (sp.choices || []).filter(c => c.type === "option").map(c => c.options.find(o => o.id === character.speciesChoices?.[c.id])).filter(Boolean);
  const out = [...(sp.resistances || []), ...opts.flatMap(o => o.resistances || [])];
  const ancestry = opts.find(o => o.damageType);
  if (ancestry) out.push(ancestry.damageType);
  return [...new Set(out.map(x => String(x).toLowerCase()))].filter(x => DAMAGE_TYPES.includes(x));
}

// Damage after Immunity / Resistance / Vulnerability (PHB 2024: resistance, then vulnerability).
export function adjustDamage(amount, type, def = {}, conditions = []) {
  amount = Math.max(0, Math.floor(amount || 0));
  if (!type) return { amount, note: "" };
  if ((def.immune || []).includes(type)) return { amount: 0, note: `immune to ${type}` };
  const resists = (def.resist || []).includes(type) || conditions.includes("Petrified");
  let out = amount, notes = [];
  if (resists) { out = Math.floor(out / 2); notes.push(`resists ${type}`); }
  if ((def.vulnerable || []).includes(type)) { out *= 2; notes.push(`vulnerable to ${type}`); }
  return { amount: out, note: notes.join(", ") };
}

// HP after taking `amount` (temp HP soaks first). Returns { hp, dropped, massive }.
export function takeDamage(hp, amount) {
  const cur = { current: hp?.current ?? 0, max: hp?.max ?? 0, temp: hp?.temp ?? 0 };
  const fromTemp = Math.min(cur.temp, amount);
  const rest = amount - fromTemp;
  const next = { ...cur, temp: cur.temp - fromTemp, current: Math.max(0, cur.current - rest) };
  return { hp: next, rest, dropped: cur.current > 0 && next.current === 0, massive: cur.current > 0 && rest - cur.current >= cur.max };
}

export function concentrationDc(damage) {
  return Math.min(30, Math.max(10, Math.floor(damage / 2)));
}

// ---------------- Geometry (grid squares) ----------------
// Empty squares between two footprints; 0 means touching (i.e. within 5 ft).
export function footprintGap(a, b) {
  const aw = a.w || 1, ah = a.h || 1, bw = b.w || 1, bh = b.h || 1;
  const dx = Math.max(0, b.x - (a.x + aw), a.x - (b.x + bw));
  const dy = Math.max(0, b.y - (a.y + ah), a.y - (b.y + bh));
  return Math.max(dx, dy);
}
export function distanceFt(a, b) {
  return Math.round((footprintGap(a, b) + 1) * 5);
}
// Nearest spot for `t` that is within 5 ft of `g` (touching its footprint)
export function snapAdjacent(t, g) {
  const tw = t.w || 1, th = t.h || 1, gw = g.w || 1, gh = g.h || 1;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  return { x: Math.round(clamp(t.x, g.x - tw, g.x + gw) * 4) / 4, y: Math.round(clamp(t.y, g.y - th, g.y + gh) * 4) / 4 };
}

// ---------------- Monsters ----------------
export function crValue(cr) {
  const s = String(cr ?? "0").trim();
  if (s.includes("/")) { const [a, b] = s.split("/").map(Number); return b ? a / b : 0; }
  return parseFloat(s) || 0;
}

export function rollFormula(formula) {
  const m = String(formula || "").replace(/\s+/g, "").match(/^(\d*)d(\d+)([+-]\d+)?$/i);
  if (!m) return parseInt(formula, 10) || 0;
  let total = parseInt(m[3] || "0", 10);
  for (let i = 0; i < (parseInt(m[1], 10) || 1); i++) total += rollDie(parseInt(m[2], 10));
  return total;
}

// "Dex +5, Wis +5" -> { dex: 5, wis: 5 }
export function parseSaves(s) {
  const out = {};
  String(s || "").split(",").forEach(part => {
    const m = part.trim().match(/^(Str|Dex|Con|Int|Wis|Cha)\w*\s*([+-]\s*\d+)/i);
    if (m) out[m[1].toLowerCase()] = parseInt(m[2].replace(/\s/g, ""), 10);
  });
  return out;
}
export function monsterSaveBonus(monster, ability) {
  const saves = parseSaves(monster?.saves);
  return saves[ability] ?? abilityModifier(monster?.abilityScores?.[ability] ?? 10);
}

// Every "N (XdY + Z) Type damage" in an attack's Hit: text
export function attackDamageParts(action) {
  const parts = [];
  const re = /\d+\s*\((\d+d\d+(?:\s*[+−-]\s*\d+)?)\)\s*(\w+)\s+damage/gi;
  let m;
  while ((m = re.exec(action.description || ""))) parts.push({ formula: m[1].replace(/\s/g, "").replace("−", "-"), type: m[2].toLowerCase() });
  if (!parts.length && action.damageDice) parts.push({ formula: `${action.damageDice}${action.damageBonus ? (action.damageBonus > 0 ? "+" : "") + action.damageBonus : ""}`, type: action.damageType || "" });
  return parts;
}

// The per-token copy of a stat block's mutable numbers
export function monsterTokenStats(m) {
  const d = parseDefenses(m);
  return {
    ac: m.ac || 10, hp: { current: m.hpAverage || 1, max: m.hpAverage || 1, temp: 0 }, hpFormula: m.hpFormula || null,
    conditions: [], exhaustion: 0, concentration: null,
    resist: d.resist, immune: d.immune, vulnerable: d.vulnerable, condImmune: d.condImmune,
    speed: m.speed || "30 ft.", init: m.initiative ?? abilityModifier(m.abilityScores?.dex ?? 10),
    cr: m.cr ?? "0", xp: m.xp || 0
  };
}

// ---------------- Loot (DMG 2024 ch. 4 & 7) ----------------
const RARITY_BANDS = [   // Magic Item Rarities: d100 ranges per tier
  [[54, "Common"], [91, "Uncommon"], [100, "Rare"]],
  [[30, "Common"], [81, "Uncommon"], [98, "Rare"], [100, "Very Rare"]],
  [[11, "Common"], [34, "Uncommon"], [70, "Rare"], [93, "Very Rare"], [100, "Legendary"]],
  [[20, "Rare"], [64, "Very Rare"], [100, "Legendary"]]
];
function tier(cr) { const v = crValue(cr); return v <= 4 ? 0 : v <= 10 ? 1 : v <= 16 ? 2 : 3; }
const dice = (n, s) => { let t = 0; for (let i = 0; i < n; i++) t += rollDie(s); return t; };

// Random Individual Treasure
export function rollIndividualCoins(cr) {
  return [() => ({ gp: dice(3, 6) }), () => ({ gp: dice(2, 8) * 10 }), () => ({ pp: dice(2, 10) * 10 }), () => ({ pp: dice(2, 8) * 100 })][tier(cr)]();
}

// Random Treasure Hoard: coins and how many magic items
export function rollHoard(cr) {
  const t = tier(cr);
  const gp = [() => dice(2, 4) * 100, () => dice(8, 10) * 100, () => dice(8, 8) * 1000, () => dice(6, 10) * 10000][t]();
  const items = [() => Math.max(0, rollDie(4) - 1), () => rollDie(3), () => rollDie(4), () => rollDie(6)][t]();
  return { gp, items };
}

export function rollRarity(cr) {
  const r = rollDie(100);
  return RARITY_BANDS[tier(cr)].find(([max]) => r <= max)[1];
}

// A random catalog item of the rolled rarity, preferring the monster's treasure themes
export function rollMagicItem(magicItems = [], cr, themes = []) {
  const rarity = rollRarity(cr);
  const want = themes.filter(t => ["Arcana", "Armaments", "Implements", "Relics"].includes(t));
  const ofRarity = magicItems.filter(i => (i.rarity || "").toLowerCase().startsWith(rarity.toLowerCase()));
  const themed = want.length ? ofRarity.filter(i => (i.themes || []).some(t => want.includes(t))) : ofRarity;
  const pool = themed.length ? themed : ofRarity.length ? ofRarity : magicItems;
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
}

// "Daggers (6), Wand" -> [{ name: "Daggers", quantity: 6 }, { name: "Wand", quantity: 1 }]
export function parseGear(s) {
  return String(s || "").split(/,(?![^(]*\))/).map(x => x.trim()).filter(Boolean).map(x => {
    const m = x.match(/^(.*?)\s*\((\d+)\)$/);
    return m ? { name: m[1], quantity: parseInt(m[2], 10) } : { name: x, quantity: 1 };
  });
}

// Loot rolled when a monster dies: its Gear, plus coins when it carries Individual
// treasure (or has no tag but is a gear-carrying humanoid). Themed/Any monsters get
// a hoard hint the DM can roll from the panel.
export function generateLoot(monster) {
  const tags = monster?.treasure || [];
  const items = parseGear(monster?.gear).map(g => ({ ...g, source: "gear" }));
  let coins = {};
  if (tags.includes("Individual") || (!tags.length && /humanoid/i.test(monster?.creatureType || "") && items.length)) coins = rollIndividualCoins(monster?.cr);
  const hoardThemes = tags.filter(t => t !== "Individual" && t !== "None");
  return { coins, items, hoardThemes, hoardRolled: false, sent: false, rolledAt: Date.now() };
}
