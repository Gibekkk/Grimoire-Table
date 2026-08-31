import { db } from "../../db.js";
import { mountCharacterSheet } from "../../character-sheet.js";
import { h } from "../../util.js";

export function mountPartyPanel(container, { campaignId, user, isDm, getAdvMode, onRoll }) {
  const listCard = h("div", { class: "card" });
  listCard.appendChild(h("h3", {}, "Party"));
  const tabs = h("div", { class: "tabs" });
  listCard.appendChild(tabs);
  container.appendChild(listCard);

  const sheetHost = h("div", {});
  container.appendChild(sheetHost);

  let activeId = null;
  let sheetUnsub = null;
  let combat = null;

  // Lets the sheet auto-clear "Action" when this character attacks mid-combat,
  // satisfying the DM tools spec's action-economy auto-toggle for the one
  // unambiguous case (attacking clearly consumes your Action).
  function onAction(characterId, actionType) {
    if (!combat?.active) return;
    const idx = combat.combatants.findIndex(c => c.id === characterId);
    if (idx === -1 || idx !== combat.currentTurnIndex) return;
    const key = `${actionType}Used`;
    if (combat.combatants[idx][key]) return;
    const combatants = combat.combatants.map((c, i) => i === idx ? { ...c, [key]: true } : c);
    db.combat.set(campaignId, { combatants });
  }

  function openCharacter(id) {
    activeId = id;
    [...tabs.children].forEach(t => t.classList.toggle("active", t.dataset.id === id));
    sheetUnsub?.();
    sheetHost.innerHTML = "";
    mountCharacterSheet(sheetHost, id, {
      viewerUid: user.uid,
      isDm,
      getAdvMode,
      onAction: (actionType) => onAction(id, actionType),
      onRoll: onRoll || ((spec) => {
        import("../../dice/roll-logic.js").then(({ computeRoll }) => {
          const result = computeRoll({ ...spec, mode: getAdvMode?.() || spec.mode });
          db.log.add(campaignId, { type: "roll", uid: user.uid, displayName: user.displayName, label: spec.label, result });
        });
      })
    }).then(u => { sheetUnsub = u; });
  }

  const unsubParty = db.characters.subscribeCampaignParty(campaignId, (party) => {
    tabs.innerHTML = "";
    if (party.length === 0) {
      tabs.appendChild(h("p", {}, "No characters have joined this campaign yet. Share the invite code from the sidebar's \u22ee menu on one of your characters."));
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

  const unsubCombat = db.combat.subscribe(campaignId, (c) => { combat = c; });

  return () => { unsubParty(); unsubCombat(); sheetUnsub?.(); };
}
