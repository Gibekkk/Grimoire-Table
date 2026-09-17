import { db } from "../../db.js";
import { h, toast, escapeHtml } from "../../util.js";
import { compressImageToBase64, IMAGE_PRESETS } from "../../image-utils.js";

const ITEM_TYPES = [
  ["gear", "Gear / misc"], ["weapon", "Weapon"], ["armor", "Armor"],
  ["ammo", "Ammunition"], ["consumable", "Consumable"], ["treasure", "Treasure"]
];
const RARITIES = ["Common", "Uncommon", "Rare", "Very Rare", "Legendary", "Artifact"];

// Every input gets a visible label + a one-line hint, since the DM is authoring
// data other people will read in shops and loot piles.
function field(labelText, hint, el) {
  const wrap = h("div", { style: "margin-bottom:12px;" });
  wrap.appendChild(h("label", { style: "margin-bottom:2px;" }, labelText));
  if (hint) wrap.appendChild(h("div", { class: "hint", style: "margin:0 0 5px;" }, hint));
  el.style.marginBottom = "0";
  wrap.appendChild(el);
  return wrap;
}

export function mountItemWorkshopPanel(container, { campaignId, isDm }) {
  if (!isDm) {
    container.appendChild(h("div", { class: "empty-state" }, "<h3>DM tools</h3><p>Only the DM can author campaign items.</p>"));
    return () => {};
  }

  let items = [];
  let pcs = [], npcs = [], party = [];
  let editingId = null;

  // "Give to" should cover NPCs too (shopkeepers, quest-givers holding an item).
  function recomputeRecipients() { party = [...pcs, ...npcs]; renderList(); }

  const formCard = h("div", { class: "card" });
  container.appendChild(formCard);
  const listCard = h("div", { class: "card" });
  listCard.appendChild(h("h3", {}, "Campaign Items"));
  const list = h("div", {});
  listCard.appendChild(list);
  container.appendChild(listCard);

  function buildForm(existing) {
    formCard.innerHTML = "";
    editingId = existing?.id || null;
    formCard.appendChild(h("h3", {}, existing ? `Edit \u2014 ${existing.name}` : "Create Item"));

    const nameInput = h("input", { type: "text", value: existing?.name || "" });
    formCard.appendChild(field("Item name", "What players see at a glance, even from across the room.", nameInput));

    const typeSel = h("select", {});
    ITEM_TYPES.forEach(([v, l]) => typeSel.appendChild(h("option", { value: v, selected: existing?.type === v ? "selected" : null }, l)));
    formCard.appendChild(field("Item type", "Determines how it behaves once it reaches a character's inventory.", typeSel));

    const raritySel = h("select", {});
    RARITIES.forEach(r => raritySel.appendChild(h("option", { value: r, selected: existing?.rarity === r ? "selected" : null }, r)));
    formCard.appendChild(field("Rarity", "Flavour only \u2014 shown alongside the name in shops and loot.", raritySel));

    const descInput = h("textarea", {});
    descInput.value = existing?.description || "";
    formCard.appendChild(field("Description", "Full text. Hidden from players while the description lock is on.", descInput));

    const lockRow = h("label", { style: "display:flex; align-items:center; gap:8px; text-transform:none; margin-bottom:12px;" });
    const lockCheck = h("input", { type: "checkbox", style: "width:auto; margin:0;" });
    lockCheck.checked = existing ? !!existing.descriptionLocked : true;
    lockRow.appendChild(lockCheck);
    lockRow.appendChild(document.createTextNode(" Description locked (players see only name, image, and weight)"));
    formCard.appendChild(lockRow);

    const grid = h("div", { class: "grid cols-3" });
    const weightInput = h("input", { type: "number", step: "0.1", value: existing?.weightLb ?? 0 });
    const valueInput = h("input", { type: "number", step: "0.1", value: existing?.valueGp ?? 0 });
    const qtyInput = h("input", { type: "number", min: "1", value: existing?.defaultQuantity ?? 1 });
    grid.appendChild(field("Weight (lb.)", "Counts toward carry capacity.", weightInput));
    grid.appendChild(field("Base value (GP)", "Merchants price from this before discount.", valueInput));
    grid.appendChild(field("Default quantity", "How many are granted per copy.", qtyInput));
    formCard.appendChild(grid);

    // Weapon-only mechanical fields — meaningless on a rope, so only shown for weapons.
    const weaponBox = h("div", {});
    function renderWeaponFields() {
      weaponBox.innerHTML = "";
      if (typeSel.value !== "weapon") return;
      const wd = existing?.weaponData || {};
      const diceInput = h("input", { type: "text", value: wd.damageDice || "1d6", id: "wd-dice" });
      weaponBox.appendChild(field("Damage dice", "e.g. 1d8. Rolled when the owner hits Attack.", diceInput));
      const dtSel = h("select", { id: "wd-type" });
      ["slashing", "piercing", "bludgeoning", "fire", "cold", "acid", "poison", "necrotic", "radiant", "force", "lightning", "thunder", "psychic"].forEach(t => dtSel.appendChild(h("option", { value: t, selected: wd.damageType === t ? "selected" : null }, t)));
      weaponBox.appendChild(field("Damage type", "Applied to the damage roll.", dtSel));
      const abSel = h("select", { id: "wd-ability" });
      [["str", "Strength"], ["dex", "Dexterity"], ["finesse", "Finesse (best of Str/Dex)"]].forEach(([v, l]) => abSel.appendChild(h("option", { value: v, selected: wd.ability === v ? "selected" : null }, l)));
      weaponBox.appendChild(field("Attack ability", "Which modifier drives attack and damage.", abSel));
      const rangedRow = h("label", { style: "display:flex; align-items:center; gap:8px; text-transform:none; margin-bottom:12px;" });
      const rangedCheck = h("input", { type: "checkbox", id: "wd-ranged", style: "width:auto; margin:0;" });
      rangedCheck.checked = !!wd.ranged;
      rangedRow.appendChild(rangedCheck);
      rangedRow.appendChild(document.createTextNode(" Ranged weapon"));
      weaponBox.appendChild(rangedRow);
      const rangeInput = h("input", { type: "text", value: wd.range || "", id: "wd-range" });
      weaponBox.appendChild(field("Range", "e.g. 80/320 ft. Leave blank for melee reach.", rangeInput));
    }
    typeSel.addEventListener("change", renderWeaponFields);
    renderWeaponFields();
    formCard.appendChild(weaponBox);

    const fileInput = h("input", { type: "file", accept: "image/*" });
    let imageBase64 = existing?.imageBase64 || null;
    const preview = h("div", { class: "portrait-preview", style: "border-radius:8px;" });
    preview.innerHTML = imageBase64 ? `<img src="${imageBase64}">` : "<span>?</span>";
    fileInput.addEventListener("change", async () => {
      if (!fileInput.files?.[0]) return;
      const r = await compressImageToBase64(fileInput.files[0], IMAGE_PRESETS.component);
      imageBase64 = r.dataUrl;
      preview.innerHTML = `<img src="${imageBase64}">`;
    });
    const imgRow = h("div", { style: "display:flex; align-items:center; gap:12px;" });
    imgRow.appendChild(preview); imgRow.appendChild(fileInput);
    formCard.appendChild(field("Image", "Shown in shops, loot orbs, and inventories.", imgRow));

    const saveBtn = h("button", { class: "btn primary" }, existing ? "Save Changes" : "Create Item");
    saveBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) { toast("Name the item first", "error"); return; }
      const payload = {
        name, type: typeSel.value, rarity: raritySel.value,
        description: descInput.value.trim(), descriptionLocked: lockCheck.checked,
        weightLb: parseFloat(weightInput.value) || 0,
        valueGp: parseFloat(valueInput.value) || 0,
        defaultQuantity: Math.max(1, parseInt(qtyInput.value, 10) || 1),
        imageBase64
      };
      if (typeSel.value === "weapon") {
        payload.weaponData = {
          damageDice: weaponBox.querySelector("#wd-dice")?.value.trim() || "1d6",
          damageType: weaponBox.querySelector("#wd-type")?.value || "bludgeoning",
          ability: weaponBox.querySelector("#wd-ability")?.value || "str",
          ranged: weaponBox.querySelector("#wd-ranged")?.checked || false,
          range: weaponBox.querySelector("#wd-range")?.value.trim() || null,
          ammoType: null, proficient: true, attackBonus: 0, damageBonus: 0
        };
      }
      if (editingId) { await db.campaignItems.update(campaignId, editingId, payload); toast(`${name} updated`); }
      else { await db.campaignItems.add(campaignId, payload); toast(`${name} created`); }
      buildForm(null);
    });
    formCard.appendChild(saveBtn);
    if (existing) {
      const cancelBtn = h("button", { class: "btn ghost", style: "margin-left:8px;" }, "Cancel");
      cancelBtn.addEventListener("click", () => buildForm(null));
      formCard.appendChild(cancelBtn);
    }
  }

  function renderList() {
    list.innerHTML = "";
    if (items.length === 0) { list.appendChild(h("p", {}, "No items authored yet.")); return; }
    items.forEach(def => {
      const row = h("div", { class: "inventory-item" });
      row.innerHTML = `
        <div class="row1">
          <div>
            <div class="item-name">${escapeHtml(def.name)} <span class="badge">${escapeHtml(def.rarity || "Common")}</span> ${def.descriptionLocked ? '<span class="badge">\u{1F512} locked</span>' : ""}</div>
            <div class="item-meta">${escapeHtml(def.type)} \u2022 ${def.weightLb || 0} lb. \u2022 ${def.valueGp || 0} GP</div>
          </div>
        </div>
      `;
      const actions = h("div", { class: "row-actions" });

      const editBtn = h("button", { class: "btn sm" }, "Edit");
      editBtn.addEventListener("click", () => { buildForm(def); container.scrollIntoView({ behavior: "smooth", block: "start" }); });
      actions.appendChild(editBtn);

      const dupBtn = h("button", { class: "btn sm" }, "Duplicate");
      dupBtn.addEventListener("click", async () => {
        const { id, createdAt, ...rest } = def;
        await db.campaignItems.add(campaignId, { ...rest, name: `${def.name} (copy)` });
        toast(`Duplicated ${def.name}`);
      });
      actions.appendChild(dupBtn);

      const lockBtn = h("button", { class: "btn sm ghost" }, def.descriptionLocked ? "Unlock description" : "Lock description");
      lockBtn.addEventListener("click", () => db.campaignItems.update(campaignId, def.id, { descriptionLocked: !def.descriptionLocked }));
      actions.appendChild(lockBtn);

      if (party.length) {
        const giveSel = h("select", { style: "width:auto; margin:0; padding:4px 8px; font-size:0.72rem;" });
        giveSel.appendChild(h("option", { value: "" }, "Give to\u2026"));
        party.forEach(c => giveSel.appendChild(h("option", { value: c.id }, c.name)));
        giveSel.addEventListener("change", async () => {
          if (!giveSel.value) return;
          const target = party.find(c => c.id === giveSel.value);
          await db.inventory.add(giveSel.value, campaignItemToInventoryItem(def));
          toast(`${def.name} given to ${target?.name || "character"}`);
          giveSel.value = "";
        });
        actions.appendChild(giveSel);
      }

      const delBtn = h("button", { class: "btn sm ghost" }, "Delete");
      delBtn.addEventListener("click", async () => {
        if (!confirm(`Delete "${def.name}" from the campaign catalog? Copies already in inventories stay put.`)) return;
        await db.campaignItems.remove(campaignId, def.id);
      });
      actions.appendChild(delBtn);

      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  const unsubItems = db.campaignItems.subscribe(campaignId, (list2) => { items = list2; renderList(); });

  const unsubParty = db.characters.subscribeCampaignParty(campaignId, (p) => { pcs = p; recomputeRecipients(); });
  const unsubNpcs = db.characters.subscribeCampaignNpcs(campaignId, (n) => { npcs = n; recomputeRecipients(); });

  buildForm(null);
  return () => { unsubItems(); unsubParty(); unsubNpcs(); };
}

// Exported so the merchant shop and VTT loot can build inventory items the
// same way, from the same definitions.
export function campaignItemToInventoryItem(def) {
  const base = {
    type: def.type === "consumable" || def.type === "treasure" ? "gear" : def.type,
    name: def.name, quantity: def.defaultQuantity || 1, isCustom: true,
    weightLb: def.weightLb || 0, valueGp: def.valueGp || 0,
    description: def.description || "", descriptionLocked: !!def.descriptionLocked,
    imageBase64: def.imageBase64 || null, sourceItemId: def.id, rarity: def.rarity || null
  };
  if (def.type === "weapon") { base.weaponData = def.weaponData; base.equipped = false; }
  if (def.type === "armor") { base.armorData = def.armorData || { armorType: "light", baseAC: 11, dexBonus: "full" }; base.equipped = false; }
  if (def.type === "ammo") base.ammoType = def.ammoType || "arrow";
  return base;
}
