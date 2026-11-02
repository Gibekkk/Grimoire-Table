import { h, toast, escapeHtml } from "../util.js";
import { findById } from "../data-loader.js";
import {
  getClassEntries, spellSlotTable, spellSaveDc, spellAttackBonus, formatModifier, totalLevel,
  entrySpellcasting, spellLimits, maxSpellLevelFor, ABILITY_NAMES, subclassSlug
} from "../rules-engine.js";
import { parseNotation } from "../dice/roll-logic.js";

function textHtml(text) {
  return escapeHtml(text || "").split("\n").map(p => p.replace(/^([A-Z][A-Za-z' ,\-()/]{1,48}\.)(\s)/, "<strong>$1</strong>$2")).map(p => `<p>${p}</p>`).join("");
}

// Damage dice for a cast: cantrips scale with character level (5/11/17), leveled
// spells add the "increases by XdY for each spell slot level above N" amount.
export function scaledDamage(spell, slotLevel, charLevel) {
  if (!spell.damageDice) return null;
  const base = parseNotation(spell.damageDice.replace(/\s/g, ""));
  if (!base) return null;
  let count = base.count;
  if (spell.level === 0) {
    const tier = charLevel >= 17 ? 4 : charLevel >= 11 ? 3 : charLevel >= 5 ? 2 : 1;
    if (spell.id !== "eldritch-blast") count *= tier;
  } else if (slotLevel > spell.level && spell.higherLevel) {
    const m = spell.higherLevel.match(/increases by (\d+)d(\d+)/i);
    if (m && parseInt(m[2], 10) === base.sides) count += parseInt(m[1], 10) * (slotLevel - spell.level);
  }
  return { count, sides: base.sides, modifier: base.modifier };
}

// Spell-adder filters survive the full re-render that follows every patch.
const adderMemory = {};

export function renderSpellsTab(ctx) {
  const { character, ruleset, canEditCore, patch, onRoll, currentAdvMode } = ctx;
  const entries = getClassEntries(character);
  const charLevel = totalLevel(character);
  const casters = entries.map(e => ({ entry: e, cls: findById(ruleset.classes, e.classId), sc: entrySpellcasting(e, ruleset.classes) })).filter(x => x.sc);
  const sp = findById(ruleset.species, character.speciesId);
  const featRecs = character.feats || [];
  const magicInit = featRecs.filter(f => f.featId === "magic-initiate");
  const wrap = h("div", {});

  // Extra casting sources (species lineage spells, Magic Initiate) use their own ability
  const speciesAbility = character.speciesChoices?.spellAbility || sp?.spellAbility || null;
  const extraSources = [];
  if (sp) {
    const free = [...(character.spellsKnown?.species || sp.cantrips || [])];
    const always = [];
    (sp.choices || []).forEach(ch => {
      if (ch.type !== "option") return;
      const opt = ch.options.find(o => o.id === character.speciesChoices?.[ch.id]);
      (opt?.cantrips || []).forEach(c => { if (!free.includes(c)) free.push(c); });
      Object.entries(opt?.spells || {}).forEach(([lvl, id]) => { if (charLevel >= parseInt(lvl, 10)) always.push(id); });
      (opt?.alwaysPrepared || []).forEach(id => always.push(id));
    });
    if (free.length || always.length) extraSources.push({ label: sp.name, ability: speciesAbility || "cha", cantrips: free, freeSpells: always });
  }
  magicInit.forEach(m => extraSources.push({ label: `Magic Initiate (${m.choices?.list || "?"})`, ability: m.choices?.ability || "int", cantrips: m.choices?.cantrips || [], freeSpells: m.choices?.spell ? [m.choices.spell] : [] }));

  if (!casters.length && !extraSources.length) {
    const empty = h("div", { class: "card" });
    empty.appendChild(h("p", {}, "This character has no spellcasting."));
    return empty;
  }

  // ---- DCs / attack bonus ----
  const dcCard = h("div", { class: "card" });
  dcCard.appendChild(h("h3", {}, "Spellcasting"));
  const strip = h("div", { class: "combat-strip" });
  // One DC/attack pair per spellcasting ability, labelled with every source using it
  const byAbility = new Map();
  [...casters.map(c => ({ label: c.cls.name, ability: c.sc.ability })), ...extraSources.map(s => ({ label: s.label, ability: s.ability }))].forEach(({ label, ability }) => {
    if (!byAbility.has(ability)) byAbility.set(ability, []);
    if (!byAbility.get(ability).includes(label)) byAbility.get(ability).push(label);
  });
  byAbility.forEach((labels, ability) => {
    const who = escapeHtml(labels.join(", "));
    strip.appendChild(h("div", { class: "combat-stat" }, `<div class="val">${spellSaveDc(character, ability)}</div><div class="lbl">Save DC (${ability.toUpperCase()})</div><div class="sub">${who}</div>`));
    strip.appendChild(h("div", { class: "combat-stat" }, `<div class="val">${formatModifier(spellAttackBonus(character, ability))}</div><div class="lbl">Spell Attack (${ability.toUpperCase()})</div><div class="sub">${who}</div>`));
  });
  dcCard.appendChild(strip);
  wrap.appendChild(dcCard);

  // ---- Spell slots ----
  const { slots, pact } = spellSlotTable(character);
  const used = character.spellSlotsUsed || {};
  if (slots.length || pact) {
    const slotsCard = h("div", { class: "card" });
    slotsCard.appendChild(h("h3", {}, "Spell Slots"));
    const pipRow = (label, sub, count, usedCount, onToggle, extraClass = "") => {
      const row = h("div", { class: "pip-row" });
      row.innerHTML = `<div class="pip-label">${label}${sub ? `<span class="sub">${sub}</span>` : ""}</div>`;
      const pips = h("div", { class: "pips" });
      for (let i = 0; i < count; i++) {
        const pip = h("button", { class: `pip ${extraClass} ${i < (count - usedCount) ? "filled" : ""}` });
        pip.disabled = !ctx.canEditVitals;
        pip.addEventListener("click", () => onToggle(i < count - usedCount ? usedCount + 1 : Math.max(0, usedCount - 1)));
        pips.appendChild(pip);
      }
      row.appendChild(pips);
      return row;
    };
    slots.forEach((count, idx) => {
      if (!count) return;
      const lvl = idx + 1;
      slotsCard.appendChild(pipRow(`Level ${lvl}`, "", count, used[lvl] || 0, (n) => patch({ spellSlotsUsed: { ...used, [lvl]: n } })));
    });
    if (pact) slotsCard.appendChild(pipRow("Pact Magic", `Level ${pact.level} • recharges on Short Rest`, pact.count, character.pactSlotsUsed || 0, (n) => patch({ pactSlotsUsed: n }), "pact"));
    wrap.appendChild(slotsCard);
  }

  // ---- Casting helpers ----
  function availableSlotLevels(minLevel) {
    const out = [];
    slots.forEach((count, idx) => { const lvl = idx + 1; if (lvl >= minLevel && count - (used[lvl] || 0) > 0) out.push({ kind: "slot", level: lvl, left: count - (used[lvl] || 0) }); });
    if (pact && pact.level >= minLevel && pact.count - (character.pactSlotsUsed || 0) > 0) out.push({ kind: "pact", level: pact.level, left: pact.count - (character.pactSlotsUsed || 0) });
    return out;
  }
  function startConcentration(spell) {
    if (!spell.concentration) return;
    if (character.concentration && character.concentration !== spell.name) toast(`${character.concentration} ends \u2014 now concentrating on ${spell.name}`);
    ctx.setConcentration?.(spell.name);
  }
  function rollSpell(spell, ability, slotLevel) {
    startConcentration(spell);
    if (spell.attackRoll) onRoll({ sides: 20, count: 1, modifier: spellAttackBonus(character, ability), label: `${spell.name} — Spell Attack`, mode: currentAdvMode() });
    const dmg = scaledDamage(spell, slotLevel, charLevel);
    if (dmg) onRoll({ sides: dmg.sides, count: dmg.count, modifier: dmg.modifier, mode: "normal", label: `${spell.name} — ${spell.damageType || ""} damage${spell.save ? ` (DC ${spellSaveDc(character, ability)} ${spell.save.toUpperCase()} save)` : ""}` });
    if (spell.healDice) {
      const heal = parseNotation(spell.healDice);
      if (heal) {
        let count = heal.count;
        const m = spell.higherLevel?.match(/increases by (\d+)d(\d+)/i);
        if (m && slotLevel > spell.level) count += parseInt(m[1], 10) * (slotLevel - spell.level);
        const mod = /spellcasting ability modifier/i.test(spell.description) ? Math.max(0, Math.floor((character.abilityScores[ability] - 10) / 2)) : 0;
        onRoll({ sides: heal.sides, count, modifier: heal.modifier + mod, mode: "normal", label: `${spell.name} — Healing` });
      }
    }
    if (!dmg && !spell.healDice && !spell.attackRoll) toast(`${spell.name} cast${spell.save ? ` — targets make a DC ${spellSaveDc(character, ability)} ${ABILITY_NAMES[spell.save]} save` : ""}`);
  }
  function castWithSlot(spell, ability, btn) {
    if (spell.level === 0) { rollSpell(spell, ability, 0); return; }
    const opts = availableSlotLevels(spell.level);
    if (!opts.length) { toast(`No spell slots of level ${spell.level}+ left`, "error"); return; }
    const spend = (o) => {
      if (o.kind === "pact") patch({ pactSlotsUsed: (character.pactSlotsUsed || 0) + 1 });
      else patch({ spellSlotsUsed: { ...used, [o.level]: (used[o.level] || 0) + 1 } });
      rollSpell(spell, ability, o.level);
    };
    if (opts.length === 1) { spend(opts[0]); return; }
    import("../util.js").then(({ showContextMenu }) => {
      const r = btn.getBoundingClientRect();
      showContextMenu(r.left, r.bottom, [{ header: "Cast using…" }, ...opts.map(o => ({ label: `${o.kind === "pact" ? "Pact slot" : "Level " + o.level + " slot"} (${o.left} left)`, action: () => spend(o) }))]);
    });
  }

  function spellCard(spell, { ability, actions = [], tags = [] }) {
    const card = h("details", { class: "lore-card spell-card" });
    const dc = spell.save ? `<span class="badge gold">DC ${spellSaveDc(character, ability)} ${spell.save.toUpperCase()}</span>` : "";
    card.appendChild(h("summary", { class: "lore-title" }, `<span>${escapeHtml(spell.name)}</span><span class="spell-tags">${tags.join("")}${spell.concentration ? '<span class="badge rune">C</span>' : ""}${spell.ritual ? '<span class="badge">R</span>' : ""}${dc}</span>`));
    card.appendChild(h("div", { class: "lore-tags" }, `<span class="badge">${escapeHtml(spell.school || "")}</span><span class="badge">${escapeHtml(spell.castingTime)}</span><span class="badge">${escapeHtml(spell.range)}</span><span class="badge">${escapeHtml(spell.components || "")}</span><span class="badge">${escapeHtml(spell.duration)}</span>`));
    card.appendChild(h("div", { class: "lore-desc" }, textHtml(spell.description) + (spell.higherLevel ? `<p><strong>${spell.level === 0 ? "Cantrip Upgrade." : "Using a Higher-Level Spell Slot."}</strong> ${escapeHtml(spell.higherLevel)}</p>` : "")));
    if (actions.length) {
      const row = h("div", { class: "row-actions" });
      actions.forEach(a => row.appendChild(a));
      card.appendChild(row);
    }
    return card;
  }
  const btn = (label, cls, fn) => { const b = h("button", { class: `btn sm ${cls}` }, label); b.addEventListener("click", (e) => { e.preventDefault(); fn(b); }); return b; };

  // ---- Class spells (cantrips + prepared) ----
  const prepared = character.spellsPrepared || [];
  const spellbook = character.spellsKnown?.spellbook || [];
  casters.forEach(({ entry, cls, sc }) => {
    const lim = spellLimits(entry, ruleset.classes);
    const maxLvl = maxSpellLevelFor(entry, ruleset.classes);
    const list = sc.list;
    const mine = prepared.map(id => findById(ruleset.spells, id)).filter(s => s && s.classes.includes(list));
    const myCantrips = mine.filter(s => s.level === 0);
    const myPrepared = mine.filter(s => s.level > 0);
    let extraCantrips = 0;
    const cc = character.classChoices?.[cls.id] || {};
    if (cc.divineOrder === "thaumaturge" || cc.primalOrder === "magician") extraCantrips = 1;
    const card = h("div", { class: "card" });
    card.appendChild(h("h3", {}, `${cls.name} Spells`));
    card.appendChild(h("p", { class: "meta" }, `${lim.cantrips ? `Cantrips ${myCantrips.length} / ${lim.cantrips + extraCantrips} • ` : ""}Prepared ${myPrepared.length} / ${lim.prepared} • Up to level ${maxLvl}${sc.spellbook ? ` • Spellbook ${spellbook.length}` : ""}`));
    // Subclass spells (Domain / Oath / Patron / Circle ...): always prepared, free of the limit
    const subDef = (cls.subclasses || []).find(x => x.id === subclassSlug(entry.subclassId));
    if (subDef?.landSpells && canEditCore) {
      const terr = h("select", { style: "width:auto; margin:4px 0 8px;" });
      terr.appendChild(h("option", { value: "" }, "Choose your Circle of the Land terrain\u2026"));
      ["arid", "polar", "temperate", "tropical"].forEach(t => terr.appendChild(h("option", { value: t, selected: cc.landTerrain === t ? "selected" : null }, t[0].toUpperCase() + t.slice(1))));
      terr.addEventListener("change", () => patch({ classChoices: { ...(character.classChoices || {}), [cls.id]: { ...cc, landTerrain: terr.value || null } } }));
      card.appendChild(terr);
    }
    const subTable = subDef?.landSpells ? subDef.landSpells[cc.landTerrain] : subDef?.spells;
    const always = Object.entries(subTable || {}).filter(([lvl]) => entry.level >= parseInt(lvl, 10)).flatMap(([, ids]) => ids)
      .map(id => findById(ruleset.spells, id)).filter(Boolean).filter(sp => !prepared.includes(sp.id));
    if (always.length) {
      card.appendChild(h("h4", { class: "spell-level-head" }, `${subDef.name} \u2014 always prepared`));
      always.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name)).forEach(sp => {
        card.appendChild(spellCard(sp, { ability: sc.ability, actions: [btn(sp.level === 0 ? "Cast" : "Cast\u2026", sp.damageDice || sp.attackRoll ? "danger" : "", (b) => castWithSlot(sp, sc.ability, b))], tags: [`<span class="badge">${sp.level === 0 ? "Cantrip" : "L" + sp.level}</span>`, '<span class="badge gold">Always</span>'] }));
      });
    }
    const byLevel = {};
    mine.forEach(s => { (byLevel[s.level] = byLevel[s.level] || []).push(s); });
    Object.keys(byLevel).sort((a, b) => a - b).forEach(lvl => {
      card.appendChild(h("h4", { class: "spell-level-head" }, lvl == 0 ? "Cantrips" : `Level ${lvl}`));
      byLevel[lvl].sort((a, b) => a.name.localeCompare(b.name)).forEach(s => {
        const actions = [btn(s.level === 0 ? "Cast" : "Cast…", s.damageDice || s.attackRoll ? "danger" : "", (b) => castWithSlot(s, sc.ability, b))];
        if (canEditCore) actions.push(btn(s.level === 0 ? "Forget" : "Unprepare", "ghost", () => patch({ spellsPrepared: prepared.filter(id => id !== s.id) })));
        card.appendChild(spellCard(s, { ability: sc.ability, actions }));
      });
    });
    if (!mine.length) card.appendChild(h("p", {}, "No spells yet — add some below."));

    if (sc.spellbook) {
      const bookCard = h("details", { class: "upcoming" });
      bookCard.appendChild(h("summary", {}, `Spellbook (${spellbook.length} spells)`));
      spellbook.map(id => findById(ruleset.spells, id)).filter(Boolean).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name)).forEach(s => {
        const isPrep = prepared.includes(s.id);
        const actions = [];
        if (canEditCore) {
          actions.push(btn(isPrep ? "Unprepare" : "Prepare", isPrep ? "ghost" : "primary", () => {
            if (!isPrep && myPrepared.length >= lim.prepared) { toast(`You can prepare ${lim.prepared} spells`, "error"); return; }
            patch({ spellsPrepared: isPrep ? prepared.filter(id => id !== s.id) : [...prepared, s.id] });
          }));
          actions.push(btn("Erase", "ghost", () => patch({ spellsKnown: { ...(character.spellsKnown || {}), spellbook: spellbook.filter(id => id !== s.id) }, spellsPrepared: prepared.filter(id => id !== s.id) })));
        }
        bookCard.appendChild(spellCard(s, { ability: sc.ability, actions, tags: [`<span class="badge">L${s.level}</span>`, isPrep ? '<span class="badge gold">Prepared</span>' : ""] }));
      });
      card.appendChild(bookCard);
    }

    if (canEditCore) card.appendChild(spellAdder({ cls, sc, lim, maxLvl, myCantrips, myPrepared, extraCantrips, spellbook }));
    wrap.appendChild(card);
  });

  // ---- Species / feat spells ----
  extraSources.forEach(src => {
    const card = h("div", { class: "card" });
    card.appendChild(h("h3", {}, `${src.label} Spells`));
    card.appendChild(h("p", { class: "meta" }, `Spellcasting ability: ${ABILITY_NAMES[src.ability] || src.ability}. Level 1+ spells here can be cast once per Long Rest without a slot.`));
    src.cantrips.map(id => findById(ruleset.spells, id)).filter(Boolean).forEach(s => {
      card.appendChild(spellCard(s, { ability: src.ability, actions: [btn("Cast", s.damageDice ? "danger" : "", (b) => castWithSlot(s, src.ability, b))], tags: ['<span class="badge">Cantrip</span>'] }));
    });
    src.freeSpells.map(id => findById(ruleset.spells, id)).filter(Boolean).forEach(s => {
      const usedFree = character.freeCastsUsed?.[s.id] || 0;
      const actions = [
        btn(usedFree ? "Free cast used" : "Cast (free)", "primary", () => {
          if (usedFree) { toast("Already used — recharges on a Long Rest (or cast with a slot)", "error"); return; }
          patch({ freeCastsUsed: { ...(character.freeCastsUsed || {}), [s.id]: 1 } });
          rollSpell(s, src.ability, s.level);
        }),
        btn("Cast with slot…", "", (b) => castWithSlot(s, src.ability, b))
      ];
      card.appendChild(spellCard(s, { ability: src.ability, actions, tags: [`<span class="badge">L${s.level}</span>`] }));
    });
    wrap.appendChild(card);
  });

  // ---- Spell adder (per casting class) ----
  function spellAdder({ cls, sc, lim, maxLvl, myCantrips, myPrepared, extraCantrips, spellbook }) {
    const box = h("details", { class: "upcoming spell-adder" });
    box.appendChild(h("summary", {}, sc.spellbook ? "Add cantrips / copy spells into your spellbook" : "Add cantrips / prepare spells"));
    const controls = h("div", { class: "field-row wrap", style: "margin-top:8px;" });
    const search = h("input", { type: "search", placeholder: "Search by name or school…", style: "flex:1; min-width:180px; margin-bottom:0;" });
    const levelSel = h("select", { style: "width:auto; margin-bottom:0;" });
    levelSel.appendChild(h("option", { value: "" }, "All levels"));
    for (let l = 0; l <= maxLvl; l++) levelSel.appendChild(h("option", { value: String(l) }, l === 0 ? "Cantrips" : `Level ${l}`));
    controls.appendChild(search); controls.appendChild(levelSel);
    box.appendChild(controls);
    const list = h("div", { class: "spell-pick-list", style: "margin-top:8px;" });
    box.appendChild(list);
    function draw() {
      list.innerHTML = "";
      const q = search.value.trim().toLowerCase();
      const lvlF = levelSel.value === "" ? null : parseInt(levelSel.value, 10);
      const pool = ruleset.spells.filter(s => s.classes.includes(sc.list) && s.level <= maxLvl && (lvlF == null || s.level === lvlF)
        && (!q || s.name.toLowerCase().includes(q) || (s.school || "").toLowerCase().includes(q)));
      pool.slice(0, 150).forEach(s => {
        const inBook = spellbook.includes(s.id);
        const isPrep = prepared.includes(s.id);
        const row = h("div", { class: "spell-pick-row" });
        const top = h("div", { class: "spell-pick-top" });
        let label, disabled = false, action;
        if (s.level === 0) {
          label = isPrep ? "✓" : "+"; disabled = isPrep;
          action = () => {
            if (myCantrips.length >= lim.cantrips + extraCantrips) { toast(`You know ${lim.cantrips + extraCantrips} ${cls.name} cantrips — forget one first`, "error"); return; }
            patch({ spellsPrepared: [...prepared, s.id] });
          };
        } else if (sc.spellbook) {
          label = inBook ? "✓" : "+"; disabled = inBook;
          action = () => patch({ spellsKnown: { ...(character.spellsKnown || {}), spellbook: [...spellbook, s.id] } });
        } else {
          label = isPrep ? "✓" : "+"; disabled = isPrep;
          action = () => {
            if (myPrepared.length >= lim.prepared) { toast(`You can prepare ${lim.prepared} spells — unprepare one first`, "error"); return; }
            patch({ spellsPrepared: [...prepared, s.id] });
          };
        }
        const check = h("button", { type: "button", class: `pick-check ${disabled ? "on" : ""}` }, label);
        check.disabled = disabled;
        check.addEventListener("click", action);
        top.appendChild(check);
        top.appendChild(h("div", { class: "spell-pick-name" }, `<strong>${escapeHtml(s.name)}</strong> <span class="meta">${s.level === 0 ? "Cantrip" : "L" + s.level} • ${s.school || ""}${s.concentration ? " • C" : ""}${s.ritual ? " • R" : ""} • ${escapeHtml(s.castingTime)}</span>`));
        row.appendChild(top);
        const d = h("details", { class: "creator-detail" });
        d.appendChild(h("summary", {}, "Details"));
        d.appendChild(h("div", { class: "creator-detail-body" }, textHtml(s.description)));
        row.appendChild(d);
        list.appendChild(row);
      });
      if (!pool.length) list.appendChild(h("p", { class: "meta" }, "No matching spells."));
    }
    search.addEventListener("input", draw);
    levelSel.addEventListener("change", draw);
    const mem = adderMemory[cls.id] || (adderMemory[cls.id] = { q: "", lvl: "", open: false });
    search.value = mem.q; levelSel.value = mem.lvl;
    search.addEventListener("input", () => { mem.q = search.value; });
    levelSel.addEventListener("change", () => { mem.lvl = levelSel.value; });
    box.addEventListener("toggle", () => { mem.open = box.open; if (box.open && !list.childElementCount) draw(); });
    if (mem.open) { box.open = true; draw(); }
    return box;
  }

  return wrap;
}
