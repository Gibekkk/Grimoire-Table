import { h } from "../util.js";
import { findById } from "../data-loader.js";
import {
  getClassEntries, totalLevel, unarmedStrikeWeapon, weaponRangeLabel,
  weaponAttackBonus, weaponDamageBonus, maxResourceUses, formatModifier
} from "../rules-engine.js";

function weaponRow(ctx, item, weaponData, attackFn) {
  const { character } = ctx;
  const atk = weaponAttackBonus(character, weaponData, item);
  const dmg = weaponDamageBonus(character, weaponData, item);
  const row = h("div", { class: "inventory-item equipped" });
  row.innerHTML = `
    <div class="row1">
      <div>
        <div class="item-name">${item.name}</div>
        <div class="item-meta">${weaponData.damageDice} ${weaponData.damageType} + ${dmg} \u2022 Attack ${formatModifier(atk)} \u2022 Range: ${weaponRangeLabel(weaponData)}</div>
      </div>
    </div>
  `;
  const actions = h("div", { class: "row-actions" });
  const attackBtn = h("button", { class: "btn sm danger" }, "\u2694 Attack");
  attackBtn.addEventListener("click", attackFn);
  actions.appendChild(attackBtn);
  row.appendChild(actions);
  return row;
}

export function renderActionsTab(ctx) {
  const { character, ruleset, inventory, canManageXp, doAttack } = ctx;
  const wrap = h("div", {});
  const level = totalLevel(character);

  // ---- Unarmed strike (always available) ----
  const unarmedCard = h("div", { class: "card" });
  unarmedCard.appendChild(h("h3", {}, "Unarmed"));
  const unarmed = unarmedStrikeWeapon(character, ruleset.classes);
  unarmedCard.appendChild(weaponRow(ctx, { name: "Unarmed Strike", weaponData: unarmed, isCustom: false, proficient: true }, unarmed, () => doAttack({ name: "Unarmed Strike", weaponData: unarmed, isCustom: false })));
  wrap.appendChild(unarmedCard);

  // ---- Equipped weapons ----
  const weaponsCard = h("div", { class: "card" });
  weaponsCard.appendChild(h("h3", {}, "Weapon Attacks"));
  const equipped = inventory.filter(i => i.type === "weapon" && i.equipped);
  if (equipped.length === 0) weaponsCard.appendChild(h("p", {}, "No weapons equipped \u2014 equip one from the Inventory tab."));
  equipped.forEach(item => weaponsCard.appendChild(weaponRow(ctx, item, item.weaponData, () => doAttack(item))));
  wrap.appendChild(weaponsCard);

  // ---- Toggleable class resources ----
  const entries = getClassEntries(character);
  const resourcesCard = h("div", { class: "card" });
  resourcesCard.appendChild(h("h3", {}, "Class Resources"));
  let anyResource = false;
  entries.forEach(entry => {
    const features = ruleset.classFeatures.filter(f => f.classId === entry.classId && f.resource && entry.level >= f.level);
    features.forEach(f => {
      anyResource = true;
      const max = maxResourceUses(f.resource, character, entry.level);
      const used = character.resourcesUsed?.[f.id] || 0;
      const row = h("div", { class: "pip-row" });
      row.innerHTML = `<div class="pip-label">${f.name}<span class="sub">Recharges on ${f.resource.recharge === "shortRest" ? "Short Rest" : "Long Rest"}</span></div>`;
      const pips = h("div", { class: "pips" });
      for (let i = 0; i < Math.min(max, 20); i++) {
        const pip = h("button", { class: `pip ${i < (max - used) ? "filled" : ""}` });
        pip.title = i < (max - used) ? "Click to use" : "Already used";
        pip.addEventListener("click", () => {
          const remaining = max - used;
          const newUsed = i < remaining ? used + 1 : Math.max(0, used - 1);
          ctx.patch({ resourcesUsed: { ...character.resourcesUsed, [f.id]: newUsed } });
        });
        pips.appendChild(pip);
      }
      row.appendChild(pips);
      resourcesCard.appendChild(row);
    });
  });
  if (!anyResource) resourcesCard.appendChild(h("p", {}, "No limited-use class resources unlocked yet."));
  wrap.appendChild(resourcesCard);

  return wrap;
}
