import { db } from "../../db.js";
import { h, toast, escapeHtml } from "../../util.js";
import { buildAddItemForm } from "../../sheet/sheet-inventory.js";

// Remounted whenever the VTT switches maps. Shows what's "in this room":
// dropped items and leftover loot, separate from the party-wide loot pool.
export function mountRoomInventoryPanel(container, { campaignId, mapId, ruleset, myCharacter, isDm }) {
  container.innerHTML = "";
  container.appendChild(h("h3", {}, "Room Inventory"));
  container.appendChild(h("p", { class: "hint" }, "Loot tied to this specific map \u2014 dropped items and leftovers, separate from Party Loot."));

  const list = h("div", {});
  container.appendChild(list);

  if (myCharacter || isDm) {
    container.appendChild(h("hr", { class: "divider" }));
    container.appendChild(buildAddItemForm({
      ruleset,
      addItem: (item) => db.roomInventory.add(campaignId, mapId, item)
    }));
  }

  const unsub = db.roomInventory.subscribe(campaignId, mapId, (items) => {
    list.innerHTML = "";
    if (items.length === 0) { list.appendChild(h("p", {}, "Nothing here yet.")); return; }
    items.forEach(item => {
      const row = h("div", { class: "inventory-item" });
      row.innerHTML = `
        <div class="row1">
          <div>
            <div class="item-name">${escapeHtml(item.name)} ${item.quantity > 1 ? `\u00d7${item.quantity}` : ""}</div>
            <div class="item-meta">${escapeHtml(item.type || "")}${item.weightLb ? ` \u2022 ${item.weightLb} lb.` : ""}</div>
          </div>
        </div>
      `;
      const actions = h("div", { class: "row-actions" });
      if (myCharacter) {
        const takeBtn = h("button", { class: "btn sm primary" }, "Take");
        takeBtn.addEventListener("click", async () => {
          const { id, createdAt, ...rest } = item;
          await db.inventory.add(myCharacter.id, rest);
          await db.roomInventory.remove(campaignId, mapId, item.id);
          toast(`${item.name} added to your inventory`);
        });
        actions.appendChild(takeBtn);
      }
      if (isDm) {
        const delBtn = h("button", { class: "btn sm ghost" }, "Remove");
        delBtn.addEventListener("click", () => db.roomInventory.remove(campaignId, mapId, item.id));
        actions.appendChild(delBtn);
      }
      row.appendChild(actions);
      list.appendChild(row);
    });
  });

  return unsub;
}
