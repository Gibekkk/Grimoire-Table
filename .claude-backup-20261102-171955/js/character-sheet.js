import { db } from "./db.js";
import { loadRuleset, findById } from "./data-loader.js";
import { h, toast, escapeHtml, attachRollMenu } from "./util.js";
import {
  ABILITIES, abilityModifier, effectiveAbilityModifier, formatModifier, proficiencyBonus,
  estimateArmorClass, computeMaxHp, initiativeModifier, levelForXp, xpForNextLevel, XP_THRESHOLDS,
  getClassEntries, totalLevel, primaryClassEntry, weaponAttackBonus, weaponDamageBonus,
  maxResourceUses, shortRestRecovery, subclassSlug, entrySpellcasting, skillModifier
} from "./rules-engine.js";
import { openLevelUp } from "./sheet/level-up.js";
import { parseNotation } from "./dice/roll-logic.js";
import { renderCoreTab } from "./sheet/sheet-core.js";
import { renderActionsTab } from "./sheet/sheet-actions.js";
import { renderSpellsTab } from "./sheet/sheet-spells.js";
import { renderFeatsTab } from "./sheet/sheet-feats.js";
import { renderInventoryTab } from "./sheet/sheet-inventory.js";
import { renderDescriptionTab } from "./sheet/sheet-description.js";

