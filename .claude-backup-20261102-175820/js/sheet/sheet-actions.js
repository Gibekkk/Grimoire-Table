import { h, escapeHtml } from "../util.js";
import { findById } from "../data-loader.js";
import {
  getClassEntries, totalLevel, unarmedStrikeWeapon, weaponRangeLabel, subclassSlug,
  weaponAttackBonus, weaponDamageBonus, maxResourceUses, formatModifier,
  entrySpellcasting, spellAttackBonus, spellSaveDc
} from "../rules-engine.js";
import { scaledDamage } from "./sheet-spells.js";

// Basic actions everyone has (PHB 2024 "Actions" + Opportunity Attack / two-weapon).
const BASIC_ACTIONS = [
  ["action", "Attack", "Make one attack with a weapon or an Unarmed Strike (more with Extra Attack)."],
  ["action", "Dash", "For the rest of the turn, gain extra movement equal to your Speed."],
  ["action", "Disengage", "Your movement doesn't provoke Opportunity Attacks for the rest of the turn."],
  ["action", "Dodge", "Until your next turn, attacks against you have Disadvantage and you have Advantage on Dexterity saves (lost if Incapacitated or Speed 0)."],
  ["action", "Help", "Help an ally's ability check, or distract an enemy within 5 ft. so the next attack roll against it by someone else has Advantage."],
  ["action", "Hide", "Make a DC 15 Dexterity (Stealth) check while Heavily Obscured or behind cover to gain the Invisible condition."],
  ["action", "Influence", "Make a Charisma (or Wisdom for animals) check to alter a creature's attitude."],
  ["action", "Magic", "Cast a spell, use a magic item, or use a magical feature."],
  ["action", "Ready", "Prepare an action (or spell) to take as a Reaction to a trigger you define."],
  ["action", "Search", "Make a Wisdom check (Insight, Medicine, Perception or Survival)."],
  ["action", "Study", "Make an Intelligence check (Arcana, History, Investigation, Nature or Religion)."],
  ["action", "Utilize", "Use a nonmagical object."],
  ["bonus", "Two-Weapon Fighting", "After attacking with a Light weapon, make one extra attack with a different Light weapon (no ability modifier to damage unless it's negative)."],
  ["reaction", "Opportunity Attack", "When a creature you can see leaves your reach, make one melee attack against it."]
];

// Which part of the turn a feature uses, read from its rules text.
function actionTypeOf(text) {
  const t = text || "";
  if (/\b(as|take) a Bonus Action\b|\bBonus Action\b(?! that)/.test(t) && !/no action required/i.test(t.slice(0, 200))) return "bonus";
  if (/\b(take|use) (a|your) Reaction\b|\bas a Reaction\b/.test(t)) return "reaction";
  if (/\bas a Magic action\b|\b(take|as) an? (Magic |Utilize )?action\b|\btake the (Attack|Magic) action\b/i.test(t)) return "action";
  return null;
}

const FILTERS = [["all", "All"], ["attack", "Attack"], ["action", "Action"], ["bonus", "Bonus Action"], ["reaction", "Reaction"], ["limited", "Limited Use"]];
let activeFilter = "all";

