import { db } from "../../db.js";
import { h, escapeHtml, timeAgo } from "../../util.js";
import { computeRoll, formatBreakdown, parseNotation } from "../../dice/roll-logic.js";

const DIE_TYPES = [4, 6, 8, 10, 12, 20, 100];

// The 3D animation + notification for every roll now live in roll-overlay.js,
// mounted once per campaign so they show up regardless of which tab is active.
// This panel only needs the controls to start a roll and the text history.
export function mountTablePanel(container, { campaignId, user, activeCharacterName }) {
  let advMode = "normal"; // normal | advantage | disadvantage
  let customModifier = 0;

  const wrap = h("div", { class: "two-col" });
  const left = h("div", {});

  const controlsCard = h("div", { class: "card" });
  controlsCard.appendChild(h("h3", {}, "Roll Dice"));

  const dieRow = h("div", { class: "dice-controls" });
  DIE_TYPES.forEach(sides => {
    const btn = h("button", { class: "die-btn" }, `<span>d${sides}</span>`);
    btn.addEventListener("click", () => {
      if (sides === 100) doRoll({ isPercentile: true, modifier: customModifier, mode: "normal", label: "d100" });
      else doRoll({ sides, count: 1, modifier: customModifier, mode: advMode, label: `d${sides}` });
    });
    dieRow.appendChild(btn);
  });
  controlsCard.appendChild(dieRow);

  const modRow = h("div", { class: "field-row", style: "margin-top:12px; align-items:flex-end;" });
  const modWrap = h("div", {});
  modWrap.appendChild(h("label", {}, "Modifier"));
  const modInput = h("input", { type: "number", value: "0" });
  modInput.addEventListener("input", () => { customModifier = parseInt(modInput.value, 10) || 0; });
  modWrap.appendChild(modInput);
  modRow.appendChild(modWrap);

  const advWrap = h("div", {});
  advWrap.appendChild(h("label", {}, "d20 Tests"));
  const advToggle = h("div", { class: "adv-toggle" });
  const normalBtn = h("button", { class: "active" }, "Normal");
  const advBtn = h("button", {}, "Advantage");
  const disBtn = h("button", {}, "Disadvantage");
  [[normalBtn, "normal"], [advBtn, "advantage"], [disBtn, "disadvantage"]].forEach(([btn, mode]) => {
    btn.addEventListener("click", () => {
      advMode = mode;
      [normalBtn, advBtn, disBtn].forEach(b => b.classList.remove("active", "adv", "dis"));
      btn.classList.add("active", mode === "advantage" ? "adv" : mode === "disadvantage" ? "dis" : "");
    });
  });
  advToggle.appendChild(normalBtn); advToggle.appendChild(advBtn); advToggle.appendChild(disBtn);
  advWrap.appendChild(advToggle);
  modRow.appendChild(advWrap);
  controlsCard.appendChild(modRow);

  const customCard = h("div", { style: "margin-top:14px;" });
  customCard.appendChild(h("label", {}, "Custom Roll"));
  const customRow = h("div", { class: "field-row" });
  const customCountInput = h("input", { type: "number", value: "1", min: "1", max: "20", style: "max-width:70px;" });
  const customDieSelect = h("select", { style: "max-width:90px;" });
  DIE_TYPES.forEach(s => customDieSelect.appendChild(h("option", { value: s }, `d${s}`)));
  const customRollBtn = h("button", { class: "btn primary" }, "Roll Custom");
  customRollBtn.addEventListener("click", () => {
    const sides = parseInt(customDieSelect.value, 10);
    const count = Math.max(1, Math.min(20, parseInt(customCountInput.value, 10) || 1));
    if (sides === 100) { doRoll({ isPercentile: true, modifier: customModifier, mode: "normal", label: `${count > 1 ? count + "x " : ""}d100` }); return; }
    doRoll({ sides, count, modifier: customModifier, mode: advMode, label: `${count}d${sides}` });
  });
  customRow.appendChild(customCountInput); customRow.appendChild(customDieSelect); customRow.appendChild(customRollBtn);
  customCard.appendChild(customRow);
  controlsCard.appendChild(customCard);

  const notationRow = h("div", { class: "field-row" });
  const notationInput = h("input", { type: "text", placeholder: "Or type notation, e.g. 2d6+3" });
  const notationBtn = h("button", { class: "btn" }, "Roll");
  notationBtn.addEventListener("click", () => {
    const parsed = parseNotation(notationInput.value);
    if (!parsed) { import("../../util.js").then(({ toast }) => toast("Format like 2d6+3", "error")); return; }
    doRoll({ ...parsed, mode: advMode, label: notationInput.value });
  });
  notationRow.appendChild(notationInput); notationRow.appendChild(notationBtn);
  controlsCard.appendChild(notationRow);
  controlsCard.appendChild(h("p", { class: "hint", style: "margin-top:10px;" }, "Every roll shows for the whole table as an overlay \u2014 check any tab."));

  left.appendChild(controlsCard);

  // ---- Right: text log (history you can scroll back through) ----
  const right = h("div", { class: "card log-panel" });
  right.appendChild(h("h3", {}, "Game Log"));
  const logScroll = h("div", { class: "log-scroll" });
  right.appendChild(logScroll);
  const chatRow = h("div", { class: "log-input-row" });
  const chatInput = h("input", { type: "text", placeholder: "Say something to the table\u2026" });
  const chatBtn = h("button", { class: "btn sm" }, "Send");
  const sendChat = async () => {
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = "";
    await db.log.add(campaignId, { type: "chat", uid: user.uid, displayName: user.displayName, text });
  };
  chatBtn.addEventListener("click", sendChat);
  chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
  chatRow.appendChild(chatInput); chatRow.appendChild(chatBtn);
  right.appendChild(chatRow);

  wrap.appendChild(left);
  wrap.appendChild(right);
  container.appendChild(wrap);

  async function doRoll(spec) {
    const result = computeRoll(spec);
    await db.log.add(campaignId, {
      type: "roll", uid: user.uid, displayName: activeCharacterName?.() || user.displayName,
      label: spec.label, result
    });
  }

  const unsubLog = db.log.subscribe(campaignId, (entries) => {
    logScroll.innerHTML = "";
    entries.forEach(entry => {
      const el = h("div", { class: `log-entry ${entry.type === "roll" ? "roll" : ""} ${entry.result?.isCritHigh ? "crit-high" : ""} ${entry.result?.isCritLow ? "crit-low" : ""}` });
      const timeLabel = timeAgo(entry.createdAt);
      if (entry.type === "roll") {
        el.innerHTML = `<span class="time">${timeLabel}</span><div class="who">${escapeHtml(entry.displayName)} \u2014 ${escapeHtml(entry.label || "")}</div><div class="result">${entry.result.total} <span style="font-size:0.7rem; color:var(--text-dim);">${formatBreakdown(entry.result)}${entry.result.mode !== "normal" ? ` (${entry.result.mode})` : ""}</span></div>`;
      } else {
        el.innerHTML = `<span class="time">${timeLabel}</span><div class="who">${escapeHtml(entry.displayName)}</div><div>${escapeHtml(entry.text)}</div>`;
      }
      logScroll.appendChild(el);
    });
    logScroll.scrollTop = logScroll.scrollHeight;
  });

  return () => { unsubLog(); };
}
