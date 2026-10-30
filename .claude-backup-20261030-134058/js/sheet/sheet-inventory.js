import { h, toast, escapeHtml } from "../util.js";
import { findById } from "../data-loader.js";
import { currencyTotalGp, parseWeightLb, parseCostToGp, spendCoins } from "../rules-engine.js";

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
    const mg = item.magic;
    row.innerHTML = `
      <div class="row1">
        <div>
          <div class="item-name">${escapeHtml(item.name)} ${item.type === "ammo" ? `<span class="ammo-pill ${item.quantity <= 0 ? "empty" : ""}">${item.quantity} left</span>` : ""} ${item.isContainer ? '<span class="badge rune">Container</span>' : ""}${mg ? ` <span class="badge rarity-${(mg.rarity || "").toLowerCase().replace(/\s+/g, "-")}">${escapeHtml(mg.rarity || "Magic")}</span>` : ""}${mg?.attunement ? ` <span class="badge ${item.attuned ? "gold" : ""}">${item.attuned ? "Attuned" : "Requires Attunement"}</span>` : ""}</div>
          <div class="item-meta">${metaLine}${weight ? ` \u2022 ${weight} lb.` : ""}</div>
        </div>
      </div>
    `;
    if (mg?.description) {
      const d = h("details", { class: "creator-detail" });
      d.appendChild(h("summary", {}, "Item details"));
      d.appendChild(h("div", { class: "creator-detail-body" }, escapeHtml(mg.description).replace(/\n/g, "<br>")));
      row.appendChild(d);
    }
    const actions = h("div", { class: "row-actions" });

    const stepper = h("div", { class: "qty-stepper" });
    const minus = h("button", {}, "\u2212");
    const qtyLabel = h("span", {}, String(item.quantity ?? 1));
    const plus = h("button", {}, "+");
    if (canEditCore) { minus.addEventListener("click", () => changeQty(item, -1)); plus.addEventListener("click", () => changeQty(item, 1)); }
    else { minus.disabled = true; plus.disabled = true; }
    stepper.appendChild(minus); stepper.appendChild(qtyLabel); stepper.appendChild(plus);
    actions.appendChild(stepper);

    if (mg?.attunement && canEditCore) {
      const attB = h("button", { class: `btn sm ${item.attuned ? "primary" : "ghost"}`, title: "You can be attuned to at most 3 magic items" }, item.attuned ? "Attuned" : "Attune");
      attB.addEventListener("click", () => {
        if (!item.attuned && inventory.filter(i => i.attuned).length >= 3) { toast("You're already attuned to 3 items \u2014 end one attunement first", "error"); return; }
        ctx.updateItem(item, { attuned: !item.attuned });
      });
      actions.appendChild(attB);
    }
    if (mg?.maxCharges && canEditCore) {
      const ch = h("div", { class: "qty-stepper", title: "Charges" });
      const left = item.charges ?? mg.maxCharges;
      const m2 = h("button", {}, "\u2212"), v = h("span", {}, `${left}/${mg.maxCharges} ch`), p2 = h("button", {}, "+");
      m2.addEventListener("click", () => ctx.updateItem(item, { charges: Math.max(0, left - 1) }));
      p2.addEventListener("click", () => ctx.updateItem(item, { charges: Math.min(mg.maxCharges, left + 1) }));
      ch.appendChild(m2); ch.appendChild(v); ch.appendChild(p2);
      actions.appendChild(ch);
    }
    if (mg?.healDice && canEditCore) {
      const drink = h("button", { class: "btn sm hp-heal" }, "Drink");
      drink.addEventListener("click", () => {
        import("../dice/roll-logic.js").then(({ computeRoll, parseNotation, formatBreakdown }) => {
          const n = parseNotation(mg.healDice);
          const r = computeRoll({ sides: n.sides, count: n.count, modifier: n.modifier, mode: "normal", label: item.name });
          const hp = ctx.character.hp;
          ctx.patch({ hp: { ...hp, current: Math.min(hp.max, (hp.current || 0) + r.total) }, deathSaves: { successes: 0, failures: 0 } });
          changeQty(item, -1);
          toast(`${item.name}: healed ${r.total} ${formatBreakdown(r)}`);
        });
      });
      actions.appendChild(drink);
    }
    if ((item.type === "weapon" || item.type === "armor" || item.isContainer || (mg && item.type === "gear")) && canEditCore) {
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

// ---------------- Add / buy items ----------------
// Mirrors D&D Beyond's equipment shop: pick a category, search, add for free or
// buy it (coins are deducted with change), packs arrive as a backpack with their
// contents, magic weapons/armor are built on a base item you choose.
const CATS = [["gear", "Gear & Tools"], ["weapon", "Weapons"], ["armor", "Armor"], ["ammo", "Ammunition"], ["magic", "Magic Items"], ["custom", "Custom Item"]];
const formMemory = { cat: "gear", q: "" };

function weaponProficient(character, w) {
  const wt = character.weaponTraining || ["simple"];
  return wt.includes(w.category) || (wt.includes("martial-light") && w.properties.some(p => /^Light/.test(p))) || (wt.includes("martial-finesse-light") && w.properties.some(p => /^(Finesse|Light)/.test(p)));
}
function weaponItem(character, e, extra = {}) {
  return {
    type: "weapon", name: e.name, quantity: 1, equipped: false, isCustom: false, catalogId: e.id,
    weightLb: parseWeightLb(e.weight), valueGp: parseCostToGp(e.cost),
    weaponData: { damageDice: e.damageDice, damageType: e.damageType, ability: e.ability, ranged: e.ranged, ammoType: e.ammoType, properties: e.properties, mastery: e.mastery, proficient: weaponProficient(character, e), attackBonus: 0, damageBonus: 0 },
    ...extra
  };
}
function armorItem(e, extra = {}) {
  return {
    type: "armor", name: e.name, quantity: 1, equipped: false, isCustom: false, catalogId: e.id,
    weightLb: parseWeightLb(e.weight), valueGp: parseCostToGp(e.cost),
    armorData: { armorType: e.armorType, baseAC: e.baseAC, dexBonus: e.dexBonus, strengthRequirement: e.strengthRequirement, stealthDisadvantage: e.stealthDisadvantage },
    ...extra
  };
}
// Base items a magic weapon/armor entry allows ("Any Melee Weapon", "Longsword", "Any Medium or Heavy, Except Hide Armor", ...)
function baseOptions(ruleset, magic) {
  const sub = (magic.subtype || "").toLowerCase();
  if (magic.type === "Weapon") {
    const all = ruleset.equipment.weapons;
    if (!sub || /any (simple or martial|weapon)/.test(sub)) return all;
    if (/any melee/.test(sub)) return all.filter(w => !w.ranged);
    if (/any ranged/.test(sub)) return all.filter(w => w.ranged);
    if (/any sword/.test(sub)) return all.filter(w => /sword|scimitar|rapier/i.test(w.name));
    if (/ammunition/.test(sub)) return [];
    const named = all.filter(w => sub.includes(w.name.toLowerCase()));
    return named.length ? named : all;
  }
  if (magic.type === "Armor") {
    const all = ruleset.equipment.armor;
    let list = all;
    if (/shield/.test(sub)) return all.filter(a => a.armorType === "shield");
    const types = ["light", "medium", "heavy"].filter(t => sub.includes(t));
    if (types.length) list = all.filter(a => types.includes(a.armorType));
    else if (sub && !/^any/.test(sub)) { const named = all.filter(a => sub.includes(a.name.toLowerCase().replace(" armor", ""))); if (named.length) list = named; }
    if (/except hide/.test(sub)) list = list.filter(a => a.id !== "hide-armor");
    if (!/shield/.test(sub)) list = list.filter(a => a.armorType !== "shield");
    return list;
  }
  return [];
}

function buildAddItemForm(ctx) {
  const { ruleset, character, addItem } = ctx;
  const form = h("div", { class: "add-item-form" });
  form.appendChild(h("label", {}, "Add or buy items"));
  const catRow = h("div", { class: "action-filters" });
  const body = h("div", {});
  form.appendChild(catRow); form.appendChild(body);
  function renderCats() {
    catRow.innerHTML = "";
    CATS.forEach(([id, label]) => {
      const b = h("button", { class: `chip-btn ${formMemory.cat === id ? "active" : ""}`, type: "button" }, label);
      b.addEventListener("click", () => { formMemory.cat = id; formMemory.q = ""; renderCats(); renderBody(); });
      catRow.appendChild(b);
    });
  }
  function catalog() {
    const eq = ruleset.equipment;
    switch (formMemory.cat) {
      case "weapon": return eq.weapons.map(e => ({ e, label: e.name, meta: `${e.damageDice} ${e.damageType} • ${e.cost}` }));
      case "armor": return eq.armor.map(e => ({ e, label: e.name, meta: `AC ${e.armorType === "shield" ? "+2" : e.baseAC} • ${e.cost}` }));
      case "ammo": return eq.ammo.map(e => ({ e, label: e.name, meta: e.cost }));
      case "gear": return eq.gear.filter(g => !g.alias).map(e => ({ e, label: e.name, meta: `${e.kind === "pack" ? "Pack • " : e.kind === "tool" ? "Tool • " : ""}${e.cost}` }));
      case "magic": return (ruleset.magicItems || []).map(e => ({ e, label: e.name, meta: `${e.type}${e.subtype ? ` (${e.subtype})` : ""} • ${e.rarity}${e.attunement ? " • Attunement" : ""}` }));
      default: return [];
    }
  }
  async function grant(entry, qty, buy) {
    const cat = formMemory.cat;
    const cost = cat === "magic" ? 0 : parseCostToGp(entry.cost) * qty;
    if (buy && cost > 0) {
      const purse = spendCoins(character.currency, cost);
      if (!purse) { toast(`Not enough coin — costs ${entry.cost}${qty > 1 ? ` × ${qty}` : ""}`, "error"); return false; }
      ctx.patch({ currency: purse });
    }
    if (cat === "weapon") await addItem({ ...weaponItem(character, entry), quantity: qty });
    else if (cat === "armor") await addItem({ ...armorItem(entry), quantity: qty });
    else if (cat === "ammo") await addItem({ type: "ammo", name: entry.name.replace(/\s*\(\d+\)/, ""), quantity: entry.quantity * qty, ammoType: entry.ammoType, isCustom: false, catalogId: entry.id, weightLb: parseWeightLb(entry.weight) / entry.quantity, valueGp: parseCostToGp(entry.cost) / entry.quantity });
    else if (cat === "gear" && entry.kind === "pack") {
      const contents = (entry.contents || []).map(c => ({ c, ce: findById(ruleset.equipment.gear, c.catalogId) })).filter(x => x.ce);
      const holder = contents.find(x => x.ce.isContainer);
      for (let n = 0; n < qty; n++) {
        const containerId = await addItem({ type: "gear", name: holder ? `${holder.ce.name} (${entry.name})` : entry.name, quantity: 1, isCustom: false, catalogId: holder?.ce.id || entry.id, isContainer: true, weightLb: holder ? parseWeightLb(holder.ce.weight) : 0, valueGp: parseCostToGp(entry.cost) }, { quiet: true });
        await Promise.all(contents.filter(x => x !== holder).map(({ c, ce }) => addItem({ type: "gear", name: ce.name, quantity: c.quantity, isCustom: false, catalogId: ce.id, isContainer: !!ce.isContainer, weightLb: parseWeightLb(ce.weight), valueGp: parseCostToGp(ce.cost), containerId }, { quiet: true })));
      }
      toast(`${entry.name} added`);
    } else if (cat === "gear") await addItem({ type: "gear", name: entry.name, quantity: qty, isCustom: false, catalogId: entry.id, weightLb: parseWeightLb(entry.weight), valueGp: parseCostToGp(entry.cost), isContainer: !!entry.isContainer });
    if (buy && cost > 0) toast(`Paid ${Math.round(cost * 100) / 100} GP`);
    return true;
  }
  async function grantMagic(m, baseId, bonus) {
    const magic = { id: m.id, rarity: m.rarity, attunement: !!m.attunement, attunementBy: m.attunementBy || null, description: m.description,
      maxCharges: /^\d+$/.test(m.charges || "") ? parseInt(m.charges, 10) : null, acBonus: m.acBonus || null, saveBonus: m.saveBonus || null, healDice: m.healDice || null };
    const plus = bonus || m.attackBonus || (m.type === "Armor" ? null : null);
    if (m.type === "Weapon" && baseId) {
      const base = findById(ruleset.equipment.weapons, baseId);
      const b = bonus || m.attackBonus || 0;
      const it = weaponItem(character, base, { name: m.variable ? `${base.name} +${b}` : `${m.name} (${base.name})`, magic });
      it.weaponData.attackBonus = b; it.weaponData.damageBonus = b;
      return addItem(it);
    }
    if (m.type === "Armor" && baseId) {
      const base = findById(ruleset.equipment.armor, baseId);
      const b = bonus || m.bonus || 0;
      const it = armorItem(base, { name: m.variable ? `${base.name} +${b}` : `${m.name} (${base.name})`, magic });
      it.armorData.baseAC += b;
      if (/mithral/i.test(m.name)) { it.armorData.stealthDisadvantage = false; it.armorData.strengthRequirement = null; }
      return addItem(it);
    }
    return addItem({ type: "gear", name: m.variable && bonus ? `${m.name.replace(/,? \+1, \+2, or \+3/, "")} +${bonus}` : m.name, quantity: 1, isCustom: false, isContainer: /bag of holding|haversack|portable hole/i.test(m.name), weightLb: 0, valueGp: 0, magic });
  }

  function renderBody() {
    body.innerHTML = "";
    if (formMemory.cat === "custom") { body.appendChild(customForm(ctx)); return; }
    const search = h("input", { type: "search", placeholder: "Search…", value: formMemory.q });
    body.appendChild(search);
    const list = h("div", { class: "shop-list" });
    body.appendChild(list);
    const draw = () => {
      list.innerHTML = "";
      const q = search.value.trim().toLowerCase();
      formMemory.q = search.value;
      const rows = catalog().filter(r => !q || r.label.toLowerCase().includes(q) || r.meta.toLowerCase().includes(q)).slice(0, 80);
      rows.forEach(({ e, label, meta }) => {
        const row = h("div", { class: "shop-row" });
        row.appendChild(h("div", { class: "shop-name" }, `<strong>${escapeHtml(label)}</strong><small>${escapeHtml(meta)}</small>`));
        const ctl = h("div", { class: "shop-ctl" });
        if (formMemory.cat === "magic") {
          let baseSel = null, bonusSel = null;
          const bases = baseOptions(ruleset, e);
          if (bases.length) {
            baseSel = h("select", {});
            bases.forEach(b => baseSel.appendChild(h("option", { value: b.id }, b.name)));
            ctl.appendChild(baseSel);
          }
          if (e.variable) {
            bonusSel = h("select", {});
            [1, 2, 3].forEach(n => bonusSel.appendChild(h("option", { value: String(n) }, `+${n}`)));
            ctl.appendChild(bonusSel);
          }
          const add = h("button", { class: "btn sm primary", type: "button" }, "Add");
          add.addEventListener("click", () => grantMagic(e, baseSel?.value || null, bonusSel ? parseInt(bonusSel.value, 10) : null));
          ctl.appendChild(add);
          const info = h("details", { class: "creator-detail shop-info" });
          info.appendChild(h("summary", {}, "Details"));
          info.appendChild(h("div", { class: "creator-detail-body" }, escapeHtml(e.description).replace(/\n/g, "<br>")));
          row.appendChild(ctl); row.appendChild(info);
        } else {
          const qty = h("input", { type: "number", min: "1", value: "1", class: "shop-qty" });
          const add = h("button", { class: "btn sm", type: "button" }, "Add");
          const buy = h("button", { class: "btn sm primary", type: "button", title: `Deduct ${e.cost} from your coin purse` }, `Buy ${e.cost}`);
          const n = () => Math.max(1, parseInt(qty.value, 10) || 1);
          add.addEventListener("click", () => grant(e, n(), false));
          buy.addEventListener("click", () => grant(e, n(), true));
          ctl.appendChild(qty); ctl.appendChild(add); ctl.appendChild(buy);
          row.appendChild(ctl);
        }
        list.appendChild(row);
      });
      if (!rows.length) list.appendChild(h("p", { class: "meta" }, "Nothing matches."));
    };
    search.addEventListener("input", draw);
    draw();
  }
  renderCats();
  renderBody();
  return form;
}

function customForm(ctx) {
  const { addItem } = ctx;
  const f = h("div", {});
  const typeSel = h("select", {});
  [["gear", "Gear"], ["weapon", "Weapon"], ["armor", "Armor"], ["ammo", "Ammunition"]].forEach(([v, l]) => typeSel.appendChild(h("option", { value: v }, l)));
  const name = h("input", { type: "text", placeholder: "Item name" });
  const fields = h("div", {});
  const weight = h("input", { type: "number", placeholder: "Weight (lb.)", step: "0.1" });
  const value = h("input", { type: "number", placeholder: "Value (GP)", step: "0.1" });
  const desc = h("textarea", { placeholder: "Description / properties (optional)", style: "min-height:60px;" });
  const drawFields = () => {
    fields.innerHTML = "";
    if (typeSel.value === "weapon") fields.innerHTML = `<div class="field-row"><input type="text" id="cw-dice" placeholder="Damage dice, e.g. 1d8"><select id="cw-type">${["slashing", "piercing", "bludgeoning", "fire", "cold", "acid", "poison", "necrotic", "radiant", "force", "lightning", "thunder", "psychic"].map(t => `<option>${t}</option>`).join("")}</select><select id="cw-abil"><option value="str">Strength</option><option value="dex">Dexterity</option><option value="finesse">Finesse</option></select></div><div class="field-row"><input type="number" id="cw-bonus" placeholder="Magic bonus (+N)"><label style="display:flex;gap:6px;align-items:center;text-transform:none;"><input type="checkbox" id="cw-ranged" style="width:auto;margin:0;"> Ranged</label></div>`;
    if (typeSel.value === "armor") fields.innerHTML = `<div class="field-row"><input type="number" id="ca-ac" placeholder="Base AC" value="11"><select id="ca-type"><option value="light">Light</option><option value="medium">Medium</option><option value="heavy">Heavy</option><option value="shield">Shield</option></select><select id="ca-dex"><option value="full">Full Dex</option><option value="max2">Dex (max 2)</option><option value="none">No Dex</option></select></div>`;
    if (typeSel.value === "ammo") fields.innerHTML = `<input type="text" id="cm-type" placeholder="Ammo type, e.g. arrow"><input type="number" id="cm-qty" placeholder="Quantity" value="20">`;
    if (typeSel.value === "gear") fields.innerHTML = `<label style="display:flex;gap:6px;align-items:center;text-transform:none;"><input type="checkbox" id="cg-cont" style="width:auto;margin:0;"> Container (backpack, pouch...)</label><label style="display:flex;gap:6px;align-items:center;text-transform:none;"><input type="checkbox" id="cg-att" style="width:auto;margin:0;"> Requires attunement</label>`;
  };
  typeSel.addEventListener("change", drawFields);
  drawFields();
  const btn = h("button", { class: "btn primary", type: "button" }, "Add custom item");
  btn.addEventListener("click", async () => {
    const nm = name.value.trim();
    if (!nm) { toast("Name the item", "error"); return; }
    const q = (id) => fields.querySelector(id);
    const base = { name: nm, quantity: 1, isCustom: true, weightLb: parseFloat(weight.value) || 0, valueGp: parseFloat(value.value) || 0 };
    if (desc.value.trim()) base.magic = { description: desc.value.trim(), rarity: "Custom", attunement: !!q("#cg-att")?.checked };
    if (typeSel.value === "weapon") {
      const b = parseInt(q("#cw-bonus").value, 10) || 0;
      await addItem({ ...base, type: "weapon", equipped: false, weaponData: { damageDice: q("#cw-dice").value.trim() || "1d4", damageType: q("#cw-type").value, ability: q("#cw-abil").value, ranged: q("#cw-ranged").checked, ammoType: null, properties: [], proficient: true, attackBonus: b, damageBonus: b } });
    } else if (typeSel.value === "armor") {
      await addItem({ ...base, type: "armor", equipped: false, armorData: { armorType: q("#ca-type").value, baseAC: parseInt(q("#ca-ac").value, 10) || 11, dexBonus: q("#ca-dex").value, strengthRequirement: null, stealthDisadvantage: false } });
    } else if (typeSel.value === "ammo") {
      const t = q("#cm-type").value.trim();
      if (!t) { toast("Give the ammo a type", "error"); return; }
      await addItem({ ...base, type: "ammo", ammoType: t, quantity: parseInt(q("#cm-qty").value, 10) || 1 });
    } else await addItem({ ...base, type: "gear", isContainer: !!q("#cg-cont")?.checked });
    name.value = ""; desc.value = "";
  });
  [typeSel, name, fields, h("div", { class: "field-row" }, [weight, value]), desc, btn].forEach(el => f.appendChild(el));
  return f;
}