export function renderActionsTab(ctx) {
  const { character, ruleset, inventory, doAttack } = ctx;
  const wrap = h("div", {});
  const level = totalLevel(character);
  const entries = getClassEntries(character);

  const chips = h("div", { class: "action-filters" });
  FILTERS.forEach(([id, label]) => {
    const b = h("button", { class: `chip-btn ${activeFilter === id ? "active" : ""}` }, label);
    b.addEventListener("click", () => { activeFilter = id; const host = wrap.parentElement; if (host) { host.innerHTML = ""; host.appendChild(renderActionsTab(ctx)); } });
    chips.appendChild(b);
  });
  wrap.appendChild(chips);
  const show = (type) => activeFilter === "all" || activeFilter === type;

  // ---- Attacks (weapons, unarmed, damaging/attack spells) ----
  if (show("attack") || show("action")) {
    const card = h("div", { class: "card" });
    card.appendChild(h("h3", {}, "Attacks"));
    const table = h("div", { class: "attack-table" });
    table.appendChild(h("div", { class: "attack-row head" }, "<span>Attack</span><span>Range</span><span>Hit / DC</span><span>Damage</span><span></span>"));
    const addRow = (name, sub, range, hit, damage, onClick, mastery) => {
      const row = h("div", { class: "attack-row" });
      row.innerHTML = `<span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(sub || "")}${mastery ? ` • Mastery: ${escapeHtml(mastery)}` : ""}</small></span><span>${escapeHtml(range)}</span><span class="hit">${hit}</span><span>${escapeHtml(damage)}</span>`;
      const b = h("button", { class: "btn sm danger" }, "Roll");
      b.addEventListener("click", onClick);
      row.appendChild(b);
      table.appendChild(row);
    };
    const weaponLine = (item, wd) => {
      const atk = weaponAttackBonus(character, wd, item);
      const dmg = weaponDamageBonus(character, wd, item);
      const catalog = item.catalogId ? ruleset.equipment.weapons.find(w => w.id === item.catalogId) : null;
      const mastery = catalog && (character.weaponMasteries || []).includes(catalog.id) ? catalog.mastery : null;
      // Unarmed Strike (and Blowgun) deal a flat 1 + modifier, stored as 1d1
      const dmgText = wd.damageDice === "1d1" ? `${Math.max(1, 1 + dmg)}` : `${wd.damageDice}${dmg ? (dmg > 0 ? "+" : "") + dmg : ""}`;
      addRow(item.name, wd.ranged ? "Ranged Weapon" : "Melee Weapon", weaponRangeLabel(wd), formatModifier(atk), `${dmgText} ${wd.damageType}`, () => doAttack(item), mastery);
    };
    inventory.filter(i => i.type === "weapon" && i.equipped && i.weaponData).forEach(i => weaponLine(i, i.weaponData));
    const unarmed = unarmedStrikeWeapon(character, ruleset.classes);
    weaponLine({ name: "Unarmed Strike", weaponData: unarmed, isCustom: false }, unarmed);

    // Spells that attack or deal damage (prepared, cantrips, subclass and species spells)
    const known = new Set(character.spellsPrepared || []);
    (character.spellsKnown?.species || []).forEach(id => known.add(id));
    (character.feats || []).filter(f => f.featId === "magic-initiate").forEach(f => { (f.choices?.cantrips || []).forEach(id => known.add(id)); if (f.choices?.spell) known.add(f.choices.spell); });
    const casters = entries.map(e => ({ e, sc: entrySpellcasting(e, ruleset.classes), cls: findById(ruleset.classes, e.classId) })).filter(x => x.sc);
    casters.forEach(({ e, cls }) => {
      const sub = (cls.subclasses || []).find(x => x.id === subclassSlug(e.subclassId));
      const table2 = sub?.landSpells ? sub.landSpells[character.classChoices?.[cls.id]?.landTerrain] : sub?.spells;
      Object.entries(table2 || {}).forEach(([lvl, ids]) => { if (e.level >= parseInt(lvl, 10)) ids.forEach(id => known.add(id)); });
    });
    const ability = casters[0]?.sc.ability || character.speciesChoices?.spellAbility || "cha";
    [...known].map(id => findById(ruleset.spells, id)).filter(s => s && (s.attackRoll || s.damageDice))
      .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))
      .forEach(s => {
        const dmg = scaledDamage(s, s.level, level);
        const hit = s.attackRoll ? formatModifier(spellAttackBonus(character, ability)) : s.save ? `DC ${spellSaveDc(character, ability)} ${s.save.toUpperCase()}` : "—";
        addRow(s.name, s.level === 0 ? "Cantrip" : `Level ${s.level} spell`, s.range, hit, dmg ? `${dmg.count}d${dmg.sides}${dmg.modifier ? "+" + dmg.modifier : ""} ${s.damageType || ""}` : "—", () => {
          if (s.attackRoll) ctx.onRoll({ sides: 20, count: 1, modifier: spellAttackBonus(character, ability), label: `${s.name} — Spell Attack`, mode: ctx.currentAdvMode() });
          if (dmg) ctx.onRoll({ sides: dmg.sides, count: dmg.count, modifier: dmg.modifier, mode: "normal", label: `${s.name} — ${s.damageType || ""} damage` });
          if (s.concentration) ctx.setConcentration?.(s.name);
        });
      });
    card.appendChild(table);
    if (activeFilter === "all" || activeFilter === "attack") wrap.appendChild(card);
  }

  // ---- Features by action type, with their limited uses ----
  const resources = new Map(ctx.allResources().map(r => [r.id, r]));
  const featureItems = [];
  entries.forEach(entry => {
    const sub = subclassSlug(entry.subclassId);
    ruleset.classFeatures.filter(f => f.classId === entry.classId && entry.level >= f.level && (!f.subclassId || f.subclassId === sub))
      .forEach(f => featureItems.push({ id: f.id, name: f.name, text: f.description, source: findById(ruleset.classes, entry.classId)?.name }));
  });
  const sp = findById(ruleset.species, character.speciesId);
  (sp?.traits || []).filter(t => level >= (t.unlockLevel || 1)).forEach(t => featureItems.push({ id: `species-${sp.id}-${t.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, name: t.name, text: t.description, source: sp.name }));
  (character.feats || []).forEach(rec => { const f = findById(ruleset.feats, rec.featId); if (f) featureItems.push({ id: `feat-${f.id}`, name: f.name, text: f.description, source: "Feat" }); });
  (character.classChoices?.warlock?.invocations || []).forEach(id => { const inv = ruleset.classOptions?.invocations?.find(i => i.id === id); if (inv) featureItems.push({ id: `inv-${id}`, name: inv.name, text: inv.description, source: "Invocation" }); });

  const groups = { action: [], bonus: [], reaction: [], other: [] };
  featureItems.forEach(f => {
    const type = actionTypeOf(f.text);
    const res = resources.get(f.id);
    if (type) groups[type].push({ ...f, res });
    else if (res) groups.other.push({ ...f, res });
  });
  BASIC_ACTIONS.forEach(([type, name, text]) => groups[type].push({ id: `basic-${name}`, name, text, source: "Basic", basic: true }));

  const resourceControl = (r) => {
    const max = maxResourceUses(r.resource, character, r.level);
    if (!max) return null;
    const used = Math.min(max, character.resourcesUsed?.[r.id] || 0);
    const box = h("div", { class: "pips" });
    const setUsed = (n) => ctx.patch({ resourcesUsed: { ...character.resourcesUsed, [r.id]: Math.max(0, Math.min(max, n)) } });
    if (max > 12 || r.resource.pool) {
      box.className = "qty-stepper";
      const minus = h("button", { class: "icon-btn", title: "Spend 1" }, "−");
      const val = h("span", { class: "qty-val" }, `${max - used}/${max}`);
      const plus = h("button", { class: "icon-btn", title: "Regain 1" }, "+");
      minus.disabled = plus.disabled = !ctx.canEditVitals;
      minus.addEventListener("click", () => setUsed(used + 1));
      plus.addEventListener("click", () => setUsed(used - 1));
      box.appendChild(minus); box.appendChild(val); box.appendChild(plus);
    } else {
      for (let i = 0; i < max; i++) {
        const pip = h("button", { class: `pip ${i < max - used ? "filled" : ""}`, title: i < max - used ? "Use" : "Regain" });
        pip.disabled = !ctx.canEditVitals;
        pip.addEventListener("click", () => setUsed(i < max - used ? used + 1 : used - 1));
        box.appendChild(pip);
      }
    }
    const recharge = r.resource.recharge === "shortRest" || (r.resource.shortRestFromLevel && r.level >= r.resource.shortRestFromLevel) ? "Short Rest" : "Long Rest";
    const wrapEl = h("div", { class: "feature-uses" });
    wrapEl.appendChild(box);
    wrapEl.appendChild(h("small", {}, `${r.resource.label || "Uses"} • ${recharge}`));
    return wrapEl;
  };

  const section = (type, title) => {
    const list = groups[type].filter(f => activeFilter !== "limited" || f.res);
    if (!list.length) return;
    if (!(activeFilter === "all" || activeFilter === type || (activeFilter === "limited"))) return;
    const card = h("div", { class: "card" });
    card.appendChild(h("h3", {}, title));
    const basics = list.filter(f => f.basic);
    list.filter(f => !f.basic).forEach(f => {
      const d = h("details", { class: "lore-card feature" });
      d.appendChild(h("summary", { class: "lore-title" }, `<span>${escapeHtml(f.name)}</span><span class="badge">${escapeHtml(f.source || "")}</span>`));
      if (f.res) { const ctl = resourceControl(f.res); if (ctl) d.appendChild(ctl); }
      d.appendChild(h("div", { class: "lore-desc" }, escapeHtml(f.text || "").replace(/\n/g, "<br>")));
      card.appendChild(d);
    });
    if (basics.length && activeFilter !== "limited") {
      const line = h("div", { class: "basic-actions" });
      basics.forEach(b => line.appendChild(h("span", { class: "basic-action", title: b.text }, escapeHtml(b.name))));
      card.appendChild(line);
    }
    wrap.appendChild(card);
  };
  section("action", "Actions");
  section("bonus", "Bonus Actions");
  section("reaction", "Reactions");
  section("other", "Other Limited-Use Features");
  // Resources not tied to a listed feature (e.g. pools named differently)
  if (activeFilter === "all" || activeFilter === "limited") {
    const shown = new Set(Object.values(groups).flat().map(f => f.id));
    const rest = [...resources.values()].filter(r => !shown.has(r.id));
    if (rest.length) {
      const card = h("div", { class: "card" });
      card.appendChild(h("h3", {}, "Limited-Use Resources"));
      rest.forEach(r => { const row = h("div", { class: "pip-row" }); row.appendChild(h("div", { class: "pip-label" }, escapeHtml(r.name))); const c = resourceControl(r); if (c) row.appendChild(c); card.appendChild(row); });
      wrap.appendChild(card);
    }
  }
  return wrap;
}
