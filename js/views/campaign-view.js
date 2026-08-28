import { db } from "../db.js";
import { getCurrentUser } from "../auth.js";
import { h, toast } from "../util.js";
import { navigate } from "../router.js";
import { mountTablePanel } from "./campaign/table-panel.js";
import { mountPartyPanel } from "./campaign/party-panel.js";
import { mountDmNotesPanel } from "./campaign/dm-notes-panel.js";

export async function renderCampaign(container, params) {
  const user = getCurrentUser();
  const campaign = await db.campaigns.get(params.id);
  if (!campaign) {
    container.innerHTML = `<div class="main"><div class="empty-state"><h3>Campaign not found</h3></div></div>`;
    return () => {};
  }
  const isDm = campaign.dmUid === user.uid;

  const wrap = h("div", { class: "main" });
  const backBtn = h("button", { class: "btn ghost sm" }, "\u2190 Dashboard");
  backBtn.addEventListener("click", () => navigate("/dashboard"));
  wrap.appendChild(backBtn);

  const header = h("div", { class: "card" });
  header.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
      <div>
        <h1 style="margin-bottom:4px;">${campaign.name}</h1>
        <span class="badge gold">Invite code: ${campaign.inviteCode}</span>
        ${isDm ? '<span class="badge rune" style="margin-left:6px;">You are the DM</span>' : ""}
      </div>
      <div id="members"></div>
    </div>
  `;
  const membersEl = header.querySelector("#members");
  Object.entries(campaign.memberNames || {}).forEach(([uid, name]) => {
    const chip = h("span", { class: "badge", style: "margin-left:6px;" }, uid === campaign.dmUid ? `${name} (DM)` : name);
    membersEl.appendChild(chip);
  });
  const copyBtn = h("button", { class: "btn sm", style: "margin-top:10px;" }, "Copy Invite Code");
  copyBtn.addEventListener("click", () => {
    navigator.clipboard?.writeText(campaign.inviteCode);
    toast("Invite code copied");
  });
  header.appendChild(copyBtn);
  wrap.appendChild(header);

  const tabs = h("div", { class: "tabs" });
  const tabDefs = [
    { id: "table", label: "Game Table" },
    { id: "party", label: "Party" }
  ];
  if (isDm) tabDefs.push({ id: "notes", label: "DM Notes" });
  const panelHost = h("div", {});

  let activeUnmount = null;
  let advMode = "normal";

  function activateTab(tabId) {
    [...tabs.children].forEach(t => t.classList.toggle("active", t.dataset.id === tabId));
    activeUnmount?.();
    panelHost.innerHTML = "";
    if (tabId === "table") {
      activeUnmount = mountTablePanel(panelHost, { campaignId: campaign.id, user, activeCharacterName: () => null, getActiveModifiers: () => ({}) });
    } else if (tabId === "party") {
      activeUnmount = mountPartyPanel(panelHost, { campaignId: campaign.id, getAdvMode: () => advMode });
    } else if (tabId === "notes") {
      activeUnmount = mountDmNotesPanel(panelHost, { campaignId: campaign.id });
    }
  }

  tabDefs.forEach((t, i) => {
    const btn = h("button", { class: `tab-btn ${i === 0 ? "active" : ""}` }, t.label);
    btn.dataset.id = t.id;
    btn.addEventListener("click", () => activateTab(t.id));
    tabs.appendChild(btn);
  });

  wrap.appendChild(tabs);
  wrap.appendChild(panelHost);
  container.appendChild(wrap);

  activateTab("table");

  return () => activeUnmount?.();
}
