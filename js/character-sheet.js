import { db } from "./db.js";
import { loadRuleset, findById } from "./data-loader.js";
import { h, toast, escapeHtml, attachRollMenu } from "./util.js";
import {
  ABILITIES, abilityModifier, effectiveAbilityModifier, formatModifier, proficiencyBonus,
  estimateArmorClass, maxHitPoints, initiativeModifier, levelForXp, xpForNextLevel, XP_THRESHOLDS,
  getClassEntries, totalLevel, primaryClassEntry, weaponAttackBonus, weaponDamageBonus
} from "./rules-engine.js";
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

  const unsubChar = db.characters.subscribe(characterId, (updated) => { if (updated) { character = updated; render(); } });
  const unsubInv = db.inventory.subscribe(characterId, (items) => { inventory = items; render(); });
  if (character.campaignId) db.campaigns.get(character.campaignId).then(c => { campaignName = c?.name || null; render(); });

  function patch(partial) {
    Object.assign(character, partial);
    db.characters.update(characterId, partial);
    render();
  }
  function currentAdvMode() { return opts.getAdvMode ? opts.getAdvMode() : "normal"; }

  function equippedArmorAndShield() {
    const armorItem = inventory.find(i => i.type === "armor" && i.equipped && i.armorData?.armorType !== "shield");
    const hasShield = inventory.some(i => i.type === "armor" && i.equipped && i.armorData?.armorType === "shield");
    return { armorData: armorItem?.armorData || null, hasShield };
  }

  // ---------------- Inventory helpers (shared with sheet-inventory.js / sheet-actions.js) ----------------
  async function addItem(item) { await db.inventory.add(characterId, item); toast(`${item.name} added`); }
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
    opts.onRoll?.({ sides: 20, count: 1, modifier: atkBonus, label: `${item.name} \u2014 Attack Roll`, mode: currentAdvMode() });
    opts.onRoll?.({ sides: parsed.sides, count: parsed.count, modifier: dmgBonus + parsed.modifier, mode: "normal", label: `${item.name} \u2014 Damage (${wd.damageType})` });
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
    const patchData = { xp: newXp };
    if (newTotal !== oldTotal) {
      const diff = newTotal - oldTotal;
      const entries = getClassEntries(character);
      const newEntries = entries.map((e, i) => i === 0 ? { ...e, level: Math.max(1, e.level + diff) } : e);
      await applyLevelChange(entries[0]?.classId, newEntries, oldTotal, newTotal, patchData);
      if (newTotal > oldTotal) toast(`${character.name} leveled up to ${newTotal}!`);
    }
    patch(patchData);
  }

  // Recomputes HP and syncs the legacy `level` field whenever total level changes,
  // whether triggered by XP or a direct milestone-leveling edit.
  async function applyLevelChange(primaryClassId, newEntries, oldTotal, newTotal, patchData) {
    const cls = findById(ruleset.classes, primaryClassId);
    const oldMax = maxHitPoints({ ...character, level: oldTotal }, cls);
    const newMax = maxHitPoints({ ...character, level: newTotal }, cls);
    const hpGain = Math.max(0, newMax - oldMax);
    patchData.classes = newEntries;
    patchData.level = newEntries[0]?.level || newTotal;
    patchData.hp = { ...character.hp, max: newMax, current: Math.min(newMax, (character.hp?.current || 0) + hpGain) };
  }

  async function setPrimaryLevel(newLevel) {
    const entries = getClassEntries(character);
    const oldTotal = totalLevel(character);
    const otherLevels = entries.slice(1).reduce((s, e) => s + e.level, 0);
    const newTotal = newLevel + otherLevels;
    const newEntries = entries.map((e, i) => i === 0 ? { ...e, level: newLevel } : e);
    const patchData = { xp: Math.max(character.xp || 0, XP_THRESHOLDS[Math.min(19, newTotal - 1)]) };
    await applyLevelChange(entries[0]?.classId, newEntries, oldTotal, newTotal, patchData);
    patch(patchData);
  }

  // ---------------- Rest ----------------
  function doLongRest() {
    const cls = findById(ruleset.classes, primaryClassEntry(character)?.classId);
    const maxHp = character.hp?.max ?? maxHitPoints(character, cls);
    const maxDice = totalLevel(character);
    const hitDiceUsed = character.hitDiceUsed || 0;
    const recovered = Math.max(1, Math.floor(maxDice / 2));
    patch({
      hp: { ...character.hp, current: maxHp, max: maxHp },
      hitDiceUsed: Math.max(0, hitDiceUsed - recovered),
      resourcesUsed: {},
      spellSlotsUsed: {},
      pactSlotsUsed: 0
    });
    toast("Long Rest complete \u2014 HP restored, resources and spell slots recharged.");
  }
  function doShortRestFinish() {
    const cleared = {};
    const entries = getClassEntries(character);
    entries.forEach(entry => {
      ruleset.classFeatures.filter(f => f.classId === entry.classId && f.resource?.recharge === "shortRest").forEach(f => { cleared[f.id] = 0; });
    });
    patch({ resourcesUsed: { ...character.resourcesUsed, ...cleared }, pactSlotsUsed: 0 });
    toast("Short Rest complete \u2014 short-rest resources recharged.");
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
      const maxHp = character.hp?.max ?? maxHitPoints(character, cls);
      patch({ hitDiceUsed: used + 1, hp: { ...character.hp, current: Math.min(maxHp, (character.hp.current || 0) + healed) } });
      toast(`Spent a Hit Die: healed ${healed} (${formatBreakdown(result)})`);
    });
  }

  const ctx = {
    get character() { return character; }, ruleset, get inventory() { return inventory; }, characterId,
    isOwner, isDm: !!opts.isDm, canEditCore, canEditVitals, canManageXp,
    patch, onRoll: (spec) => opts.onRoll?.(spec), currentAdvMode, toast,
    addItem, toggleEquip, changeQty, removeItem, consumeAmmoFor, doAttack, setContainer,
    setItemLock: (item, locked) => db.inventory.update(characterId, item.id, { descriptionLocked: locked }),
    sendToParty, sendCurrencyToParty,
    onClassesChanged
  };

  // Central place for "classes/levels changed" so HP and the legacy level field
  // always stay correct, whether triggered by XP, the header's level field, or
  // a manual per-class level edit in the Feats & Traits multiclass panel.
  async function onClassesChanged(newEntries) {
    const oldTotal = totalLevel(character);
    const newTotal = newEntries.reduce((s, e) => s + (e.level || 0), 0);
    const patchData = {};
    await applyLevelChange(newEntries[0]?.classId, newEntries, oldTotal, newTotal, patchData);
    patch(patchData);
  }

  async function render() {
    container.innerHTML = "";
    const entries = getClassEntries(character);
    const cls = findById(ruleset.classes, entries[0]?.classId);
    const sp = findById(ruleset.species, character.speciesId);
    const bg = findById(ruleset.backgrounds, character.backgroundId);
    const level = totalLevel(character);
    const pb = proficiencyBonus(level);
    const maxHp = character.hp?.max ?? maxHitPoints(character, cls);
    if (character.hp?.current == null) character.hp = { current: maxHp, max: maxHp, temp: 0 };
    const { armorData, hasShield } = equippedArmorAndShield();
    const acAdjustments = character.acAdjustments || [];
    const baseAc = estimateArmorClass(character, armorData, hasShield);
    const totalAc = baseAc + acAdjustments.reduce((s, a) => s + a.value, 0);
    const initMod = initiativeModifier(character);

    const shell = h("div", { class: "sheet-shell" });

    // ---- Header ----
    const classLabel = entries.map(e => {
      const c = findById(ruleset.classes, e.classId);
      return `${c?.name || e.classId} ${e.level}${e.subclassId ? ` (${e.subclassId})` : ""}`;
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
    attachRollMenu(initStat, { onRoll: (mode) => opts.onRoll?.({ sides: 20, count: 1, modifier: initMod, label: "Initiative", mode }) });

    // AC breakdown (click to expand)
    let acOpen = false;
    const acPanel = h("div", { class: "breakdown-panel", style: "display:none;" });
    function renderAcPanel() {
      acPanel.innerHTML = `
        <div class="breakdown-row"><span>${armorData ? armorData.armorType + " armor base" : "Unarmored base"}</span><span class="amt">${armorData ? armorData.baseAC : 10}</span></div>
        <div class="breakdown-row"><span>Dexterity (${armorData ? armorData.dexBonus : "full"})</span><span class="amt">${baseAc - (armorData ? armorData.baseAC : 10) - (hasShield ? 2 : 0)}</span></div>
        ${hasShield ? `<div class="breakdown-row"><span>Shield</span><span class="amt">+2</span></div>` : ""}
      `;
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
    const hpToggle = h("div", { class: "combat-stat breakdown-toggle", style: "margin-top:10px; cursor:pointer;" });
    hpToggle.innerHTML = `<div class="val" style="color:var(--blood-bright);">${character.hp.current} / ${character.hp.max}${character.hp.temp ? ` (+${character.hp.temp})` : ""}</div><div class="lbl">Hit Points \u2014 click for details</div>`;
    combatCard.appendChild(hpToggle);
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
        xpCard.appendChild(h("p", { style: "margin-top:6px; font-size:0.72rem;" }, "Auto-leveling tracks your first class. Multiclass levels are set manually in Feats & Traits."));
      }
      vitals.appendChild(xpCard);
    }
    shell.appendChild(vitals);

    // ---- Tabs ----
    const tabsHost = h("div", { class: "area-tabs" });
    const tabDefs = [
      { id: "core", label: "Core" },
      { id: "actions", label: "Actions" },
      ...(entries.some(e => findById(ruleset.classes, e.classId)?.spellcasting) ? [{ id: "spells", label: "Spells" }] : []),
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
  }

  await render();
  return () => { unsubChar(); unsubInv(); };
}
