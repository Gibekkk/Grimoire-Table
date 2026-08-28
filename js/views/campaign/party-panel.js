import { db } from "../../db.js";
import { mountCharacterSheet } from "../../character-sheet.js";
import { h } from "../../util.js";

export function mountPartyPanel(container, { campaignId, getAdvMode }) {
  const listCard = h("div", { class: "card" });
  listCard.appendChild(h("h3", {}, "Party"));
  const tabs = h("div", { class: "tabs" });
  listCard.appendChild(tabs);
  container.appendChild(listCard);

  const sheetHost = h("div", {});
  container.appendChild(sheetHost);

  let activeId = null;
  let sheetUnsub = null;

  function openCharacter(id) {
    activeId = id;
    [...tabs.children].forEach(t => t.classList.toggle("active", t.dataset.id === id));
    sheetUnsub?.();
    sheetHost.innerHTML = "";
    mountCharacterSheet(sheetHost, id, {
      onRoll: (spec) => {
        import("../../dice/roll-logic.js").then(({ computeRoll, formatBreakdown }) => {
          const result = computeRoll({ ...spec, mode: getAdvMode?.() || spec.mode });
          db.log.add(campaignId, { type: "roll", uid: "sheet", displayName: "Sheet Roll", label: spec.label, result });
        });
      }
    }).then(u => { sheetUnsub = u; });
  }

  const unsubParty = db.characters.subscribeCampaignParty(campaignId, (party) => {
    tabs.innerHTML = "";
    if (party.length === 0) {
      tabs.appendChild(h("p", {}, "No characters have joined this campaign yet. Share the invite code from a character sheet's Manage panel."));
      sheetHost.innerHTML = "";
      return;
    }
    party.forEach(c => {
      const tab = h("button", { class: `tab-btn ${c.id === activeId ? "active" : ""}` }, `${c.name} (Lv${c.level || 1})`);
      tab.dataset.id = c.id;
      tab.addEventListener("click", () => openCharacter(c.id));
      tabs.appendChild(tab);
    });
    if (!activeId) openCharacter(party[0].id);
  });

  return () => { unsubParty(); sheetUnsub?.(); };
}
