import { db } from "../../db.js";
import { h, escapeHtml } from "../../util.js";
import { formatBreakdown } from "../../dice/roll-logic.js";
import { DiceTray } from "../../dice/dice-tray.js";

// Mounted once per campaign view, independent of which tab is active — so a
// roll from the Actions tab, an NPC attack, or an initiative check is just as
// visible to the whole table as one made from the Game Table's dice tray.
export function mountRollOverlay(campaignId) {
  const overlay = h("div", { class: "roll-3d-overlay" });
  const stage = h("div", { class: "roll-3d-stage" });
  overlay.appendChild(stage);
  document.body.appendChild(overlay);
  const tray = new DiceTray(stage);

  const notifyStack = h("div", { class: "roll-notify-stack" });
  document.body.appendChild(notifyStack);

  let isInitialLoad = true;
  const seenIds = new Set();
  let hideTimer = null;

  async function playOverlay(entry) {
    const r = entry.result;
    const diceList = r.isPercentile ? [{ sides: 10, count: 2 }] : [{ sides: r.sides, count: r.rawRolls.length }];
    clearTimeout(hideTimer);
    stage.querySelector(".roll-3d-result")?.remove();
    overlay.classList.add("show");
    await tray.roll(diceList, r.seed);
    const resultEl = h("div", { class: `roll-3d-result ${r.isCritHigh ? "crit-high" : ""} ${r.isCritLow ? "crit-low" : ""}` });
    resultEl.innerHTML = `
      <div class="who">${escapeHtml(entry.displayName)}</div>
      <div class="val">${r.total}</div>
      <div class="breakdown">${escapeHtml(entry.label || "")} \u2014 ${formatBreakdown(r)}${r.mode && r.mode !== "normal" ? ` (${r.mode})` : ""}</div>
    `;
    stage.appendChild(resultEl);
    hideTimer = setTimeout(() => { overlay.classList.remove("show"); }, 2800);
  }

  function showNotification(entry) {
    const r = entry.result;
    const card = h("div", { class: `roll-notify ${r.isCritHigh ? "crit-high" : ""} ${r.isCritLow ? "crit-low" : ""}` });
    card.innerHTML = `
      <div class="who">${escapeHtml(entry.displayName)}</div>
      <div class="what">${escapeHtml(entry.label || "Roll")}</div>
      <div class="result">${r.total}</div>
    `;
    notifyStack.appendChild(card);
    requestAnimationFrame(() => card.classList.add("show"));
    setTimeout(() => {
      card.classList.remove("show");
      setTimeout(() => card.remove(), 400);
    }, 4500);
  }

  const unsub = db.log.subscribe(campaignId, (entries) => {
    entries.forEach(entry => {
      if (entry.type === "roll" && !seenIds.has(entry.id) && !isInitialLoad) {
        playOverlay(entry);
        showNotification(entry);
      }
      seenIds.add(entry.id);
    });
    isInitialLoad = false;
  });

  return () => { unsub(); clearTimeout(hideTimer); tray.dispose(); overlay.remove(); notifyStack.remove(); };
}