// opts: viewerUid, isDm, onRoll(spec), getAdvMode(), readOnly
export async function mountCharacterSheet(container, characterId, opts = {}) {
  const ruleset = await loadRuleset();
  let character = await db.characters.get(characterId);
  if (!character) {
    container.innerHTML = `<div class="empty-state"><h3>Character not found</h3></div>`;
    return () => {};
  }
  let inventory = [];
  let campaignName = null;
  let activeTab = "core";

  const isOwner = character.ownerUid === opts.viewerUid;
  // DMs get full edit access to every character in their campaign (per the
  // table's house rules — roll for players, fix mistakes, adjust on the fly).
  // Deleting a character or leaving/joining a campaign stays owner-only (see
  // the sidebar's kebab menu) so a DM can't remove someone else's character.
  const canEditCore = (isOwner || opts.isDm) && !opts.readOnly;
  const canEditVitals = (isOwner || opts.isDm) && !opts.readOnly;
  const canManageXp = (isOwner || opts.isDm) && !opts.readOnly;


  function patch(partial) {
    Object.assign(character, partial);
    db.characters.update(characterId, partial);
    render();
    // Let the sidebar (name / level list) refresh without a page change
    if ("name" in partial || "level" in partial || "classes" in partial || "campaignId" in partial) {
      window.dispatchEvent(new CustomEvent("gt:characters-changed"));
    }
  }
  function currentAdvMode() { return opts.getAdvMode ? opts.getAdvMode() : "normal"; }
  // Every roll from the sheet goes through here: Exhaustion (2024) subtracts 2 per
  // level from D20 Tests (attacks, checks, saves, initiative).
  function roll(spec) {
    const exh = character.exhaustion || 0;
    if (exh && spec.sides === 20 && (spec.count || 1) === 1) {
      opts.onRoll?.({ ...spec, modifier: (spec.modifier || 0) - 2 * exh, label: `${spec.label} (Exhaustion \u2212${2 * exh})` });
    } else opts.onRoll?.(spec);
  }

  // ---------------- Hit point management (damage / heal / temp, death saves) ----------------
  function applyDamage(amount) {
    if (!(amount > 0)) return;
    const hp = { ...character.hp };
    const fromTemp = Math.min(hp.temp || 0, amount);
    hp.temp = (hp.temp || 0) - fromTemp;
    const rest = amount - fromTemp;
    const wasUp = hp.current > 0;
    const extra = {};
    if (!wasUp && rest > 0) {
      // Damage at 0 HP = a failed death save (massive damage = instant death)
      if (rest >= hp.max) { extra.deathSaves = { successes: 0, failures: 3 }; toast(`${character.name} dies from massive damage.`, "error"); }
      else { const ds = character.deathSaves || { successes: 0, failures: 0 }; extra.deathSaves = { ...ds, failures: Math.min(3, ds.failures + 1) }; }
    }
    if (wasUp && rest >= hp.current + hp.max) { extra.deathSaves = { successes: 0, failures: 3 }; toast(`${character.name} is killed outright (massive damage).`, "error"); }
    hp.current = Math.max(0, hp.current - rest);
    if (wasUp && hp.current === 0 && !extra.deathSaves) { extra.deathSaves = { successes: 0, failures: 0 }; toast(`${character.name} drops to 0 HP and is Unconscious \u2014 roll death saves.`, "error"); }
    patch({ hp, ...extra });
    if (character.concentration && rest > 0 && hp.current > 0) toast(`Concentration check (${character.concentration}): Constitution save DC ${Math.min(30, Math.max(10, Math.floor(rest / 2)))}`);
    if (character.concentration && hp.current === 0) patch({ concentration: null });
  }
  function applyHeal(amount) {
    if (!(amount > 0)) return;
    const hp = { ...character.hp, current: Math.min(character.hp.max, (character.hp.current || 0) + amount) };
    patch({ hp, ...(hp.current > 0 ? { deathSaves: { successes: 0, failures: 0 } } : {}) });
  }
  function applyTemp(amount) {
    if (!(amount >= 0)) return;
    // Temporary HP don't stack: keep the higher value
    patch({ hp: { ...character.hp, temp: Math.max(character.hp.temp || 0, amount) } });
  }
  function rollDeathSave() {
    import("./dice/roll-logic.js").then(({ computeRoll }) => {
      const r = computeRoll({ sides: 20, count: 1, modifier: 0, mode: "normal", label: "Death Saving Throw" });
      const d = r.total;
      const ds = { ...(character.deathSaves || { successes: 0, failures: 0 }) };
      if (d === 20) { patch({ hp: { ...character.hp, current: 1 }, deathSaves: { successes: 0, failures: 0 } }); toast("Natural 20! You regain 1 Hit Point."); }
      else if (d === 1) { ds.failures = Math.min(3, ds.failures + 2); patch({ deathSaves: ds }); toast("Natural 1 \u2014 two failures.", "error"); }
      else if (d >= 10) { ds.successes = Math.min(3, ds.successes + 1); patch({ deathSaves: ds }); toast(`Death save: ${d} \u2014 success${ds.successes === 3 ? " (stable)" : ""}`); }
      else { ds.failures = Math.min(3, ds.failures + 1); patch({ deathSaves: ds }); toast(`Death save: ${d} \u2014 failure${ds.failures === 3 ? " (dead)" : ""}`, "error"); }
      opts.onRoll?.({ sides: 20, count: 1, modifier: 0, label: "Death Saving Throw", mode: "normal" });
    });
  }

  function equippedArmorAndShield() {
    const armorItem = inventory.find(i => i.type === "armor" && i.equipped && i.armorData?.armorType !== "shield");
    const hasShield = inventory.some(i => i.type === "armor" && i.equipped && i.armorData?.armorType === "shield");
    return { armorData: armorItem?.armorData || null, hasShield };
  }

  // ---------------- Inventory helpers (shared with sheet-inventory.js / sheet-actions.js) ----------------
  async function addItem(item, { quiet = false } = {}) { const id = await db.inventory.add(characterId, item); if (!quiet) toast(`${item.name} added`); return id; }
  async function updateItem(item, p) { await db.inventory.update(characterId, item.id, p); }
  async function toggleEquip(item) { await db.inventory.update(characterId, item.id, { equipped: !item.equipped }); }
  async function changeQty(item, delta) { await db.inventory.update(characterId, item.id, { quantity: Math.max(0, (item.quantity || 1) + delta) }); }
  async function removeItem(item) { await db.inventory.remove(characterId, item.id); }
  async function setContainer(item, containerId) { await db.inventory.update(characterId, item.id, { containerId }); }
  async function consumeAmmoFor(weaponItem) {
    const wd = weaponItem.weaponData;
    if (!wd?.ranged || !wd.ammoType || weaponItem.isCustom) return;
    const ammoItem = inventory.find(i => i.type === "ammo" && i.ammoType === wd.ammoType && (i.quantity || 0) > 0);
    if (!ammoItem) { toast(`No ${wd.ammoType}s left!`, "error"); return; }
    await db.inventory.update(characterId, ammoItem.id, { quantity: ammoItem.quantity - 1 });
  }
  function doAttack(item) {
    const wd = item.weaponData;
    const atkBonus = weaponAttackBonus(character, wd, item);
    const dmgBonus = weaponDamageBonus(character, wd, item);
    const parsed = parseNotation(wd.damageDice) || { count: 1, sides: 6, modifier: 0 };
    roll({ sides: 20, count: 1, modifier: atkBonus, label: `${item.name} \u2014 Attack Roll`, mode: currentAdvMode() });
    roll({ sides: parsed.sides, count: parsed.count, modifier: dmgBonus + parsed.modifier, mode: "normal", label: `${item.name} \u2014 Damage (${wd.damageType})` });
    consumeAmmoFor(item);
    opts.onAction?.("action");
  }

  async function sendToParty(item) {
    if (!character.campaignId) return;
    await db.partyInventory.add(character.campaignId, { ...stripId(item), contributedByUid: character.ownerUid, contributedByName: character.name });
    if (item.isContainer) {
      const nested = inventory.filter(i => i.containerId === item.id);
      for (const n of nested) {
        await db.partyInventory.add(character.campaignId, { ...stripId(n), containerId: null, contributedByUid: character.ownerUid, contributedByName: character.name });
        await db.inventory.remove(characterId, n.id);
      }
    }
    await db.inventory.remove(characterId, item.id);
    toast(`${item.name} sent to party inventory`);
  }
  function stripId(item) { const { id, createdAt, ...rest } = item; return rest; }

  async function sendCurrencyToParty(coinKey, amount) {
    if (!character.campaignId) return;
    const campaign = await db.campaigns.get(character.campaignId);
    const partyCurrency = campaign.partyCurrency || { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
    await db.campaigns.update(character.campaignId, { partyCurrency: { ...partyCurrency, [coinKey]: (partyCurrency[coinKey] || 0) + amount } });
    patch({ currency: { ...(character.currency || {}), [coinKey]: 0 } });
    toast(`Sent ${amount} ${coinKey.toUpperCase()} to the party`);
  }

  async function applyXpDelta(delta) {
    const newXp = Math.max(0, (character.xp || 0) + delta);
    const oldTotal = totalLevel(character);
    const newTotal = Math.max(1, levelForXp(newXp));
    patch({ xp: newXp });
    if (newTotal > oldTotal) {
      if (canEditCore) openLevelUp(ctx, newTotal - oldTotal);
      else toast(`${character.name} has enough XP for level ${newTotal}!`);
    } else if (newTotal < oldTotal) {
      const entries = getClassEntries(character);
      const newEntries = entries.map((e, i) => i === 0 ? { ...e, level: Math.max(1, e.level - (oldTotal - newTotal)) } : e);
      onClassesChanged(newEntries);
    }
  }

  // Recomputes max HP (keeping any manual max adjustment) and syncs the legacy
  // `level` field whenever class levels change.
  function applyLevelChange(newEntries, patchData) {
    const before = computeMaxHp(character, ruleset);
    const after = computeMaxHp({ ...character, ...patchData, classes: newEntries }, ruleset);
    const manualDelta = (character.hp?.max ?? before) - before;
    const newMax = Math.max(1, after + manualDelta);
    const gained = newMax - (character.hp?.max ?? before);
    patchData.classes = newEntries;
    patchData.classId = newEntries[0]?.classId || character.classId || null;
    patchData.level = newEntries.reduce((s, e) => s + (e.level || 0), 0) || 1;
    patchData.hp = { ...character.hp, max: newMax, current: Math.max(0, Math.min(newMax, (character.hp?.current ?? before) + Math.max(0, gained))) };
  }

  function setPrimaryLevel(newLevel) {
    const entries = getClassEntries(character);
    const oldPrimary = entries[0]?.level || 1;
    if (newLevel > oldPrimary && canEditCore) { openLevelUp(ctx, newLevel - oldPrimary, { classId: entries[0]?.classId }); return; }
    const newEntries = entries.map((e, i) => i === 0 ? { ...e, level: newLevel } : e);
    onClassesChanged(newEntries);
  }

  // ---------------- Rest ----------------
  // Every limited-use resource a character has: class + subclass features and species traits.
  function allResources() {
    const out = [];
    getClassEntries(character).forEach(entry => {
      const sub = subclassSlug(entry.subclassId);
      ruleset.classFeatures.filter(f => f.classId === entry.classId && f.resource && entry.level >= f.level && (!f.subclassId || f.subclassId === sub))
        .forEach(f => out.push({ id: f.id, name: f.resource.label || f.name, resource: f.resource, level: entry.level }));
    });
    const sp = findById(ruleset.species, character.speciesId);
    (sp?.traits || []).filter(t => t.resource && totalLevel(character) >= (t.unlockLevel || 1))
      .forEach(t => out.push({ id: `species-${sp.id}-${t.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, name: t.name, resource: t.resource, level: totalLevel(character) }));
    return out;
  }

  function doLongRest() {
    const maxHp = character.hp?.max ?? computeMaxHp(character, ruleset);
    const maxDice = totalLevel(character);
    const sp = findById(ruleset.species, character.speciesId);
    patch({
      hp: { ...character.hp, current: maxHp, max: maxHp, temp: 0 },
      // PHB 2024: a Long Rest restores all spent Hit Point Dice
      hitDiceUsed: 0,
      resourcesUsed: {},
      spellSlotsUsed: {},
      pactSlotsUsed: 0,
      freeCastsUsed: {},
      // PHB 2024: a Long Rest removes 1 Exhaustion level
      exhaustion: Math.max(0, (character.exhaustion || 0) - 1),
      deathSaves: { successes: 0, failures: 0 },
      ...(sp?.id === "human" ? { inspiration: true } : {})
    });
    toast(`Long Rest complete \u2014 HP, Hit Dice (${maxDice}), resources and spell slots restored.`);
  }
  function doShortRestFinish() {
    const used = { ...(character.resourcesUsed || {}) };
    allResources().forEach(r => {
      const regain = shortRestRecovery(r.resource, r.level);
      if (!regain || !used[r.id]) return;
      used[r.id] = regain === Infinity ? 0 : Math.max(0, used[r.id] - regain);
    });
    patch({ resourcesUsed: used, pactSlotsUsed: 0 });
    toast("Short Rest complete \u2014 short-rest resources and Pact Magic slots recharged. Spend Hit Dice from the HP panel.");
  }
  function spendHitDie() {
    const cls = findById(ruleset.classes, primaryClassEntry(character)?.classId);
    const maxDice = totalLevel(character);
    const used = character.hitDiceUsed || 0;
    if (used >= maxDice) { toast("No Hit Dice remaining", "error"); return; }
    const conMod = effectiveAbilityModifier(character, "con");
    import("./dice/roll-logic.js").then(({ computeRoll, formatBreakdown }) => {
      const result = computeRoll({ sides: cls?.hitDie || 8, count: 1, modifier: conMod, mode: "normal", label: "Spend Hit Die" });
      const healed = Math.max(0, result.total);
      const maxHp = character.hp?.max ?? computeMaxHp(character, ruleset);
      patch({ hitDiceUsed: used + 1, hp: { ...character.hp, current: Math.min(maxHp, (character.hp.current || 0) + healed) } });
      toast(`Spent a Hit Die: healed ${healed} (${formatBreakdown(result)})`);
    });
  }

  const ctx = {
    get character() { return character; }, ruleset, get inventory() { return inventory; }, characterId,
    isOwner, isDm: !!opts.isDm, canEditCore, canEditVitals, canManageXp,
    patch, onRoll: roll, currentAdvMode, toast,
    setConcentration: (name) => patch({ concentration: name || null }),
    addItem, updateItem, toggleEquip, changeQty, removeItem, consumeAmmoFor, doAttack, setContainer,
    sendToParty, sendCurrencyToParty,
    onClassesChanged, allResources, applyLevelChange, openLevelUp: (n, o) => openLevelUp(ctx, n, o)
  };

  // Central place for "classes/levels changed" so HP and the legacy level field
  // always stay correct, whether triggered by XP, the header's level field, or
  // a manual per-class level edit in the Feats & Traits multiclass panel.
  function onClassesChanged(newEntries, extra = {}) {
    const patchData = { ...extra };
    applyLevelChange(newEntries, patchData);
    patch(patchData);
  }

  const CONDITIONS = ["Blinded", "Charmed", "Deafened", "Frightened", "Grappled", "Incapacitated", "Invisible", "Paralyzed", "Petrified", "Poisoned", "Prone", "Restrained", "Stunned", "Unconscious"];
  function renderConditions() {
    const box = h("div", { class: "conditions-box" });
    const active = character.conditions || [];
    const exh = character.exhaustion || 0;
    const head = h("div", { class: "conditions-head" });
    head.appendChild(h("span", { class: "lbl" }, "Conditions"));
    const chips = h("div", { class: "condition-chips" });
    if (!active.length && !exh && !character.concentration) chips.appendChild(h("span", { class: "meta" }, "None"));
    active.forEach(c => {
      const chip = h("button", { class: "condition-chip", title: canEditVitals ? "Click to remove" : c }, `${c}${canEditVitals ? " \u2715" : ""}`);
      if (canEditVitals) chip.addEventListener("click", () => patch({ conditions: active.filter(x => x !== c) }));
      chips.appendChild(chip);
    });
    if (exh) chips.appendChild(h("span", { class: "condition-chip exh", title: `D20 Tests \u2212${2 * exh}, Speed \u2212${5 * exh} ft.` }, `Exhaustion ${exh}`));
    if (character.concentration) {
      const c = h("button", { class: "condition-chip conc", title: "Click to end Concentration" }, `Concentrating: ${character.concentration}${canEditVitals ? " \u2715" : ""}`);
      if (canEditVitals) c.addEventListener("click", () => patch({ concentration: null }));
      chips.appendChild(c);
    }
    head.appendChild(chips);
    box.appendChild(head);
    if (canEditVitals) {
      const manage = h("details", { class: "conditions-manage" });
      manage.appendChild(h("summary", {}, "Manage conditions"));
      const grid = h("div", { class: "condition-grid" });
      CONDITIONS.forEach(c => {
        const on = active.includes(c);
        const immune = !on && (character.conditionImmunities || []).includes(c);
        const b = h("button", { class: `btn sm ${on ? "primary" : "ghost"}`, title: immune ? `Immune to ${c}` : "" }, c);
        b.disabled = immune;
        // Unconscious also knocks you Prone (and you stay Prone when it ends)
        b.addEventListener("click", () => patch({ conditions: on ? active.filter(x => x !== c) : [...new Set([...active, c, ...(c === "Unconscious" ? ["Prone"] : [])])] }));
        grid.appendChild(b);
      });
      manage.appendChild(grid);
      const exRow = h("div", { class: "field-row wrap", style: "align-items:center; margin-top:8px;" });
      exRow.appendChild(h("span", { class: "lbl" }, "Exhaustion"));
      for (let i = 0; i <= 6; i++) {
        const b = h("button", { class: `btn sm ${exh === i ? "primary" : "ghost"}` }, String(i));
        b.addEventListener("click", () => { patch({ exhaustion: i }); if (i === 6) toast(`${character.name} dies of exhaustion (level 6).`, "error"); });
        exRow.appendChild(b);
      }
      manage.appendChild(exRow);
      box.appendChild(manage);
    }
    return box;
  }

  async function render() {
    // Keep expanded <details> panels and the scroll position across re-renders
    const openKeys = new Set([...container.querySelectorAll("details[open] > summary")].map(el => el.textContent));
    const scroller = container.closest(".main") || document.scrollingElement;
    const scrollTop = scroller?.scrollTop || 0;
    container.innerHTML = "";
    const entries = getClassEntries(character);
    const cls = findById(ruleset.classes, entries[0]?.classId);
    const sp = findById(ruleset.species, character.speciesId);
    const bg = findById(ruleset.backgrounds, character.backgroundId);
    const level = totalLevel(character);
    const pb = proficiencyBonus(level);
    const maxHp = character.hp?.max ?? computeMaxHp(character, ruleset);
    if (character.hp?.current == null || character.hp?.max == null) character.hp = { current: character.hp?.current ?? maxHp, max: maxHp, temp: character.hp?.temp || 0 };
    const { armorData, hasShield } = equippedArmorAndShield();
    const acAdjustments = character.acAdjustments || [];
    const baseAc = estimateArmorClass(character, armorData, hasShield);
    // Magic items count when attuned (if they require it) or equipped otherwise
    const activeMagic = inventory.filter(i => i.magic && (i.magic.attunement ? i.attuned : (i.equipped || i.type === "gear")));
    const magicAcParts = activeMagic.filter(i => i.magic.acBonus && i.type !== "armor")
      .filter(i => !/bracers-of-defense/.test(i.magic.id || "") || (!armorData && !hasShield))
      .map(i => ({ label: i.name, value: i.magic.acBonus }));
    const magicAc = magicAcParts.reduce((s, a) => s + a.value, 0);
    ctx.saveBonus = activeMagic.reduce((s, i) => s + (i.magic.saveBonus || 0), 0);
    const totalAc = baseAc + magicAc + acAdjustments.reduce((s, a) => s + a.value, 0);
    const initMod = initiativeModifier(character, ruleset);

    const shell = h("div", { class: "sheet-shell" });

    // ---- Header ----
    const classLabel = entries.map(e => {
      const c = findById(ruleset.classes, e.classId);
      const sub = (c?.subclasses || []).find(s => (s.id || subclassSlug(s.name)) === subclassSlug(e.subclassId));
      return `${c?.name || e.classId} ${e.level}${e.subclassId ? ` (${sub?.name || e.subclassId})` : ""}`;
    }).join(" / ");
    const header = h("div", { class: "card parchment area-header" });
    const metaBits = [sp?.name, classLabel, bg?.name, character.alignment].filter(Boolean).join(" \u2022 ");
    header.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:14px;">
        <div style="display:flex; gap:14px; align-items:flex-start;">
          <div class="portrait-preview lg" style="flex-shrink:0;">${character.portraitBase64 ? `<img src="${character.portraitBase64}">` : `<span>${escapeHtml((character.name || "?")[0].toUpperCase())}</span>`}</div>
          <div>
            <h2 style="margin-bottom:2px;">${escapeHtml(character.name)} ${character.isNpc ? '<span class="badge rune">NPC</span>' : ""}</h2>
            <div class="meta" style="color:#5c4f33;">Level ${level}${metaBits ? " \u2022 " + metaBits : ""}</div>
            ${campaignName ? `<div class="meta" style="color:#5c4f33; margin-top:4px;">Campaign: ${escapeHtml(campaignName)}</div>` : ""}
          </div>
        </div>
        <div style="display:flex; gap:10px; align-items:center;">
          ${canEditCore && entries.length ? `<label style="margin:0; color:#5c4f33;">Level <input type="number" min="1" max="20" value="${entries[0]?.level || 1}" style="width:56px; display:inline-block; margin:0 0 0 6px;" id="level-input"></label>` : ""}
          ${canEditCore ? `<button class="btn sm" id="insp-btn">${character.inspiration ? "\u2728 Inspired" : "Heroic Inspiration"}</button>` : ""}
        </div>
      </div>
    `;
    shell.appendChild(header);
    header.querySelector("#insp-btn")?.addEventListener("click", () => patch({ inspiration: !character.inspiration }));
    header.querySelector("#level-input")?.addEventListener("change", (e) => {
      setPrimaryLevel(Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 1)));
    });

    // ---- Vitals ----
    const vitals = h("div", { class: "area-vitals" });
    const combatCard = h("div", { class: "card" });
    combatCard.appendChild(h("h3", {}, "Vitals"));
    const strip = h("div", { class: "combat-strip" });
    const acStat = h("div", { class: "combat-stat" }); acStat.innerHTML = `<div class="val">${totalAc}</div><div class="lbl">Armor Class</div>`;
    const initStat = h("div", { class: "combat-stat" }); initStat.innerHTML = `<div class="val">${formatModifier(initMod)}</div><div class="lbl">Initiative</div>`;
    const pbStat = h("div", { class: "combat-stat" }, `<div class="val">+${pb}</div><div class="lbl">Prof. Bonus</div>`);
    strip.appendChild(acStat); strip.appendChild(initStat); strip.appendChild(pbStat);
    combatCard.appendChild(strip);
    attachRollMenu(initStat, { onRoll: (mode) => roll({ sides: 20, count: 1, modifier: initMod, label: "Initiative", mode }) });

    // AC breakdown (click to expand)
    let acOpen = false;
    const acPanel = h("div", { class: "breakdown-panel", style: "display:none;" });
    function renderAcPanel() {
      acPanel.innerHTML = `
        <div class="breakdown-row"><span>${armorData ? armorData.armorType + " armor base" : "Unarmored base"}</span><span class="amt">${armorData ? armorData.baseAC : 10}</span></div>
        <div class="breakdown-row"><span>Dexterity (${armorData ? armorData.dexBonus : "full"})</span><span class="amt">${baseAc - (armorData ? armorData.baseAC : 10) - (hasShield ? 2 : 0)}</span></div>
        ${hasShield ? `<div class="breakdown-row"><span>Shield</span><span class="amt">+2</span></div>` : ""}
      `;
      magicAcParts.forEach(adj => {
        acPanel.innerHTML += `<div class="breakdown-row"><span>${escapeHtml(adj.label)} (magic)</span><span class="amt">+${adj.value}</span></div>`;
      });
      acAdjustments.forEach(adj => {
        acPanel.innerHTML += `<div class="breakdown-row"><span>${escapeHtml(adj.label)}</span><span class="amt">${adj.value >= 0 ? "+" : ""}${adj.value}</span></div>`;
      });
      acPanel.innerHTML += `<div class="breakdown-row total"><span>Total AC</span><span class="amt">${totalAc}</span></div>`;
      if (canEditVitals) {
        const addRow = h("div", { class: "field-row", style: "margin-top:10px;" });
        const labelInput = h("input", { type: "text", placeholder: "Source, e.g. Ring of Protection" });
        const valInput = h("input", { type: "number", placeholder: "+/-", value: "1" });
        const addBtn = h("button", { class: "btn sm" }, "Add");
        addBtn.addEventListener("click", () => {
          if (!labelInput.value.trim()) return;
          patch({ acAdjustments: [...acAdjustments, { id: Date.now(), label: labelInput.value.trim(), value: parseInt(valInput.value, 10) || 0 }] });
        });
        addRow.appendChild(labelInput); addRow.appendChild(valInput); addRow.appendChild(addBtn);
        acPanel.appendChild(addRow);
        if (acAdjustments.length) {
          const list = h("div", { class: "adj-list" });
          acAdjustments.forEach(adj => {
            const row = h("div", { class: "adj-item" });
            row.innerHTML = `<span>${escapeHtml(adj.label)} (${adj.value >= 0 ? "+" : ""}${adj.value})</span>`;
            const rm = h("button", { class: "icon-btn" }, "\u00d7");
            rm.addEventListener("click", () => patch({ acAdjustments: acAdjustments.filter(a => a.id !== adj.id) }));
            row.appendChild(rm);
            list.appendChild(row);
          });
          acPanel.appendChild(list);
        }
      }
    }
    renderAcPanel();
    acStat.addEventListener("click", () => { acOpen = !acOpen; acPanel.style.display = acOpen ? "block" : "none"; });
    combatCard.appendChild(acPanel);

    // HP breakdown + hit dice + rest controls
    // D&D Beyond-style HP box: current / max / temp with a quick amount + Heal / Damage
    const hpBox = h("div", { class: "hp-manager" });
    const hpPct = Math.max(0, Math.min(100, Math.round((character.hp.current / Math.max(1, character.hp.max)) * 100)));
    hpBox.innerHTML = `
      <div class="hp-manager-nums">
        <div><div class="val">${character.hp.current}</div><div class="lbl">Current</div></div>
        <div class="slash">/</div>
        <div><div class="val">${character.hp.max}</div><div class="lbl">Max</div></div>
        <div><div class="val temp">${character.hp.temp || "\u2014"}</div><div class="lbl">Temp</div></div>
      </div>
      <div class="hp-bar"><div class="hp-bar-fill ${hpPct <= 25 ? "low" : hpPct <= 50 ? "mid" : ""}" style="width:${hpPct}%"></div></div>`;
    if (canEditVitals) {
      const row = h("div", { class: "hp-manager-actions" });
      const amt = h("input", { type: "number", min: "0", placeholder: "Amount", class: "hp-amount" });
      const healB = h("button", { class: "btn sm hp-heal" }, "Heal");
      const dmgB = h("button", { class: "btn sm danger" }, "Damage");
      const tmpB = h("button", { class: "btn sm ghost", title: "Set Temporary Hit Points (they don't stack)" }, "Temp");
      const val = () => Math.max(0, parseInt(amt.value, 10) || 0);
      healB.addEventListener("click", () => applyHeal(val()));
      dmgB.addEventListener("click", () => applyDamage(val()));
      tmpB.addEventListener("click", () => applyTemp(val()));
      amt.addEventListener("keydown", (e) => { if (e.key === "Enter") applyDamage(val()); });
      row.appendChild(amt); row.appendChild(healB); row.appendChild(dmgB); row.appendChild(tmpB);
      hpBox.appendChild(row);
    }
    const hpToggle = h("button", { class: "btn sm ghost block", style: "margin-top:6px;" }, "Hit Dice & manual edit");
    hpBox.appendChild(hpToggle);
    combatCard.appendChild(hpBox);

    // Death saves (only while at 0 HP)
    if ((character.hp.current || 0) <= 0) {
      const ds = character.deathSaves || { successes: 0, failures: 0 };
      const dsBox = h("div", { class: "death-saves" });
      const pipRow = (label, n, cls) => `<div class="ds-row"><span>${label}</span>${[0, 1, 2].map(i => `<span class="ds-pip ${cls} ${i < n ? "on" : ""}"></span>`).join("")}</div>`;
      dsBox.innerHTML = `<div class="lbl">${ds.failures >= 3 ? "Dead" : ds.successes >= 3 ? "Stable" : "Death Saving Throws"}</div>${pipRow("Successes", ds.successes, "ok")}${pipRow("Failures", ds.failures, "bad")}`;
      if (canEditVitals && ds.failures < 3 && ds.successes < 3) {
        const b = h("button", { class: "btn sm primary" }, "Roll Death Save");
        b.addEventListener("click", rollDeathSave);
        dsBox.appendChild(b);
      }
      if (canEditVitals) {
        const reset = h("button", { class: "btn sm ghost" }, "Reset");
        reset.addEventListener("click", () => patch({ deathSaves: { successes: 0, failures: 0 } }));
        dsBox.appendChild(reset);
      }
      combatCard.appendChild(dsBox);
    }

    // Conditions, Exhaustion, Concentration
    combatCard.appendChild(renderConditions());
    let hpOpen = false;
    const hpPanel = h("div", { class: "breakdown-panel", style: "display:none;" });
    const conMod = effectiveAbilityModifier(character, "con");
    const maxDice = totalLevel(character);
    const usedDice = character.hitDiceUsed || 0;
    hpPanel.innerHTML = `
      <div class="breakdown-row"><span>Hit Die</span><span class="amt">1d${cls?.hitDie || 8}</span></div>
      <div class="breakdown-row"><span>Constitution modifier / level</span><span class="amt">${formatModifier(conMod)}</span></div>
      <div class="breakdown-row"><span>Hit Dice remaining</span><span class="amt">${maxDice - usedDice} / ${maxDice}</span></div>
    `;
    const hpEditRow = h("div", { class: "hp-block", style: "margin-top:10px;" });
    hpEditRow.innerHTML = `
      <div class="big-stat"><input type="number" id="hp-current" value="${character.hp.current}" ${canEditVitals ? "" : "disabled"}><div class="lbl">Current</div></div>
      <div class="big-stat"><input type="number" id="hp-max" value="${character.hp.max}" ${canEditVitals ? "" : "disabled"}><div class="lbl">Max</div></div>
      <div class="big-stat"><input type="number" id="hp-temp" value="${character.hp.temp || 0}" ${canEditVitals ? "" : "disabled"}><div class="lbl">Temp</div></div>
    `;
    hpPanel.appendChild(hpEditRow);
    if (canEditVitals) {
      const spendBtn = h("button", { class: "btn sm", style: "margin-top:8px;" }, "Spend a Hit Die (heal)");
      spendBtn.addEventListener("click", spendHitDie);
      hpPanel.appendChild(spendBtn);
    }
    combatCard.appendChild(hpPanel);
    hpToggle.addEventListener("click", () => { hpOpen = !hpOpen; hpPanel.style.display = hpOpen ? "block" : "none"; });
    // Speed & senses strip (Exhaustion: −5 ft. speed per level)
    const senses = h("div", { class: "combat-strip", style: "margin-top:10px;" });
    const sp2 = sp;
    const lin = (sp2?.choices || []).filter(c => c.type === "option").map(c => c.options.find(o => o.id === character.speciesChoices?.[c.id])).filter(Boolean);
    const baseSpeed = lin.find(o => o.speed)?.speed || sp2?.speed || 30;
    const speed = Math.max(0, baseSpeed - 5 * (character.exhaustion || 0));
    const dv = lin.find(o => o.darkvision)?.darkvision || sp2?.darkvision || 0;
    const perc = ruleset.skills.find(s => s.id === "perception");
    const pp = perc ? 10 + skillModifier(character, perc, ruleset.skills) : 10;
    senses.innerHTML = `<div class="combat-stat" style="cursor:default;"><div class="val">${speed}<small> ft.</small></div><div class="lbl">Speed</div></div>
      <div class="combat-stat" style="cursor:default;"><div class="val">${pp}</div><div class="lbl">Passive Perception</div></div>
      ${dv ? `<div class="combat-stat" style="cursor:default;"><div class="val">${dv}<small> ft.</small></div><div class="lbl">Darkvision</div></div>` : ""}`;
    combatCard.appendChild(senses);
    if (canEditVitals) {
      hpEditRow.querySelector("#hp-current").addEventListener("change", (e) => patch({ hp: { ...character.hp, current: parseInt(e.target.value, 10) || 0 } }));
      hpEditRow.querySelector("#hp-max").addEventListener("change", (e) => patch({ hp: { ...character.hp, max: parseInt(e.target.value, 10) || 0 } }));
      hpEditRow.querySelector("#hp-temp").addEventListener("change", (e) => patch({ hp: { ...character.hp, temp: parseInt(e.target.value, 10) || 0 } }));
    }

    // Rest buttons
    if (canEditVitals) {
      const restRow = h("div", { class: "field-row", style: "margin-top:14px;" });
      const shortBtn = h("button", { class: "btn sm" }, "Short Rest");
      shortBtn.addEventListener("click", doShortRestFinish);
      const longBtn = h("button", { class: "btn sm primary" }, "Long Rest");
      longBtn.addEventListener("click", doLongRest);
      restRow.appendChild(shortBtn); restRow.appendChild(longBtn);
      combatCard.appendChild(restRow);
    }
    vitals.appendChild(combatCard);

    // XP tracker
    if (canManageXp || true) {
      const xpCard = h("div", { class: "card" });
      xpCard.appendChild(h("h3", {}, "Experience"));
      const xp = character.xp || 0;
      const nextThreshold = xpForNextLevel(level);
      const prevThreshold = XP_THRESHOLDS[level - 1];
      const pct = nextThreshold ? Math.min(100, Math.round(((xp - prevThreshold) / (nextThreshold - prevThreshold)) * 100)) : 100;
      xpCard.innerHTML += `
        <div class="xp-row"><span>${xp.toLocaleString()} XP</span><span>${nextThreshold ? `${nextThreshold.toLocaleString()} XP for Lv${level + 1}` : "Max level"}</span></div>
        <div class="xp-bar-track"><div class="xp-bar-fill" style="width:${pct}%"></div></div>
      `;
      if (canManageXp) {
        const xpControls = h("div", { class: "field-row", style: "align-items:flex-end; margin-top:10px;" });
        const xpInput = h("input", { type: "number", value: "25", style: "margin-bottom:0;" });
        const addBtn = h("button", { class: "btn sm primary" }, "Add XP");
        const subBtn = h("button", { class: "btn sm" }, "Remove XP");
        addBtn.addEventListener("click", () => applyXpDelta(parseInt(xpInput.value, 10) || 0));
        subBtn.addEventListener("click", () => applyXpDelta(-(parseInt(xpInput.value, 10) || 0)));
        xpControls.appendChild(xpInput); xpControls.appendChild(addBtn); xpControls.appendChild(subBtn);
        xpCard.appendChild(xpControls);
        xpCard.appendChild(h("p", { style: "margin-top:6px; font-size:0.72rem;" }, "Reaching the next XP threshold opens the Level Up dialog (choose the class, HP, subclass, ASI or feat)."));
      }
      vitals.appendChild(xpCard);
    }
    shell.appendChild(vitals);

    // ---- Tabs ----
    const tabsHost = h("div", { class: "area-tabs" });
    const tabDefs = [
      { id: "core", label: "Core" },
      { id: "actions", label: "Actions" },
      ...(entries.some(e => entrySpellcasting(e, ruleset.classes)) || character.spellsKnown?.species?.length || (character.feats || []).some(f => f.featId === "magic-initiate") ? [{ id: "spells", label: "Spells" }] : []),
      { id: "feats", label: "Feats & Traits" },
      { id: "inventory", label: "Inventory" },
      { id: "description", label: "Description" }
    ];
    const tabsBar = h("div", { class: "tabs" });
    const tabContent = h("div", {});
    function renderTab() {
      tabContent.innerHTML = "";
      const renderers = { core: renderCoreTab, actions: renderActionsTab, spells: renderSpellsTab, feats: renderFeatsTab, inventory: renderInventoryTab, description: renderDescriptionTab };
      const fn = renderers[activeTab] || renderCoreTab;
      tabContent.appendChild(fn(ctx));
    }
    tabDefs.forEach(t => {
      const btn = h("button", { class: `tab-btn ${activeTab === t.id ? "active" : ""}` }, t.label);
      btn.addEventListener("click", () => { activeTab = t.id; [...tabsBar.children].forEach(b => b.classList.remove("active")); btn.classList.add("active"); renderTab(); });
      tabsBar.appendChild(btn);
    });
    tabsHost.appendChild(tabsBar);
    tabsHost.appendChild(tabContent);
    renderTab();

    shell.appendChild(tabsHost);
    container.appendChild(shell);
    if (openKeys.size) container.querySelectorAll("details > summary").forEach(el => { if (openKeys.has(el.textContent)) el.parentElement.open = true; });
    if (scroller && scrollTop) scroller.scrollTop = scrollTop;
  }

  // Subscriptions start only after ctx/render exist: the demo backend (and a warm
  // Firestore cache) fire their first callback synchronously.
  let ready = false;
  let renderQueued = false;
  // Coalesce bursts of snapshot callbacks (inventory + character + campaign) into one paint
  function scheduleRender() {
    if (!ready || renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }
  const unsubChar = db.characters.subscribe(characterId, (updated) => { if (updated) { character = updated; scheduleRender(); } });
  const unsubInv = db.inventory.subscribe(characterId, (items) => { inventory = items; scheduleRender(); });
  if (character.campaignId) db.campaigns.get(character.campaignId).then(c => { campaignName = c?.name || null; scheduleRender(); });
  ready = true;
  await render();
  return () => { ready = false; unsubChar(); unsubInv(); };
}
