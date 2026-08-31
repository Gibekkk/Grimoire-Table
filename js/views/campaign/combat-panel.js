import { db } from "../../db.js";
import { h, toast, escapeHtml } from "../../util.js";
import { initiativeModifier, formatModifier, ACTION_ECONOMY_TYPES } from "../../rules-engine.js";
import { computeRoll, formatBreakdown } from "../../dice/roll-logic.js";

const ACTION_LABELS = { action: "Action", bonusAction: "Bonus Action", reaction: "Reaction", movement: "Movement" };

function portraitOrInitial(entity) {
  return entity.portraitBase64 ? `<img src="${entity.portraitBase64}">` : `<span>${escapeHtml((entity.name || "?")[0].toUpperCase())}</span>`;
}

export function mountCombatPanel(container, { campaignId, user, isDm, campaignLog }) {
  let party = [], npcs = [], combat = null;
  const wrap = h("div", {});
  container.appendChild(wrap);

  async function startCombatSetup() {
    const setupCard = h("div", { class: "card" });
    setupCard.appendChild(h("h3", {}, "Start Combat"));
    setupCard.appendChild(h("p", {}, "Choose who's rolling into this fight."));
    const grid = h("div", { class: "grid cols-3" });
    const checks = [];
    [...party, ...npcs].forEach(entity => {
      const id = `combatant-${entity.id}`;
      const card = h("label", { class: "choice-card", style: "display:flex; align-items:center; gap:8px; cursor:pointer;" });
      const check = h("input", { type: "checkbox", id, style: "width:auto; margin:0;", checked: "checked" });
      checks.push({ check, entity });
      card.appendChild(check);
      card.appendChild(document.createTextNode(`${entity.name} ${entity.isNpc ? "(NPC)" : ""}`));
      grid.appendChild(card);
    });
    setupCard.appendChild(grid);
    const startBtn = h("button", { class: "btn primary", style: "margin-top:14px;" }, "Roll Initiative & Begin");
    startBtn.addEventListener("click", async () => {
      const combatants = checks.filter(c => c.check.checked).map(c => ({
        id: c.entity.id, type: c.entity.isNpc ? "npc" : "pc", name: c.entity.name,
        portraitBase64: c.entity.portraitBase64 || null, ownerUid: c.entity.ownerUid,
        initiative: null, actionUsed: false, bonusActionUsed: false, reactionUsed: false, movementUsed: false
      }));
      if (combatants.length === 0) { toast("Select at least one combatant", "error"); return; }
      await db.combat.set(campaignId, { active: true, round: 1, currentTurnIndex: 0, combatants, pendingRollRequest: null });
      toast("Combat started \u2014 roll initiative for everyone below.");
    });
    setupCard.appendChild(startBtn);
    return setupCard;
  }

  function rollForNpc(index) {
    const c = combat.combatants[index];
    const npc = npcs.find(n => n.id === c.id);
    if (!npc) return;
    const mod = initiativeModifier(npc);
    const result = computeRoll({ sides: 20, count: 1, modifier: mod, mode: "normal", label: `${c.name} Initiative` });
    const combatants = [...combat.combatants];
    combatants[index] = { ...c, initiative: result.total };
    db.combat.set(campaignId, { combatants });
    campaignLog?.({ type: "roll", uid: "dm", displayName: c.name, label: "Initiative", result });
  }

  function requestPcRoll(index) {
    const c = combat.combatants[index];
    db.combat.set(campaignId, { pendingRollRequest: { characterId: c.id, requestedAt: Date.now() } });
    toast(`Waiting for ${c.name}'s player to roll\u2026`);
  }

  function renderTurnOrder() {
    const sorted = [...combat.combatants].map((c, i) => ({ ...c, _idx: i })).sort((a, b) => (b.initiative ?? -999) - (a.initiative ?? -999));
    const card = h("div", { class: "card" });
    const headerRow = h("div", { style: "display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;" });
    headerRow.innerHTML = `<h3 style="margin:0;">Round ${combat.round}</h3>`;
    if (isDm) {
      const endBtn = h("button", { class: "btn sm danger" }, "End Combat");
      endBtn.addEventListener("click", () => db.combat.set(campaignId, { active: false }));
      headerRow.appendChild(endBtn);
    }
    card.appendChild(headerRow);

    sorted.forEach((c) => {
      const isCurrent = c._idx === combat.currentTurnIndex;
      const row = h("div", { class: "inventory-item", style: isCurrent ? "border-color:var(--gold); box-shadow:0 0 0 1px var(--gold) inset;" : "" });
      row.innerHTML = `
        <div class="row1">
          <div style="display:flex; align-items:center; gap:10px;">
            <div class="portrait-preview sm">${portraitOrInitial(c)}</div>
            <div>
              <div class="item-name">${isCurrent ? "\u25b6 " : ""}${escapeHtml(c.name)} ${c.type === "npc" ? '<span class="badge rune">NPC</span>' : ""}</div>
              <div class="item-meta">Initiative: ${c.initiative != null ? c.initiative : "pending"}</div>
            </div>
          </div>
        </div>
      `;
      if (isDm && c.initiative == null) {
        const actions = h("div", { class: "row-actions" });
        const btn = h("button", { class: "btn sm" }, c.type === "npc" ? "Roll for NPC" : "Request Player Roll");
        btn.addEventListener("click", () => c.type === "npc" ? rollForNpc(c._idx) : requestPcRoll(c._idx));
        actions.appendChild(btn);
        row.appendChild(actions);
      }
      if (isCurrent) {
        const canControl = isDm || c.ownerUid === user.uid;
        const actionRow = h("div", { class: "row-actions", style: "margin-top:8px; width:100%;" });
        ACTION_ECONOMY_TYPES.forEach(type => {
          const used = c[`${type}Used`];
          const btn = h("button", { class: `btn sm ${used ? "" : "primary"}` }, `${ACTION_LABELS[type]}: ${used ? "Used" : "Available"}`);
          if (canControl) btn.addEventListener("click", () => toggleAction(c._idx, type));
          else btn.disabled = true;
          actionRow.appendChild(btn);
        });
        if (canControl) {
          const endTurnBtn = h("button", { class: "btn sm danger" }, "End Turn");
          endTurnBtn.addEventListener("click", () => endTurn());
          actionRow.appendChild(endTurnBtn);
        }
        row.appendChild(actionRow);
      }
      card.appendChild(row);
    });
    return card;
  }

  function toggleAction(idx, type) {
    const combatants = [...combat.combatants];
    combatants[idx] = { ...combatants[idx], [`${type}Used`]: !combatants[idx][`${type}Used`] };
    db.combat.set(campaignId, { combatants });
  }

  function endTurn() {
    const n = combat.combatants.length;
    let nextIndex = (combat.currentTurnIndex + 1) % n;
    let nextRound = combat.round + (nextIndex === 0 ? 1 : 0);
    const combatants = combat.combatants.map((c, i) => i === nextIndex ? { ...c, actionUsed: false, bonusActionUsed: false, reactionUsed: false, movementUsed: false } : c);
    db.combat.set(campaignId, { currentTurnIndex: nextIndex, round: nextRound, combatants });
  }

  async function render() {
    wrap.innerHTML = "";
    if (!combat?.active) {
      if (isDm) wrap.appendChild(await startCombatSetup());
      else wrap.appendChild(h("div", { class: "empty-state" }, "<h3>No active combat</h3><p>Waiting for the DM to start one.</p>"));
      return;
    }
    wrap.appendChild(renderTurnOrder());
  }

  const unsubCombat = db.combat.subscribe(campaignId, (c) => { combat = c; render(); });
  const unsubParty = db.characters.subscribeCampaignParty(campaignId, (p) => { party = p; if (!combat?.active) render(); });
  const unsubNpcs = db.characters.subscribeCampaignNpcs(campaignId, (n) => { npcs = n; if (!combat?.active) render(); });

  return () => { unsubCombat(); unsubParty(); unsubNpcs(); };
}
