import { mountCharacterSheet } from "../character-sheet.js";
import { navigate } from "../router.js";
import { h, toast } from "../util.js";
import { getCurrentUser } from "../auth.js";
import { db } from "../db.js";

export async function renderCharacterSheetPage(container, params) {
  const wrap = h("div", { class: "main" });
  const backBtn = h("button", { class: "btn ghost sm" }, "\u2190 Dashboard");
  backBtn.addEventListener("click", () => navigate("/dashboard"));
  wrap.appendChild(backBtn);
  const sheetHost = h("div", { style: "margin-top:14px;" });
  wrap.appendChild(sheetHost);
  container.appendChild(wrap);

  const user = getCurrentUser();
  const character = await db.characters.get(params.id);
  if (!character) {
    sheetHost.innerHTML = `<div class="empty-state"><h3>Character not found</h3></div>`;
    return () => {};
  }
  let isDm = false;
  if (character.campaignId) {
    const campaign = await db.campaigns.get(character.campaignId);
    isDm = campaign?.dmUid === user.uid;
  }

  const unsub = await mountCharacterSheet(sheetHost, params.id, {
    viewerUid: user.uid,
    isDm,
    onRoll: (spec) => {
      import("../dice/roll-logic.js").then(({ computeRoll, formatBreakdown }) => {
        const result = computeRoll(spec);
        toast(`${spec.label}: ${result.total} ${formatBreakdown(result)}`);
      });
    }
  });

  return () => unsub?.();
}
