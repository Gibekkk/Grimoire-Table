import { db } from "../../db.js";
import { h, toast, escapeHtml } from "../../util.js";
import { currencyTotalGp, INTERACT_RANGE_FT } from "../../rules-engine.js";
import { campaignItemToInventoryItem } from "./item-workshop-panel.js";

const COINS = [["pp", "Platinum"], ["gp", "Gold"], ["ep", "Electrum"], ["sp", "Silver"], ["cp", "Copper"]];

function modal(title) {
  document.querySelector(".modal-overlay.shop")?.remove();
  const overlay = h("div", { class: "modal-overlay shop" });
  const box = h("div", { class: "modal-box wide" });
  const head = h("div", { style: "display:flex; justify-content:space-between; align-items:center; gap:10px;" });
  head.appendChild(h("h2", { style: "margin:0;" }, title));
  const closeBtn = h("button", { class: "btn sm ghost" }, "Close");
  closeBtn.addEventListener("click", () => overlay.remove());
  head.appendChild(closeBtn);
  box.appendChild(head);
  const body = h("div", { style: "text-align:left; margin-top:14px;" });
  box.appendChild(body);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  return { overlay, body };
}

export function priceAfterDiscount(entry, def) {
  const base = entry.priceGp != null ? entry.priceGp : (def?.valueGp || 0);
  const pct = Math.max(0, Math.min(100, entry.discountPct || 0));
  return Math.round(base * (1 - pct / 100) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Merchant shop
// ---------------------------------------------------------------------------
export function openMerchantShop({ campaignId, mapId, token, isDm, buyerCharacter, catalog }) {
  const { overlay, body } = modal(token.name || "Merchant");

  function render() {
    body.innerHTML = "";
    const stock = token.shopItems || [];

    if (buyerCharacter) {
      const purse = buyerCharacter.currency || {};
      body.appendChild(h("p", {}, `${buyerCharacter.name} carries ${currencyTotalGp(purse).toFixed(2)} GP worth of coin.`));
    }
    if (stock.length === 0) body.appendChild(h("p", {}, "This merchant has nothing in stock."));

    stock.forEach((entry, idx) => {
      const def = catalog.find(c => c.id === entry.itemId);
      if (!def) return;
      const price = priceAfterDiscount(entry, def);
      const base = entry.priceGp != null ? entry.priceGp : (def.valueGp || 0);
      const row = h("div", { class: "inventory-item" });
      row.innerHTML = `
        <div class="row1">
          <div>
            <div class="item-name">${escapeHtml(def.name)} <span class="badge">${escapeHtml(def.rarity || "Common")}</span></div>
            <div class="item-meta">
              ${entry.discountPct ? `<s>${base} GP</s> <strong style="color:var(--rune-bright)">${price} GP</strong> (\u2212${entry.discountPct}%)` : `${price} GP`}
              \u2022 ${entry.quantity} in stock \u2022 ${def.weightLb || 0} lb.
            </div>
          </div>
        </div>
      `;
      const actions = h("div", { class: "row-actions" });

      if (isDm) {
        const qty = h("input", { type: "number", min: "0", value: String(entry.quantity), style: "width:70px; margin:0;" });
        qty.title = "Stock quantity";
        qty.addEventListener("change", () => updateEntry(idx, { quantity: Math.max(0, parseInt(qty.value, 10) || 0) }));
        const priceIn = h("input", { type: "number", step: "0.1", value: String(base), style: "width:80px; margin:0;" });
        priceIn.title = "Base price in GP";
        priceIn.addEventListener("change", () => updateEntry(idx, { priceGp: parseFloat(priceIn.value) || 0 }));
        const discIn = h("input", { type: "number", min: "0", max: "100", value: String(entry.discountPct || 0), style: "width:70px; margin:0;" });
        discIn.title = "Discount %";
        discIn.addEventListener("change", () => updateEntry(idx, { discountPct: Math.max(0, Math.min(100, parseInt(discIn.value, 10) || 0)) }));
        actions.appendChild(qty); actions.appendChild(priceIn); actions.appendChild(discIn);
        const rm = h("button", { class: "btn sm ghost" }, "Remove");
        rm.addEventListener("click", () => removeEntry(idx));
        actions.appendChild(rm);
      }

      if (buyerCharacter && entry.quantity > 0) {
        const buyBtn = h("button", { class: "btn sm primary" }, `Buy \u2014 ${price} GP`);
        buyBtn.addEventListener("click", () => openPayment(entry, def, price, idx));
        actions.appendChild(buyBtn);
      }
      row.appendChild(actions);
      body.appendChild(row);
    });

    if (isDm) {
      body.appendChild(h("hr", { class: "divider" }));
      body.appendChild(h("h3", {}, "Stock an item"));
      const addRow = h("div", { class: "field-row" });
      const sel = h("select", {});
      catalog.forEach(c => sel.appendChild(h("option", { value: c.id }, `${c.name} (${c.valueGp || 0} GP)`)));
      const qtyIn = h("input", { type: "number", min: "1", value: "1", style: "max-width:80px;" });
      const addBtn = h("button", { class: "btn primary" }, "Add");
      addBtn.addEventListener("click", async () => {
        if (!sel.value) { toast("Author an item in the Item Workshop first", "error"); return; }
        const def = catalog.find(c => c.id === sel.value);
        const next = [...(token.shopItems || []), { itemId: sel.value, quantity: Math.max(1, parseInt(qtyIn.value, 10) || 1), priceGp: def?.valueGp || 0, discountPct: 0 }];
        await persist(next);
      });
      addRow.appendChild(sel); addRow.appendChild(qtyIn); addRow.appendChild(addBtn);
      body.appendChild(addRow);
      if (catalog.length === 0) body.appendChild(h("p", { class: "hint" }, "No campaign items yet \u2014 create some in the Item Workshop tab."));
    }
  }

  async function persist(next) {
    token.shopItems = next;
    await db.tokens.update(campaignId, mapId, token.id, { shopItems: next });
    render();
  }
  async function updateEntry(idx, patch) {
    const next = (token.shopItems || []).map((e, i) => i === idx ? { ...e, ...patch } : e);
    await persist(next);
  }
  async function removeEntry(idx) {
    await persist((token.shopItems || []).filter((_, i) => i !== idx));
  }

  // Player picks exactly which coins to hand over — no auto-deduction, since
  // which denominations you part with is a real table decision.
  function openPayment(entry, def, price, idx) {
    const payWrap = h("div", { class: "card", style: "margin-top:14px;" });
    payWrap.appendChild(h("h3", {}, `Pay ${price} GP for ${def.name}`));
    const purse = buyerCharacter.currency || {};
    const inputs = {};
    const grid = h("div", { class: "coin-grid" });
    COINS.forEach(([key, label]) => {
      const box = h("div", { class: "coin-box" });
      box.appendChild(h("label", {}, `${label} (have ${purse[key] || 0})`));
      const input = h("input", { type: "number", min: "0", max: String(purse[key] || 0), value: "0" });
      inputs[key] = input;
      input.addEventListener("input", updateTally);
      box.appendChild(input);
      grid.appendChild(box);
    });
    payWrap.appendChild(grid);
    const tally = h("p", {}, "");
    payWrap.appendChild(tally);

    function offered() {
      return Object.fromEntries(COINS.map(([k]) => [k, Math.max(0, parseInt(inputs[k].value, 10) || 0)]));
    }
    function updateTally() {
      const total = currencyTotalGp(offered());
      const diff = Math.round((total - price) * 100) / 100;
      tally.innerHTML = diff >= 0
        ? `Offering <strong>${total.toFixed(2)} GP</strong> \u2014 change due: ${diff.toFixed(2)} GP`
        : `Offering <strong>${total.toFixed(2)} GP</strong> \u2014 <span style="color:var(--blood-bright)">short by ${Math.abs(diff).toFixed(2)} GP</span>`;
    }
    updateTally();

    const confirmBtn = h("button", { class: "btn primary" }, "Confirm Purchase");
    confirmBtn.addEventListener("click", async () => {
      const paid = offered();
      const total = currencyTotalGp(paid);
      if (total + 1e-9 < price) { toast("Not enough coin offered", "error"); return; }
      for (const [k] of COINS) {
        if (paid[k] > (purse[k] || 0)) { toast(`You don't have that many ${k.toUpperCase()}`, "error"); return; }
      }
      // Deduct exactly what was offered, then return change in gold so the
      // maths always balances even on an overpayment.
      const change = Math.round((total - price) * 100) / 100;
      const newPurse = { ...purse };
      COINS.forEach(([k]) => { newPurse[k] = (newPurse[k] || 0) - paid[k]; });
      if (change > 0) newPurse.gp = Math.round(((newPurse.gp || 0) + change) * 100) / 100;

      await db.characters.update(buyerCharacter.id, { currency: newPurse });
      await db.inventory.add(buyerCharacter.id, { ...campaignItemToInventoryItem(def), quantity: 1 });
      await updateEntry(idx, { quantity: Math.max(0, entry.quantity - 1) });
      buyerCharacter.currency = newPurse;
      toast(`Bought ${def.name}${change > 0 ? ` \u2014 ${change} GP change` : ""}`);
      payWrap.remove();
      render();
    });
    payWrap.appendChild(confirmBtn);
    const cancel = h("button", { class: "btn ghost", style: "margin-left:8px;" }, "Cancel");
    cancel.addEventListener("click", () => payWrap.remove());
    payWrap.appendChild(cancel);

    body.appendChild(payWrap);
    payWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  render();
  return overlay;
}

// ---------------------------------------------------------------------------
// Loot: ground items, and the body of a dead character
// ---------------------------------------------------------------------------
export function openLootWindow({ campaignId, mapId, token, isDm, looterCharacter, party, canReach }) {
  const isBody = token.kind === "body";
  const { overlay, body } = modal(isBody ? `${token.name}'s body` : (token.name || "Loot"));

  if (!canReach && !isDm) {
    body.appendChild(h("p", {}, `You need to be within ${INTERACT_RANGE_FT} ft to search this.`));
    return;
  }

  // A body's loot is the dead character's own inventory, so it stays in sync
  // with whatever they were actually carrying.
  const sourceCharacterId = isBody ? token.refId : null;

  const list = h("div", {});
  body.appendChild(list);

  function renderItems(items) {
    list.innerHTML = "";
    if (items.length === 0) { list.appendChild(h("p", {}, "Nothing left here.")); return; }
    items.forEach(item => {
      const locked = item.descriptionLocked && !isDm;
      const row = h("div", { class: "inventory-item" });
      row.innerHTML = `
        <div class="row1">
          <div style="display:flex; gap:10px; align-items:center;">
            ${item.imageBase64 ? `<div class="portrait-preview sm" style="border-radius:6px;"><img src="${item.imageBase64}"></div>` : ""}
            <div>
              <div class="item-name">${escapeHtml(item.name)} ${item.quantity > 1 ? `\u00d7${item.quantity}` : ""}</div>
              <div class="item-meta">${item.weightLb || 0} lb.${locked ? " \u2022 \u{1F512} description sealed" : (item.description ? " \u2022 " + escapeHtml(item.description) : "")}</div>
            </div>
          </div>
        </div>
      `;
      const actions = h("div", { class: "row-actions" });
      if (looterCharacter) {
        const takeBtn = h("button", { class: "btn sm primary" }, "Take");
        takeBtn.addEventListener("click", () => transfer(item, looterCharacter.id));
        actions.appendChild(takeBtn);
      }
      if (isDm && party.length) {
        const sel = h("select", { style: "width:auto; margin:0; padding:4px 8px; font-size:0.72rem;" });
        sel.appendChild(h("option", { value: "" }, "Give to\u2026"));
        party.forEach(c => sel.appendChild(h("option", { value: c.id }, c.name)));
        sel.addEventListener("change", () => { if (sel.value) transfer(item, sel.value); });
        actions.appendChild(sel);
        const lockBtn = h("button", { class: "btn sm ghost" }, item.descriptionLocked ? "Unlock" : "Lock");
        lockBtn.addEventListener("click", () => {
          if (sourceCharacterId) db.inventory.update(sourceCharacterId, item.id, { descriptionLocked: !item.descriptionLocked });
          else db.roomInventory.update(campaignId, mapId, item.id, { descriptionLocked: !item.descriptionLocked });
        });
        actions.appendChild(lockBtn);
      }
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  async function transfer(item, toCharacterId) {
    const { id, createdAt, ...rest } = item;
    await db.inventory.add(toCharacterId, rest);
    if (sourceCharacterId) await db.inventory.remove(sourceCharacterId, item.id);
    else await db.roomInventory.remove(campaignId, mapId, item.id);
    toast(`${item.name} taken`);
  }

  const unsub = sourceCharacterId
    ? db.inventory.subscribe(sourceCharacterId, renderItems)
    : db.roomInventory.subscribe(campaignId, mapId, renderItems);

  // The modal is torn out of the DOM by its own Close button, so watch for that
  // and drop the live subscription with it rather than leaking a listener.
  const obs = new MutationObserver(() => {
    if (!document.body.contains(overlay)) { unsub(); obs.disconnect(); }
  });
  obs.observe(document.body, { childList: true });
}
