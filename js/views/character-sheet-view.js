import { mountCharacterSheet } from "../character-sheet.js";
import { navigate } from "../router.js";
import { h } from "../util.js";

export async function renderCharacterSheetPage(container, params) {
  const wrap = h("div", { class: "main narrow" });
  const backBtn = h("button", { class: "btn ghost sm" }, "\u2190 Dashboard");
  backBtn.addEventListener("click", () => navigate("/dashboard"));
  wrap.appendChild(backBtn);
  const sheetHost = h("div", { style: "margin-top:14px;" });
  wrap.appendChild(sheetHost);
  container.appendChild(wrap);

  const unsub = await mountCharacterSheet(sheetHost, params.id, {
    showManageActions: true,
    onDelete: () => navigate("/dashboard"),
    onRoll: (spec) => {
      // Standalone page: quick client-side roll toast, no shared log.
      import("../dice/roll-logic.js").then(({ computeRoll, formatBreakdown }) => {
        const result = computeRoll(spec);
        import("../util.js").then(({ toast }) => {
          toast(`${spec.label}: ${result.total} ${formatBreakdown(result)}`);
        });
      });
    }
  });

  return () => unsub?.();
}
