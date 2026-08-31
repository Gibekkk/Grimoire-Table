import { h, toast } from "../util.js";
import { findById } from "../data-loader.js";
import {
  getClassEntries, spellSlotTable, spellSaveDc, spellAttackBonus, formatModifier
} from "../rules-engine.js";
import { parseNotation } from "../dice/roll-logic.js";

export function renderSpellsTab(ctx) {
  const { character, ruleset, canEditCore, patch, onRoll, currentAdvMode } = ctx;
  const entries = getClassEntries(character);
  const casterEntries = entries
    .map(e => ({ entry: e, cls: findById(ruleset.classes, e.classId) }))
    .filter(x => x.cls?.spellcasting);

  if (casterEntries.length === 0) {
    const empty = h("div", { class: "card" });
    empty.appendChild(h("p", {}, "This character has no spellcasting class."));
    return empty;
  }

  const wrap = h("div", {});

  // ---- DCs / attack bonus per casting class ----
  const dcCard = h("div", { class: "card" });
  dcCard.appendChild(h("h3", {}, "Spellcasting"));
  const strip = h("div", { class: "combat-strip" });
  casterEntries.forEach(({ cls }) => {
    const dc = spellSaveDc(character, cls.spellcasting.ability);
    const atk = spellAttackBonus(character, cls.spellcasting.ability);
    strip.innerHTML += `
      <div class="combat-stat"><div class="val">${dc}</div><div class="lbl">${cls.name} Save DC</div></div>
      <div class="combat-stat"><div class="val">${formatModifier(atk)}</div><div class="lbl">${cls.name} Attack</div></div>
    `;
  });
  dcCard.appendChild(strip);
  wrap.appendChild(dcCard);

  // ---- Spell slots ----
  const { slots, pact } = spellSlotTable(character);
  const slotsCard = h("div", { class: "card" });
  slotsCard.appendChild(h("h3", {}, "Spell Slots"));
  const used = character.spellSlotsUsed || {};
  slots.forEach((count, idx) => {
    if (!count) return;
    const lvl = idx + 1;
    const usedCount = used[lvl] || 0;
    const row = h("div", { class: "pip-row" });
    row.innerHTML = `<div class="pip-label">Level ${lvl}</div>`;
    const pips = h("div", { class: "pips" });
    for (let i = 0; i < count; i++) {
      const pip = h("button", { class: `pip ${i < (count - usedCount) ? "filled" : ""}` });
      pip.addEventListener("click", () => {
        const remaining = count - usedCount;
        const next = i < remaining ? usedCount + 1 : Math.max(0, usedCount - 1);
        patch({ spellSlotsUsed: { ...used, [lvl]: next } });
      });
      pips.appendChild(pip);
    }
    row.appendChild(pips);
    slotsCard.appendChild(row);
  });
  if (pact) {
    const pactUsed = character.pactSlotsUsed || 0;
    const row = h("div", { class: "pip-row" });
    row.innerHTML = `<div class="pip-label">Pact Magic<span class="sub">Level ${pact.level} \u2022 recharges on Short Rest</span></div>`;
    const pips = h("div", { class: "pips" });
    for (let i = 0; i < pact.count; i++) {
      const pip = h("button", { class: `pip pact ${i < (pact.count - pactUsed) ? "filled" : ""}` });
      pip.addEventListener("click", () => {
        const remaining = pact.count - pactUsed;
        const next = i < remaining ? pactUsed + 1 : Math.max(0, pactUsed - 1);
        patch({ pactSlotsUsed: next });
      });
      pips.appendChild(pip);
    }
    row.appendChild(pips);
    slotsCard.appendChild(row);
  }
  wrap.appendChild(slotsCard);

  // ---- Prepared spells ----
  const preparedCard = h("div", { class: "card" });
  preparedCard.appendChild(h("h3", {}, "Prepared Spells"));
  const prepared = character.spellsPrepared || [];
  const byLevel = {};
  prepared.forEach(id => {
    const sp = findById(ruleset.spells, id);
    if (!sp) return;
    byLevel[sp.level] = byLevel[sp.level] || [];
    byLevel[sp.level].push(sp);
  });
  Object.keys(byLevel).sort((a, b) => a - b).forEach(lvl => {
    preparedCard.appendChild(h("h4", { style: "margin-top:10px;" }, lvl == 0 ? "Cantrips" : `Level ${lvl}`));
    byLevel[lvl].forEach(sp => {
      const primaryCaster = casterEntries[0];
      const card = h("div", { class: "lore-card" });
      card.innerHTML = `
        <div class="lore-title"><span>${sp.name}</span><span class="badge">${sp.school}</span></div>
        <div class="lore-desc">${sp.summary}</div>
        <div class="lore-tags">
          <span class="badge">${sp.castingTime}</span><span class="badge">${sp.range}</span>
          ${sp.concentration ? '<span class="badge rune">Concentration</span>' : ""}
          ${sp.save ? `<span class="badge gold">Save DC ${spellSaveDc(character, primaryCaster.cls.spellcasting.ability)}</span>` : ""}
        </div>
      `;
      const actions = h("div", { class: "row-actions" });
      if (sp.damageDice) {
        const castBtn = h("button", { class: "btn sm danger" }, "Cast \u2014 Damage");
        castBtn.addEventListener("click", () => {
          if (sp.attackRoll) {
            onRoll({ sides: 20, count: 1, modifier: spellAttackBonus(character, primaryCaster.cls.spellcasting.ability), label: `${sp.name} \u2014 Spell Attack`, mode: currentAdvMode() });
          }
          const parsed = parseNotation(sp.damageDice.includes("x") ? sp.damageDice.split("x")[1] : sp.damageDice) || { count: 1, sides: 6, modifier: 0 };
          const multiplier = sp.damageDice.includes("x") ? parseInt(sp.damageDice.split("x")[0], 10) : 1;
          onRoll({ sides: parsed.sides, count: parsed.count * multiplier, modifier: parsed.modifier, mode: "normal", label: `${sp.name} \u2014 Damage (${sp.damageType})` });
        });
        actions.appendChild(castBtn);
      } else {
        const castBtn = h("button", { class: "btn sm" }, "Cast");
        castBtn.addEventListener("click", () => toast(`${sp.name} cast \u2014 apply its effect at the table`));
        actions.appendChild(castBtn);
      }
      if (canEditCore) {
        const rmBtn = h("button", { class: "btn sm ghost" }, "Forget");
        rmBtn.addEventListener("click", () => patch({ spellsPrepared: prepared.filter(id => id !== sp.id) }));
        actions.appendChild(rmBtn);
      }
      card.appendChild(actions);
      preparedCard.appendChild(card);
    });
  });
  if (prepared.length === 0) preparedCard.appendChild(h("p", {}, "No spells prepared yet \u2014 add some below."));
  wrap.appendChild(preparedCard);

  // ---- Spell picker ----
  if (canEditCore) {
    const pickerCard = h("div", { class: "card" });
    pickerCard.appendChild(h("h3", {}, "Learn a Spell"));
    const classIds = casterEntries.map(x => x.cls.id);
    const available = ruleset.spells.filter(sp => sp.classes.some(c => classIds.includes(c)) && !prepared.includes(sp.id));
    const sel = h("select", {});
    available.forEach(sp => sel.appendChild(h("option", { value: sp.id }, `${sp.level === 0 ? "Cantrip" : `Lv${sp.level}`} \u2014 ${sp.name}`)));
    const addBtn = h("button", { class: "btn primary sm" }, "Add to Prepared");
    addBtn.addEventListener("click", () => {
      if (!sel.value) return;
      patch({ spellsPrepared: [...prepared, sel.value] });
    });
    const row = h("div", { class: "field-row" });
    row.appendChild(sel); row.appendChild(addBtn);
    pickerCard.appendChild(row);
    pickerCard.appendChild(h("p", {}, "Starter spell list \u2014 expand data/spells.json (or the rules_spells Firestore collection) to add more."));
    wrap.appendChild(pickerCard);
  }

  return wrap;
}
