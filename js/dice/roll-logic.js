import { rollDie } from "../rules-engine.js";

// spec: { sides, count, modifier, mode: 'normal'|'advantage'|'disadvantage', label, isPercentile }
// Advantage/disadvantage per PHB 2024 apply to a single d20 test: roll two d20s,
// keep the higher (advantage) or lower (disadvantage).
export function computeRoll(spec) {
  const { sides, count = 1, modifier = 0, mode = "normal", label = "", isPercentile = false } = spec;

  if (isPercentile) {
    const tens = rollDie(10) - 1; // 0-9, represents 00/10/.../90
    const units = rollDie(10) - 1; // 0-9
    const subtotal = (tens === 0 && units === 0) ? 100 : tens * 10 + units;
    const total = subtotal + modifier;
    return {
      label, sides: 100, count: 1, modifier, mode,
      rawRolls: [tens * 10, units], kept: [subtotal], subtotal, total,
      isCritHigh: false, isCritLow: false, isPercentile: true,
      seed: Math.floor(Math.random() * 2 ** 31)
    };
  }

  let rawRolls = [];
  let kept = [];

  if (sides === 20 && mode !== "normal" && count === 1) {
    const a = rollDie(20), b = rollDie(20);
    rawRolls = [a, b];
    kept = [mode === "advantage" ? Math.max(a, b) : Math.min(a, b)];
  } else {
    for (let i = 0; i < count; i++) rawRolls.push(rollDie(sides));
    kept = rawRolls;
  }

  const subtotal = kept.reduce((a, b) => a + b, 0);
  const total = subtotal + modifier;
  const isCritHigh = sides === 20 && count === 1 && kept[0] === 20;
  const isCritLow = sides === 20 && count === 1 && kept[0] === 1;

  return {
    label, sides, count, modifier, mode,
    rawRolls, kept, subtotal, total,
    isCritHigh, isCritLow,
    seed: Math.floor(Math.random() * 2 ** 31) // cosmetic only — drives the visual tumble
  };
}

export function parseNotation(notation) {
  // "2d6+3", "1d20", "1d8-1"
  const m = notation.replace(/\s+/g, "").match(/^(\d*)d(\d+)([+-]\d+)?$/i);
  if (!m) return null;
  return {
    count: m[1] ? parseInt(m[1], 10) : 1,
    sides: parseInt(m[2], 10),
    modifier: m[3] ? parseInt(m[3], 10) : 0
  };
}

export function formatBreakdown(result) {
  if (result.isPercentile) return `(percentile: ${result.subtotal})`;
  const dicePart = result.mode !== "normal" && result.rawRolls.length === 2
    ? `(${result.rawRolls.join(", ")} \u2192 ${result.kept[0]})`
    : `(${result.rawRolls.join(" + ")})`;
  const modPart = result.modifier ? ` ${result.modifier >= 0 ? "+" : "-"} ${Math.abs(result.modifier)}` : "";
  return `d${result.sides}${dicePart}${modPart}`;
}
