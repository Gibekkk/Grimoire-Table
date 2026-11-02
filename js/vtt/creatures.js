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
// A character's walking speed from its species / lineage
export function characterSpeed(character, ruleset) {
  const sp = (ruleset?.species || []).find(s => s.id === character?.speciesId);
  const opts = (sp?.choices || []).filter(c => c.type === "option").map(c => c.options.find(o => o.id === character.speciesChoices?.[c.id])).filter(Boolean);
  return opts.find(o => o.speed)?.speed || sp?.speed || 30;
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

// ---------------- Status effects ----------------
// Spells, actions and hazards a creature can be under, beyond the 14 conditions.
// Wording follows the PHB 2024 spell, class and Rules Glossary entries. Each active
// effect is stored as { id, rounds?, value?, custom fields } on the creature.
//   attack / attacked: "advantage" | "disadvantage" on its attacks / on attacks against it
//   attackDie, saveDie: dice added to attack rolls / saves (negative sides subtract)
//   saveMode, checkMode: { ability: mode }; saveMod: { ability: flat bonus }
//   ac, acMin, speedMult, speedBonus, speedZero, resist, immune, condImmune
//   ends: "turnStart" / "turnEnd" removes it at the start / end of the creature's turn
//   rounds: default duration, counted down at the start of each of its turns
//   tick: dice / type rolled at the start of its turn; temp / table are the other turn effects
const PHYSICAL = ["bludgeoning", "piercing", "slashing"];
export const STATUS_EFFECTS = [
  { id: "bless", name: "Bless", abbr: "Bs", group: "Spells", tone: "buff", rounds: 10, attackDie: 4, saveDie: 4, text: "Adds 1d4 to attack rolls and saving throws." },
  { id: "bane", name: "Bane", abbr: "Bn", group: "Spells", tone: "debuff", rounds: 10, attackDie: -4, saveDie: -4, text: "Subtracts 1d4 from attack rolls and saving throws." },
  { id: "haste", name: "Haste", abbr: "Ha", group: "Spells", tone: "buff", rounds: 10, speedMult: 2, ac: 2, saveMode: { dex: "advantage" }, endsInto: "lethargy", text: "Speed doubled, +2 AC, Advantage on Dex saves, one extra limited action each turn. When it ends: Incapacitated and Speed 0 until the end of its next turn." },
  { id: "lethargy", name: "Haste Lethargy", abbr: "Lt", group: "Spells", tone: "debuff", ends: "turnEnd", speedZero: true, addsConditions: ["Incapacitated"], hideInMenu: true, text: "Incapacitated and Speed 0 until the end of its next turn." },
  { id: "slow", name: "Slow", abbr: "Sl", group: "Spells", tone: "debuff", rounds: 10, speedMult: 0.5, ac: -2, saveMod: { dex: -2 }, text: "Speed halved, −2 to AC and Dex saves, no Reactions; an action or a Bonus Action, not both; one attack only." },
  { id: "shield-of-faith", name: "Shield of Faith", abbr: "SF", group: "Spells", tone: "buff", ac: 2, text: "+2 AC." },
  { id: "shield", name: "Shield", abbr: "Sh", group: "Spells", tone: "buff", ac: 5, ends: "turnStart", text: "+5 AC until the start of its next turn; no damage from Magic Missile." },
  { id: "barkskin", name: "Barkskin", abbr: "Bk", group: "Spells", tone: "buff", acMin: 17, text: "AC of 17 if its AC is lower." },
  { id: "blur", name: "Blur", abbr: "Bu", group: "Spells", tone: "buff", rounds: 10, attacked: "disadvantage", text: "Attacks against it have Disadvantage (not from Blindsight or Truesight)." },
  { id: "faerie-fire", name: "Faerie Fire", abbr: "FF", group: "Spells", tone: "debuff", rounds: 10, attacked: "advantage", noInvisible: true, outline: true, text: "Attacks against it have Advantage if the attacker can see it; it can't benefit from Invisible." },
  { id: "guiding-bolt", name: "Guiding Bolt", abbr: "GB", group: "Spells", tone: "debuff", rounds: 1, attacked: "advantage", text: "The next attack against it has Advantage. Remove it after that attack." },
  { id: "hex", name: "Hex", abbr: "Hx", group: "Spells", tone: "debuff", text: "The caster's hits deal an extra 1d6 Necrotic; Disadvantage on checks with one chosen ability." },
  { id: "hunters-mark", name: "Hunter's Mark", abbr: "HM", group: "Spells", tone: "debuff", text: "The caster's hits deal an extra 1d6 Force." },
  { id: "stoneskin", name: "Stoneskin", abbr: "Sk", group: "Spells", tone: "buff", resist: PHYSICAL, text: "Resistance to Bludgeoning, Piercing and Slashing." },
  { id: "enlarge", name: "Enlarged", abbr: "En", group: "Spells", tone: "buff", rounds: 10, sizeStep: 1, saveMode: { str: "advantage" }, checkMode: { str: "advantage" }, text: "One size larger (the token grows); Advantage on Str checks and saves; weapon hits deal an extra 1d4." },
  { id: "reduce", name: "Reduced", abbr: "Rd", group: "Spells", tone: "debuff", rounds: 10, sizeStep: -1, saveMode: { str: "disadvantage" }, checkMode: { str: "disadvantage" }, text: "One size smaller (the token shrinks); Disadvantage on Str checks and saves; weapon hits deal 1d4 less." },
  { id: "aid", name: "Aid", abbr: "Ad", group: "Spells", tone: "buff", hpBonus: 5, text: "Hit Point maximum and current Hit Points +5." },
  { id: "heroism", name: "Heroism", abbr: "He", group: "Spells", tone: "buff", rounds: 10, condImmune: ["Frightened"], tempFromValue: true, askValue: "Caster's spellcasting modifier (Temporary HP each turn):", text: "Immune to Frightened; Temporary HP equal to the caster's modifier at the start of each turn." },
  { id: "freedom", name: "Freedom of Movement", abbr: "FM", group: "Spells", tone: "buff", condImmune: ["Paralyzed", "Restrained"], text: "Can't be Paralyzed or Restrained by magic; 5 ft of movement escapes nonmagical restraints or a grapple." },
  { id: "death-ward", name: "Death Ward", abbr: "DW", group: "Spells", tone: "buff", deathWard: true, text: "The first time it would drop to 0 HP it drops to 1 HP instead, and the spell ends." },
  { id: "silence", name: "Silence", abbr: "Si", group: "Spells", tone: "debuff", immune: ["thunder"], addsConditions: ["Deafened"], text: "While inside: Deafened, immune to Thunder, no spells with a Verbal component." },
  { id: "sanctuary", name: "Sanctuary", abbr: "Sa", group: "Spells", tone: "buff", rounds: 10, text: "Attackers must pass a Wis save or pick a new target; ends if it attacks, casts a spell or deals damage." },
  { id: "protection-evil-good", name: "Protection from Evil and Good", abbr: "PE", group: "Spells", tone: "buff", text: "Aberrations, Celestials, Elementals, Fey, Fiends and Undead have Disadvantage on attacks against it and can't Charm or Frighten it." },
  { id: "mirror-image", name: "Mirror Image", abbr: "MI", group: "Spells", tone: "buff", rounds: 10, text: "When hit, roll a d6 per duplicate: on 3+ a duplicate is hit and destroyed instead." },
  { id: "confusion", name: "Confusion", abbr: "Cf", group: "Spells", tone: "debuff", rounds: 10, table: "confusion", text: "No Bonus Actions or Reactions; rolls 1d10 at the start of each turn for its behavior; repeats the Wis save at the end of each turn." },
  { id: "rage", name: "Raging", abbr: "Rg", group: "Actions", tone: "buff", rounds: 100, resist: PHYSICAL, saveMode: { str: "advantage" }, checkMode: { str: "advantage" }, text: "Resistance to Bludgeoning, Piercing and Slashing; Advantage on Str checks and saves; Rage damage on Str attacks." },
  { id: "reckless", name: "Reckless", abbr: "Rk", group: "Actions", tone: "neutral", ends: "turnStart", attack: "advantage", attacked: "advantage", text: "Advantage on Str attacks, and attacks against it have Advantage, until the start of its next turn." },
  { id: "dodge", name: "Dodging", abbr: "Dg", group: "Actions", tone: "buff", ends: "turnStart", attacked: "disadvantage", saveMode: { dex: "advantage" }, text: "Attacks against it have Disadvantage if it can see the attacker; Advantage on Dex saves, until the start of its next turn." },
  { id: "dash", name: "Dashing", abbr: "Da", group: "Actions", tone: "buff", ends: "turnEnd", speedMult: 2, text: "Extra movement equal to its Speed this turn." },
  { id: "disengage", name: "Disengaged", abbr: "Dn", group: "Actions", tone: "buff", ends: "turnEnd", text: "Its movement doesn't provoke Opportunity Attacks this turn." },
  { id: "half-cover", name: "Half Cover", abbr: "½C", group: "Actions", tone: "buff", ac: 2, saveMod: { dex: 2 }, text: "+2 to AC and Dex saves." },
  { id: "three-quarters-cover", name: "Three-Quarters Cover", abbr: "¾C", group: "Actions", tone: "buff", ac: 5, saveMod: { dex: 5 }, text: "+5 to AC and Dex saves." },
  { id: "surprised", name: "Surprised", abbr: "Su", group: "Actions", tone: "debuff", initiative: "disadvantage", text: "Disadvantage on its Initiative roll." },
  { id: "burning", name: "Burning", abbr: "Bg", group: "Hazards", tone: "hazard", tick: { dice: "1d4", type: "fire" }, text: "1d4 Fire at the start of each turn. Action: go Prone and roll to put it out." },
  { id: "suffocating", name: "Suffocating", abbr: "Sf", group: "Hazards", tone: "hazard", exhaustionAtTurnEnd: true, text: "Gains 1 Exhaustion level at the end of each turn; removes those levels when it can breathe again." }
];
const EFFECT_BY_ID = new Map(STATUS_EFFECTS.map(e => [e.id, e]));

// Rules for an active effect (built-in, or a custom one carrying its own fields)
export function effectDef(e) {
  const id = typeof e === "string" ? e : e.id;
  return EFFECT_BY_ID.get(id) || (typeof e === "object" ? { tone: "neutral", abbr: (e.name || "?").slice(0, 2), text: e.text || "Custom effect.", ...e } : null);
}
export function hasEffect(effects = [], id) { return effects.some(e => e.id === id); }
const defsOf = (effects = []) => effects.map(effectDef).filter(Boolean);

export function newEffect(id, extra = {}) {
  const def = effectDef(id);
  const out = { id, ...extra };
  if (def?.rounds && out.rounds == null) out.rounds = def.rounds;
  return out;
}

// The state changes from switching an effect on or off. `st` has effects, hp, conditions, exhaustion.
export function effectPatch(st, id, on, extra = {}) {
  const def = effectDef(id) || effectDef((st.effects || []).find(e => e.id === id) || id);
  const rest = (st.effects || []).filter(e => e.id !== id);
  const patch = { effects: on ? [...rest, id.startsWith("custom:") ? { id, ...extra } : newEffect(id, extra)] : rest };
  if (def?.hpBonus) {
    const d = on ? def.hpBonus : -def.hpBonus, hp = st.hp || { current: 0, max: 0, temp: 0 };
    patch.hp = { ...hp, max: Math.max(1, hp.max + d), current: Math.max(on ? 0 : Math.min(1, hp.current), Math.min(hp.max + d, hp.current + (on ? d : 0))) };
  }
  let conditions = st.conditions || [];
  (def?.addsConditions || []).forEach(c => { conditions = withCondition(conditions, c, on); });
  if (!on && def?.endsInto) {
    const after = effectDef(def.endsInto);
    patch.effects = [...patch.effects, newEffect(def.endsInto)];
    (after.addsConditions || []).forEach(c => { conditions = withCondition(conditions, c, true); });
  }
  if (conditions !== (st.conditions || [])) patch.conditions = conditions;
  return patch;
}

// Conditions it can't gain right now: its own immunities plus those from effects
export function conditionImmunities(st) {
  return [...new Set([...(st.condImmune || []), ...defsOf(st.effects).flatMap(d => d.condImmune || [])])];
}

export function effectAc(baseAc, effects = []) {
  const defs = defsOf(effects);
  const parts = defs.filter(d => d.ac).map(d => ({ label: d.name, value: d.ac }));
  let ac = baseAc + parts.reduce((s, p) => s + p.value, 0);
  defs.filter(d => d.acMin).forEach(d => { if (ac < d.acMin) { parts.push({ label: d.name, value: d.acMin - ac }); ac = d.acMin; } });
  return { ac, parts };
}

// Speed in feet after conditions, Exhaustion and effects, with what's holding it at 0
export function effectiveSpeed(base, conditions = [], exhaustion = 0, effects = []) {
  const defs = defsOf(effects);
  const stuck = conditions.find(c => SPEED_ZERO.includes(c)) || defs.find(d => d.speedZero)?.name;
  if (stuck) return { ft: 0, why: stuck };
  let ft = base + defs.reduce((s, d) => s + (d.speedBonus || 0), 0);
  defs.forEach(d => { if (d.speedMult) ft *= d.speedMult; });
  return { ft: Math.max(0, Math.floor(ft / 5) * 5 - 5 * (exhaustion || 0)), why: null };
}
export function isImmobile(conditions = [], effects = []) {
  return hasSpeedZero(conditions) || defsOf(effects).some(d => d.speedZero);
}

function pickMode(adv, dis) { return adv.length && !dis.length ? "advantage" : dis.length && !adv.length ? "disadvantage" : "normal"; }
const invisibleCounts = (conditions, effects) => conditions.includes("Invisible") && !defsOf(effects).some(d => d.noInvisible);

// d20 mode for this creature's own attack rolls, with the reasons and any dice to add.
// `vsGrappler` is true when the target is the creature grappling it.
export function attackMode(conditions = [], exhaustion = 0, { vsGrappler = false, effects = [] } = {}) {
  const dis = [], adv = [];
  ["Blinded", "Frightened", "Poisoned", "Prone", "Restrained"].forEach(c => { if (conditions.includes(c)) dis.push(c); });
  if (conditions.includes("Grappled") && !vsGrappler) dis.push("Grappled");
  if (invisibleCounts(conditions, effects)) adv.push("Invisible");
  const defs = defsOf(effects);
  defs.forEach(d => { if (d.attack === "advantage") adv.push(d.name); if (d.attack === "disadvantage") dis.push(d.name); });
  return { mode: pickMode(adv, dis), reasons: [...adv.map(r => `+${r}`), ...dis.map(r => `−${r}`)], penalty: -2 * (exhaustion || 0),
    dice: defs.filter(d => d.attackDie).map(d => ({ sides: d.attackDie, name: d.name })) };
}

// Saving throws: auto-fail Str/Dex when Paralyzed etc., Disadvantage on Dex when Restrained, plus effects.
export function saveRule(ability, conditions = [], exhaustion = 0, effects = []) {
  if ((ability === "str" || ability === "dex") && conditions.some(c => FAILS_STR_DEX.includes(c))) {
    return { autoFail: true, reason: conditions.find(c => FAILS_STR_DEX.includes(c)), mode: "normal", penalty: 0, dice: [] };
  }
  const adv = [], dis = [];
  if (ability === "dex" && conditions.includes("Restrained")) dis.push("Restrained");
  const defs = defsOf(effects);
  defs.forEach(d => { if (d.saveMode?.[ability] === "advantage") adv.push(d.name); if (d.saveMode?.[ability] === "disadvantage") dis.push(d.name); });
  const flat = defs.reduce((s, d) => s + (d.saveMod?.[ability] || 0), 0);
  return { autoFail: false, mode: pickMode(adv, dis), reason: [...adv, ...dis].join(", ") || null, penalty: flat - 2 * (exhaustion || 0),
    dice: defs.filter(d => d.saveDie).map(d => ({ sides: d.saveDie, name: d.name })) };
}

// Ability checks: Disadvantage when Poisoned or Frightened, plus effects.
export function checkRule(ability, conditions = [], exhaustion = 0, effects = []) {
  const adv = [], dis = [];
  ["Poisoned", "Frightened"].forEach(c => { if (conditions.includes(c)) dis.push(c); });
  defsOf(effects).forEach(d => { if (d.checkMode?.[ability] === "advantage") adv.push(d.name); if (d.checkMode?.[ability] === "disadvantage") dis.push(d.name); });
  return { mode: pickMode(adv, dis), reason: [...adv, ...dis].join(", ") || null, penalty: -2 * (exhaustion || 0), dice: [] };
}

export function initiativeRule(conditions = [], exhaustion = 0, effects = []) {
  const adv = [], dis = [];
  if (invisibleCounts(conditions, effects)) adv.push("Invisible");
  if (isIncapacitated(conditions)) dis.push("Incapacitated");
  defsOf(effects).forEach(d => { if (d.initiative === "disadvantage") dis.push(d.name); });
  return { mode: pickMode(adv, dis), reason: [...adv, ...dis].join(", ") || null, penalty: -2 * (exhaustion || 0), dice: [] };
}

// Rolls the extra dice (Bless, Bane) into a flat modifier; returns the total and a label suffix
export function rollExtraDice(dice = []) {
  let total = 0;
  const notes = dice.map(d => {
    const n = rollDie(Math.abs(d.sides)), v = d.sides < 0 ? -n : n;
    total += v;
    return `${d.name} ${v >= 0 ? "+" : "−"}${Math.abs(v)}`;
  });
  return { total, note: notes.join(", ") };
}

// What attackers get against this creature
export function defenseNotes(conditions = [], effects = []) {
  const notes = [];
  if (conditions.some(c => ["Blinded", "Paralyzed", "Petrified", "Restrained", "Stunned", "Unconscious"].includes(c))) notes.push("Attacks against it have Advantage");
  if (conditions.includes("Prone")) notes.push("Prone: Advantage within 5 ft, Disadvantage from farther");
  if (invisibleCounts(conditions, effects)) notes.push("Attacks against it have Disadvantage");
  if (conditions.some(c => c === "Paralyzed" || c === "Unconscious")) notes.push("Hits from within 5 ft are Critical Hits");
  defsOf(effects).forEach(d => {
    if (d.attacked === "advantage") notes.push(`Attacks against it have Advantage (${d.name})`);
    if (d.attacked === "disadvantage") notes.push(`Attacks against it have Disadvantage (${d.name})`);
  });
  return notes;
}

// One size category up or down from Enlarge / Reduce; custom non-square tokens stay as they are
export function effectiveSquares(squares, effects = []) {
  const step = defsOf(effects).reduce((s, d) => s + (d.sizeStep || 0), 0);
  if (!step) return squares;
  const order = [0.5, 1, 2, 3, 4];
  const i = order.indexOf(squares);
  return i < 0 ? squares : order[Math.max(0, Math.min(order.length - 1, i + step))];
}

// What a confused creature does this turn (Confusion's 1d10 table)
export function confusionResult(d10, d4) {
  if (d10 === 1) return `doesn't act and uses all its movement to move ${["north", "east", "south", "west"][d4 - 1]}`;
  if (d10 <= 6) return "doesn't move or take actions";
  if (d10 <= 8) return "doesn't move, and makes one melee attack against a random creature in reach (no action if none)";
  return "chooses its own behavior";
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
export function adjustDamage(amount, type, def = {}, conditions = [], effects = []) {
  amount = Math.max(0, Math.floor(amount || 0));
  if (!type) return { amount, note: "" };
  const defs = defsOf(effects);
  if ((def.immune || []).includes(type) || defs.some(d => d.immune?.includes(type))) return { amount: 0, note: `immune to ${type}` };
  const resists = (def.resist || []).includes(type) || conditions.includes("Petrified") || defs.some(d => d.resist?.includes(type));
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
// Where a grappled token sits relative to its grappler. (dx, dy) is the wanted offset of
// the target's corner from the grappler's corner; the result keeps that direction but
// sits on the ring where the footprints touch, so it stays within 5 ft at any angle.
export function ringOffset(g, t, dx, dy) {
  const gw = g.w || 1, gh = g.h || 1, tw = t.w || 1, th = t.h || 1;
  const hw = (gw + tw) / 2, hh = (gh + th) / 2;
  let cx = dx + tw / 2 - gw / 2, cy = dy + th / 2 - gh / 2;
  if (!cx && !cy) cx = hw;
  const k = 1 / Math.max(Math.abs(cx) / hw, Math.abs(cy) / hh);
  cx *= k; cy *= k;
  // The axis against the edge stays exact; the other rounds toward the middle of the edge
  const onEdgeX = Math.abs(cx) >= hw - 1e-6, onEdgeY = Math.abs(cy) >= hh - 1e-6;
  const quarter = (v) => Math.trunc(v * 4) / 4;
  const ox = onEdgeX ? Math.sign(cx) * hw : quarter(cx), oy = onEdgeY ? Math.sign(cy) * hh : quarter(cy);
  return { dx: ox - tw / 2 + gw / 2, dy: oy - th / 2 + gh / 2 };
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
