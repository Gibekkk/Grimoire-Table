import { db } from "../../db.js";
import { h, toast, escapeHtml, timeAgo } from "../../util.js";
import { currencyTotalGp } from "../../rules-engine.js";

export function mountPartyInventoryPanel(container, { campaignId, user }) {
  const wrap = h("div", {});
  let myCharacter = null;

  const currencyCard = h("div", { class: "card" });
  currencyCard.appendChild(h("h3", {}, "Party Coffer"));
  container.appendChild(currencyCard);

  const itemsCard = h("div", { class: "card" });
  itemsCard.appendChild(h("h3", {}, "Shared Inventory"));
  itemsCard.appendChild(h("p", {}, "Anyone in the campaign can send items or gold here from their own Inventory tab, and take from here into their own."));
  container.appendChild(itemsCard);
  container.appendChild(wrap);

  function renderCurrency(campaign) {
    currencyCard.querySelectorAll(".coin-grid, p").forEach(el => { if (el.tagName !== "H3") el.remove(); });
    const currency = campaign?.partyCurrency || { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
    const grid = h("div", { class: "coin-grid" });
    [["cp", "Copper"], ["sp", "Silver"], ["ep", "Electrum"], ["gp", "Gold"], ["pp", "Platinum"]].forEach(([key, label]) => {
      const box = h("div", { class: "coin-box" });
      box.innerHTML = `<label>${label}</label><div class="mono" style="font-size:1.1rem; padding:6px 0;">${currency[key] || 0}</div>`;
      if (myCharacter) {
        const takeBtn = h("button", { class: "btn sm ghost block", style: "font-size:0.62rem; padding:4px;" }, "Take All");
        takeBtn.addEventListener("click", async () => {
          const amt = currency[key] || 0;
          if (amt <= 0) return;
          const myCurrency = myCharacter.currency || { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
          await db.characters.update(myCharacter.id, { currency: { ...myCurrency, [key]: (myCurrency[key] || 0) + amt } });
          await db.campaigns.update(campaignId, { partyCurrency: { ...currency, [key]: 0 } });
          toast(`Took ${amt} ${key.toUpperCase()}`);
        });
        box.appendChild(takeBtn);
      }
      grid.appendChild(box);
    });
    currencyCard.appendChild(grid);
    currencyCard.appendChild(h("p", {}, `Total value: ${currencyTotalGp(currency).toLocaleString()} GP`));
  }

  function renderItems(items) {
    wrap.innerHTML = "";
    if (items.length === 0) { wrap.appendChild(h("p", {}, "No items in the party pool yet.")); return; }
    items.forEach(item => {
      const row = h("div", { class: "inventory-item" });
      row.innerHTML = `
        <div class="row1">
          <div>
            <div class="item-name">${escapeHtml(item.name)} ${item.quantity > 1 ? `\u00d7${item.quantity}` : ""}</div>
            <div class="item-meta">From ${escapeHtml(item.contributedByName || "unknown")} \u2022 ${timeAgo(item.createdAt)}</div>
          </div>
        </div>
      `;
      if (myCharacter) {
        const actions = h("div", { class: "row-actions" });
        const takeBtn = h("button", { class: "btn sm primary" }, "Take");
        takeBtn.addEventListener("click", async () => {
          const { id, createdAt, contributedByName, contributedByUid, ...rest } = item;
          await db.inventory.add(myCharacter.id, rest);
          await db.partyInventory.remove(campaignId, item.id);
          toast(`${item.name} added to your inventory`);
        });
        actions.appendChild(takeBtn);
        row.appendChild(actions);
      }
      wrap.appendChild(row);
    });
  }

  const unsubParty = db.characters.subscribeCampaignParty(campaignId, (party) => {
    myCharacter = party.find(c => c.ownerUid === user.uid) || null;
    db.campaigns.get(campaignId).then(renderCurrency);
  });
  const unsubItems = db.partyInventory.subscribe(campaignId, renderItems);
  db.campaigns.get(campaignId).then(renderCurrency);

  return () => { unsubParty(); unsubItems(); };
}
