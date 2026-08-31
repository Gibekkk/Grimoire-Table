import { db } from "../../db.js";
import { h, toast, escapeHtml } from "../../util.js";

export function mountSocialPanel(container, { campaignId, isDm }) {
  if (!isDm) {
    container.appendChild(h("div", { class: "empty-state" }, "<h3>DM tools</h3><p>Only the DM can see the relationship web.</p>"));
    return () => {};
  }

  let party = [], npcs = [];
  const wrap = h("div", {});
  const formCard = h("div", { class: "card" });
  formCard.appendChild(h("h3", {}, "Add Relationship"));
  container.appendChild(formCard);
  container.appendChild(wrap);

  function entityOptions(select) {
    select.innerHTML = "";
    select.appendChild(h("option", { value: "" }, "\u2014 choose \u2014"));
    if (party.length) {
      const grp = h("optgroup", { label: "Player Characters" });
      party.forEach(c => grp.appendChild(h("option", { value: `pc:${c.id}:${c.name}` }, c.name)));
      select.appendChild(grp);
    }
    if (npcs.length) {
      const grp = h("optgroup", { label: "NPCs" });
      npcs.forEach(n => grp.appendChild(h("option", { value: `npc:${n.id}:${n.name}` }, n.name)));
      select.appendChild(grp);
    }
  }

  function renderForm() {
    formCard.querySelectorAll(".field-row, .hint").forEach(el => el.remove());
    const row = h("div", { class: "field-row" });
    const fromSel = h("select", {}); entityOptions(fromSel);
    const toSel = h("select", {}); entityOptions(toSel);
    row.appendChild(fromSel); row.appendChild(toSel);
    formCard.appendChild(row);

    const row2 = h("div", { class: "field-row" });
    const affinityInput = h("input", { type: "number", value: "0", min: "-10", max: "10", placeholder: "Affinity (-10 to 10)" });
    const notesInput = h("input", { type: "text", placeholder: "Notes, e.g. \u2018Owes a life debt\u2019" });
    row2.appendChild(affinityInput); row2.appendChild(notesInput);
    formCard.appendChild(row2);

    const addBtn = h("button", { class: "btn primary" }, "Add Relationship");
    addBtn.addEventListener("click", async () => {
      if (!fromSel.value || !toSel.value) { toast("Choose both sides of the relationship", "error"); return; }
      const [fromType, fromId, fromName] = fromSel.value.split(":");
      const [toType, toId, toName] = toSel.value.split(":");
      await db.relationships.add(campaignId, {
        fromType, fromId, fromName, toType, toId, toName,
        affinity: parseInt(affinityInput.value, 10) || 0,
        notes: notesInput.value.trim()
      });
      toast("Relationship added");
    });
    formCard.appendChild(addBtn);
  }

  function affinityLabel(v) {
    if (v >= 7) return { text: "Devoted", cls: "gold" };
    if (v >= 3) return { text: "Friendly", cls: "rune" };
    if (v >= -2) return { text: "Neutral", cls: "" };
    if (v >= -6) return { text: "Wary", cls: "" };
    return { text: "Hostile", cls: "" };
  }

  const unsubRel = db.relationships.subscribe(campaignId, (rels) => {
    wrap.innerHTML = "";
    if (rels.length === 0) { wrap.appendChild(h("p", {}, "No relationships tracked yet.")); return; }
    const table = h("div", { class: "card" });
    table.appendChild(h("h3", {}, "Relationship Web"));
    rels.forEach(rel => {
      const lbl = affinityLabel(rel.affinity);
      const row = h("div", { class: "inventory-item" });
      row.innerHTML = `
        <div class="row1">
          <div>
            <div class="item-name">${escapeHtml(rel.fromName)} \u2192 ${escapeHtml(rel.toName)} <span class="badge ${lbl.cls}">${lbl.text} (${rel.affinity >= 0 ? "+" : ""}${rel.affinity})</span></div>
            <div class="item-meta">${escapeHtml(rel.notes || "")}</div>
          </div>
        </div>
      `;
      const actions = h("div", { class: "row-actions" });
      const minus = h("button", { class: "btn sm" }, "\u2212 Affinity");
      const plus = h("button", { class: "btn sm" }, "+ Affinity");
      minus.addEventListener("click", () => db.relationships.update(campaignId, rel.id, { affinity: Math.max(-10, rel.affinity - 1) }));
      plus.addEventListener("click", () => db.relationships.update(campaignId, rel.id, { affinity: Math.min(10, rel.affinity + 1) }));
      const delBtn = h("button", { class: "btn sm ghost" }, "Remove");
      delBtn.addEventListener("click", () => db.relationships.remove(campaignId, rel.id));
      actions.appendChild(minus); actions.appendChild(plus); actions.appendChild(delBtn);
      row.appendChild(actions);
      table.appendChild(row);
    });
    wrap.appendChild(table);
  });

  const unsubParty = db.characters.subscribeCampaignParty(campaignId, (p) => { party = p; renderForm(); });
  const unsubNpcs = db.characters.subscribeCampaignNpcs(campaignId, (n) => { npcs = n; renderForm(); });
  renderForm();

  return () => { unsubRel(); unsubParty(); unsubNpcs(); };
}
