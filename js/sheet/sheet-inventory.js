import { h, toast } from "../util.js";
import { findById } from "../data-loader.js";
import { currencyTotalGp, parseWeightLb, parseCostToGp } from "../rules-engine.js";

export function renderInventoryTab(ctx) {
  const { character, ruleset, inventory, canEditCore, patch, sendToParty, addItem, toggleEquip, changeQty, removeItem, setContainer, doAttack } = ctx;
  const wrap = h("div", {});

  // ---- Currency ----
  const currency = character.currency || { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
  const coinCard = h("div", { class: "card" });
  coinCard.appendChild(h("h3", {}, "Coin Purse"));
  const coinGrid = h("div", { class: "coin-grid" });
  [["cp", "Copper"], ["sp", "Silver"], ["ep", "Electrum"], ["gp", "Gold"], ["pp", "Platinum"]].forEach(([key, label]) => {
    const box = h("div", { class: "coin-box" });
    box.appendChild(h("label", {}, label));
    const input = h("input", { type: "number", min: "0", value: String(currency[key] || 0) });
    input.disabled = !canEditCore;
    input.addEventListener("change", () => patch({ currency: { ...currency, [key]: Math.max(0, parseInt(input.value, 10) || 0) } }));
    box.appendChild(input);
    if (canEditCore && character.campaignId) {
      const sendBtn = h("button", { class: "btn sm ghost block", style: "margin-top:4px; font-size:0.62rem; padding:4px;" }, "\u2192 Party");
      sendBtn.addEventListener("click", () => {
        const amt = currency[key] || 0;
        if (amt <= 0) return;
        ctx.sendCurrencyToParty(key, amt);
      });
      box.appendChild(sendBtn);
    }
    coinGrid.appendChild(box);
  });
  coinCard.appendChild(coinGrid);
  coinCard.appendChild(h("p", {}, `Total value: ${currencyTotalGp(currency).toLocaleString()} GP`));
  wrap.appendChild(coinCard);

  // ---- Weight & value ----
  const strScore = character.abilityScores.str;
  const capacity = strScore * 15;
  let totalWeight = 0, totalValue = 0;
  inventory.forEach(item => {
    const catalogWeight = item.type === "weapon" ? findById(ruleset.equipment.weapons, item.catalogId)?.weight
      : item.type === "armor" ? findById(ruleset.equipment.armor, item.catalogId)?.weight
      : item.weightLb != null ? `${item.weightLb} lb.` : null;
    totalWeight += (item.weightLb ?? parseWeightLb(catalogWeight)) * (item.quantity || 1);
    totalValue += (item.valueGp ?? 0) * (item.quantity || 1);
  });
  const weightCard = h("div", { class: "card" });
  weightCard.appendChild(h("h3", {}, "Carried Weight & Value"));
  const pct = Math.min(100, Math.round((totalWeight / Math.max(1, capacity)) * 100));
  weightCard.innerHTML += `
    <div class="xp-row"><span>${totalWeight.toFixed(1)} lb.</span><span>Capacity ${capacity} lb. (Str \u00d7 15)</span></div>
    <div class="weight-bar-track"><div class="weight-bar-fill ${totalWeight > capacity ? "over" : ""}" style="width:${pct}%"></div></div>
    <p style="margin-top:8px;">Total item value: ${totalValue.toLocaleString()} GP (separate from coin purse)</p>
  `;
  wrap.appendChild(weightCard);

  // ---- Items, grouped by container ----
  const invCard = h("div", { class: "card" });
  invCard.appendChild(h("h3", {}, "Items"));
  const containers = inventory.filter(i => i.isContainer);
  const loose = inventory.filter(i => !i.containerId);

  function renderItemRow(item, indent) {
    const row = h("div", { class: `inventory-item ${item.equipped ? "equipped" : ""}`, style: indent ? "margin-left:20px;" : "" });
    let metaLine = item.type;
    if (item.type === "weapon" && item.weaponData) metaLine = `${item.weaponData.damageDice} ${item.weaponData.damageType}${item.isCustom ? " \u2022 custom" : ""}`;
    else if (item.type === "armor" && item.armorData) metaLine = `${item.armorData.armorType} armor \u2022 AC ${item.armorData.baseAC}`;
    else if (item.type === "ammo") metaLine = `ammo \u2022 ${item.ammoType}`;
    const weight = item.weightLb ?? 0;
    row.innerHTML = `
      <div class="row1">
        <div>
          <div class="item-name">${item.name} ${item.type === "ammo" ? `<span class="ammo-pill ${item.quantity <= 0 ? "empty" : ""}">${item.quantity} left</span>` : ""} ${item.isContainer ? '<span class="badge rune">Container</span>' : ""}</div>
          <div class="item-meta">${metaLine}${weight ? ` \u2022 ${weight} lb.` : ""}</div>
        </div>
      </div>
    `;
    const actions = h("div", { class: "row-actions" });

    const stepper = h("div", { class: "qty-stepper" });
    const minus = h("button", {}, "\u2212");
    const qtyLabel = h("span", {}, String(item.quantity ?? 1));
    const plus = h("button", {}, "+");
    if (canEditCore) { minus.addEventListener("click", () => changeQty(item, -1)); plus.addEventListener("click", () => changeQty(item, 1)); }
    else { minus.disabled = true; plus.disabled = true; }
    stepper.appendChild(minus); stepper.appendChild(qtyLabel); stepper.appendChild(plus);
    actions.appendChild(stepper);

    if ((item.type === "weapon" || item.type === "armor" || item.isContainer) && canEditCore) {
      const equipBtn = h("button", { class: `btn sm ${item.equipped ? "primary" : ""}` }, item.equipped ? "Equipped" : "Equip");
      equipBtn.addEventListener("click", () => toggleEquip(item));
      actions.appendChild(equipBtn);
    }
    if (item.type === "weapon" && item.equipped) {
      const attackBtn = h("button", { class: "btn sm danger" }, "\u2694 Attack");
      attackBtn.addEventListener("click", () => doAttack(item));
      actions.appendChild(attackBtn);
    }
    if (canEditCore) {
      const containerSel = h("select", { style: "width:auto; margin:0; padding:4px 8px; font-size:0.72rem;" });
      containerSel.appendChild(h("option", { value: "" }, "Carried"));
      containers.filter(c => c.id !== item.id).forEach(c => containerSel.appendChild(h("option", { value: c.id, selected: item.containerId === c.id ? "selected" : null }, c.name)));
      containerSel.value = item.containerId || "";
      containerSel.addEventListener("change", () => setContainer(item, containerSel.value || null));
      actions.appendChild(containerSel);
    }
    if (canEditCore && character.campaignId) {
      const sendBtn = h("button", { class: "btn sm ghost" }, "\u2192 Party");
      sendBtn.addEventListener("click", () => sendToParty(item));
      actions.appendChild(sendBtn);
    }
    if (canEditCore) {
      const delBtn = h("button", { class: "btn sm ghost" }, "Remove");
      delBtn.addEventListener("click", () => removeItem(item));
      actions.appendChild(delBtn);
    }
    row.appendChild(actions);
    return row;
  }

  if (inventory.length === 0) invCard.appendChild(h("p", {}, "No items yet \u2014 add some below."));
  loose.forEach(item => {
    invCard.appendChild(renderItemRow(item, false));
    if (item.isContainer) {
      inventory.filter(i => i.containerId === item.id).forEach(nested => invCard.appendChild(renderItemRow(nested, true)));
    }
  });

  if (canEditCore) {
    invCard.appendChild(h("hr", { class: "divider" }));
    invCard.appendChild(buildAddItemForm(ctx));
  }
  wrap.appendChild(invCard);

  return wrap;
}

function buildAddItemForm(ctx) {
  const { ruleset, addItem, toast: toastFn } = ctx;
  const form = h("div", {});
  form.appendChild(h("label", {}, "Add item"));
  const catSelect = h("select", {});
  ["weapon", "armor", "ammo", "gear"].forEach(c => catSelect.appendChild(h("option", { value: c }, c[0].toUpperCase() + c.slice(1))));
  form.appendChild(catSelect);

  const sourceSelect = h("select", {});
  form.appendChild(sourceSelect);
  const customFields = h("div", {});
  form.appendChild(customFields);

  function catalogFor(cat) {
    return ruleset.equipment?.[cat === "weapon" ? "weapons" : cat === "armor" ? "armor" : cat] || [];
  }
  function renderSourceOptions() {
    sourceSelect.innerHTML = "";
    catalogFor(catSelect.value).forEach(entry => sourceSelect.appendChild(h("option", { value: entry.id }, entry.name)));
    sourceSelect.appendChild(h("option", { value: "__custom__" }, "\u2014 Custom item \u2014"));
    renderCustomFields();
  }
  function renderCustomFields() {
    customFields.innerHTML = "";
    if (sourceSelect.value !== "__custom__") return;
    const cat = catSelect.value;
    customFields.appendChild(h("input", { type: "text", placeholder: "Item name", id: "custom-name" }));
    if (cat === "weapon") {
      customFields.appendChild(h("input", { type: "text", placeholder: "Damage dice, e.g. 1d8", id: "custom-dice" }));
      const typeSelect = h("select", { id: "custom-dmgtype" });
      ["slashing", "piercing", "bludgeoning", "fire", "cold", "acid", "poison", "necrotic", "radiant", "force", "lightning", "thunder", "psychic"].forEach(t => typeSelect.appendChild(h("option", { value: t }, t)));
      customFields.appendChild(typeSelect);
      const abilSelect = h("select", { id: "custom-ability" });
      [["str", "Strength"], ["dex", "Dexterity"], ["finesse", "Finesse"]].forEach(([v, l]) => abilSelect.appendChild(h("option", { value: v }, l)));
      customFields.appendChild(abilSelect);
      const rangedRow = h("label", { style: "display:flex; align-items:center; gap:6px; text-transform:none;" });
      rangedRow.appendChild(h("input", { type: "checkbox", id: "custom-ranged", style: "width:auto; margin:0;" }));
      rangedRow.appendChild(document.createTextNode(" Ranged weapon"));
      customFields.appendChild(rangedRow);
    } else if (cat === "armor") {
      customFields.appendChild(h("input", { type: "number", placeholder: "Base AC", id: "custom-ac", value: "11" }));
      const dexSelect = h("select", { id: "custom-dexbonus" });
      [["full", "Full Dex"], ["max2", "Dex (max 2)"], ["none", "No Dex"]].forEach(([v, l]) => dexSelect.appendChild(h("option", { value: v }, l)));
      customFields.appendChild(dexSelect);
    } else if (cat === "ammo") {
      customFields.appendChild(h("input", { type: "text", placeholder: "Ammo type, e.g. arrow", id: "custom-ammotype" }));
    } else if (cat === "gear") {
      const containerRow = h("label", { style: "display:flex; align-items:center; gap:6px; text-transform:none;" });
      containerRow.appendChild(h("input", { type: "checkbox", id: "custom-iscontainer", style: "width:auto; margin:0;" }));
      containerRow.appendChild(document.createTextNode(" This is a container (backpack, pouch, etc.)"));
      customFields.appendChild(containerRow);
    }
    customFields.appendChild(h("input", { type: "number", placeholder: "Weight (lb.)", id: "custom-weight", value: "0", step: "0.1" }));
    customFields.appendChild(h("input", { type: "number", placeholder: "Value (GP)", id: "custom-value", value: "0", step: "0.1" }));
  }
  catSelect.addEventListener("change", renderSourceOptions);
  sourceSelect.addEventListener("change", renderCustomFields);
  renderSourceOptions();

  const qtyRow = h("div", { class: "field-row" });
  const qtyInput = h("input", { type: "number", value: "1", min: "1" });
  const addBtn = h("button", { class: "btn primary" }, "Add to Inventory");
  qtyRow.appendChild(qtyInput); qtyRow.appendChild(addBtn);
  form.appendChild(qtyRow);

  addBtn.addEventListener("click", async () => {
    const cat = catSelect.value;
    const qty = Math.max(1, parseInt(qtyInput.value, 10) || 1);
    const isCustom = sourceSelect.value === "__custom__";
    const customWeight = parseFloat(customFields.querySelector("#custom-weight")?.value) || 0;
    const customValue = parseFloat(customFields.querySelector("#custom-value")?.value) || 0;

    if (cat === "weapon") {
      if (isCustom) {
        const name = customFields.querySelector("#custom-name")?.value.trim();
        if (!name) { toast("Name your custom weapon", "error"); return; }
        await addItem({
          type: "weapon", name, quantity: qty, equipped: false, isCustom: true, weightLb: customWeight, valueGp: customValue,
          weaponData: { damageDice: customFields.querySelector("#custom-dice")?.value.trim() || "1d4", damageType: customFields.querySelector("#custom-dmgtype")?.value || "bludgeoning", ability: customFields.querySelector("#custom-ability")?.value || "str", ranged: customFields.querySelector("#custom-ranged")?.checked || false, ammoType: null, proficient: true, attackBonus: 0, damageBonus: 0 }
        });
      } else {
        const entry = findById(ruleset.equipment.weapons, sourceSelect.value);
        if (!entry) return;
        await addItem({
          type: "weapon", name: entry.name, quantity: qty, equipped: false, isCustom: false, catalogId: entry.id,
          weightLb: parseWeightLb(entry.weight), valueGp: parseCostToGp(entry.cost),
          weaponData: { damageDice: entry.damageDice, damageType: entry.damageType, ability: entry.ability, ranged: entry.ranged, ammoType: entry.ammoType, range: entry.ranged ? undefined : null, properties: entry.properties, proficient: true, attackBonus: 0, damageBonus: 0 }
        });
      }
    } else if (cat === "armor") {
      if (isCustom) {
        const name = customFields.querySelector("#custom-name")?.value.trim();
        if (!name) { toast("Name your custom armor", "error"); return; }
        await addItem({ type: "armor", name, quantity: 1, equipped: false, isCustom: true, weightLb: customWeight, valueGp: customValue, armorData: { armorType: "light", baseAC: parseInt(customFields.querySelector("#custom-ac")?.value, 10) || 11, dexBonus: customFields.querySelector("#custom-dexbonus")?.value || "full", strengthRequirement: null, stealthDisadvantage: false } });
      } else {
        const entry = findById(ruleset.equipment.armor, sourceSelect.value);
        if (!entry) return;
        await addItem({ type: "armor", name: entry.name, quantity: 1, equipped: false, isCustom: false, catalogId: entry.id, weightLb: parseWeightLb(entry.weight), valueGp: parseCostToGp(entry.cost), armorData: { armorType: entry.armorType, baseAC: entry.baseAC, dexBonus: entry.dexBonus, strengthRequirement: entry.strengthRequirement, stealthDisadvantage: entry.stealthDisadvantage } });
      }
    } else if (cat === "ammo") {
      if (isCustom) {
        const name = customFields.querySelector("#custom-name")?.value.trim();
        const ammoType = customFields.querySelector("#custom-ammotype")?.value.trim();
        if (!name || !ammoType) { toast("Name the ammo and its type", "error"); return; }
        await addItem({ type: "ammo", name, quantity: qty, ammoType, isCustom: true, weightLb: customWeight, valueGp: customValue });
      } else {
        const entry = findById(ruleset.equipment.ammo, sourceSelect.value);
        if (!entry) return;
        await addItem({ type: "ammo", name: entry.name, quantity: qty, ammoType: entry.ammoType, isCustom: false, weightLb: parseWeightLb(entry.weight), valueGp: parseCostToGp(entry.cost) });
      }
    } else if (cat === "gear") {
      if (isCustom) {
        const name = customFields.querySelector("#custom-name")?.value.trim();
        if (!name) { toast("Name your custom gear", "error"); return; }
        await addItem({ type: "gear", name, quantity: qty, isCustom: true, weightLb: customWeight, valueGp: customValue, isContainer: customFields.querySelector("#custom-iscontainer")?.checked || false });
      } else {
        const entry = findById(ruleset.equipment.gear, sourceSelect.value);
        if (!entry) return;
        await addItem({ type: "gear", name: entry.name, quantity: qty, isCustom: false, weightLb: parseWeightLb(entry.weight), valueGp: parseCostToGp(entry.cost), isContainer: !!entry.isContainer });
      }
    }
  });

  return form;
}
