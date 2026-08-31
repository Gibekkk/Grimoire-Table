import { db } from "../../db.js";
import { h, toast } from "../../util.js";
import { initiativeModifier, formatModifier } from "../../rules-engine.js";
import { computeRoll, formatBreakdown } from "../../dice/roll-logic.js";

// Watches campaign combat state for the lifetime of the campaign view and shows
// a roll-initiative modal whenever this user's own character is asked to roll,
// no matter which tab they currently have open.
export function mountInitiativeModal(campaignId, user, onLoggedRoll) {
  let overlay = null;
  let shownFor = null;

  function close() { overlay?.remove(); overlay = null; shownFor = null; }

  async function maybeShow(combat) {
    const req = combat?.pendingRollRequest;
    if (!req) { close(); return; }
    const combatant = combat.combatants.find(c => c.id === req.characterId);
    if (!combatant || combatant.ownerUid !== user.uid) { close(); return; }
    if (shownFor === req.characterId + req.requestedAt) return; // already showing this exact request
    close();
    shownFor = req.characterId + req.requestedAt;

    const character = await db.characters.get(req.characterId);
    if (!character) return;
    const mod = initiativeModifier(character);

    overlay = h("div", { class: "modal-overlay" });
    const box = h("div", { class: "modal-box" });
    box.innerHTML = `
      <h2 style="margin-top:0;">Roll Initiative!</h2>
      <p>${character.name}'s Initiative bonus is <strong>${formatModifier(mod)}</strong>.</p>
    `;
    const rollBtn = h("button", { class: "btn primary block" }, "Roll d20 for Initiative");
    rollBtn.addEventListener("click", async () => {
      const result = computeRoll({ sides: 20, count: 1, modifier: mod, mode: "normal", label: "Initiative" });
      const fresh = await db.combat.get(campaignId);
      if (!fresh) return;
      const combatants = fresh.combatants.map(c => c.id === req.characterId ? { ...c, initiative: result.total } : c);
      await db.combat.set(campaignId, { combatants, pendingRollRequest: null });
      onLoggedRoll?.({ type: "roll", uid: user.uid, displayName: character.name, label: "Initiative", result });
      toast(`Rolled ${result.total} (${formatBreakdown(result)})`);
      close();
    });
    box.appendChild(rollBtn);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  const unsub = db.combat.subscribe(campaignId, maybeShow);
  return () => { unsub(); close(); };
}
