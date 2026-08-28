import { db } from "../db.js";
import { getCurrentUser } from "../auth.js";
import { h, toast, timeAgo } from "../util.js";
import { navigate } from "../router.js";
import { loadRuleset, findById } from "../data-loader.js";

export async function renderDashboard(container) {
  const user = getCurrentUser();
  container.innerHTML = `<div class="spinner"></div>`;

  const [campaigns, characters, ruleset] = await Promise.all([
    db.campaigns.listMine(user.uid),
    db.characters.listMine(user.uid),
    loadRuleset()
  ]);

  container.innerHTML = "";
  container.appendChild(h("h1", {}, `Welcome, ${user.displayName}`));

  const grid = h("div", { class: "grid cols-2" });

  // --- Campaigns column ---
  const campaignsCard = h("div", { class: "card" });
  campaignsCard.appendChild(h("h2", {}, "Your Campaigns"));

  if (campaigns.length === 0) {
    campaignsCard.appendChild(h("p", {}, "No campaigns yet. Start one as DM, or join with an invite code."));
  } else {
    const list = h("ul", { class: "member-list" });
    campaigns.forEach(c => {
      const isDm = c.dmUid === user.uid;
      const li = h("li", {});
      li.innerHTML = `<span>${c.name} ${isDm ? '<span class="badge gold">DM</span>' : ""}</span>`;
      const btn = h("button", { class: "btn sm" }, "Open");
      btn.addEventListener("click", () => navigate(`/campaign/${c.id}`));
      li.appendChild(btn);
      list.appendChild(li);
    });
    campaignsCard.appendChild(list);
  }

  campaignsCard.appendChild(h("hr", { class: "divider" }));
  const createRow = h("div", { class: "field-row" });
  const nameInput = h("input", { type: "text", placeholder: "New campaign name" });
  const createBtn = h("button", { class: "btn primary" }, "Create");
  createBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) { toast("Name your campaign first", "error"); return; }
    createBtn.disabled = true;
    try {
      const id = await db.campaigns.create({ name, dmUid: user.uid, dmName: user.displayName });
      navigate(`/campaign/${id}`);
    } catch (e) { toast(e.message, "error"); createBtn.disabled = false; }
  });
  createRow.appendChild(nameInput);
  createRow.appendChild(createBtn);
  campaignsCard.appendChild(createRow);

  const joinRow = h("div", { class: "field-row" });
  const codeInput = h("input", { type: "text", placeholder: "Invite code", style: "text-transform:uppercase;" });
  const joinBtn = h("button", { class: "btn" }, "Join");
  joinBtn.addEventListener("click", async () => {
    const code = codeInput.value.trim();
    if (!code) { toast("Enter an invite code", "error"); return; }
    joinBtn.disabled = true;
    try {
      const id = await db.campaigns.join(code, user.uid, user.displayName);
      navigate(`/campaign/${id}`);
    } catch (e) { toast(e.message, "error"); joinBtn.disabled = false; }
  });
  joinRow.appendChild(codeInput);
  joinRow.appendChild(joinBtn);
  campaignsCard.appendChild(joinRow);

  grid.appendChild(campaignsCard);

  // --- Characters column ---
  const charsCard = h("div", { class: "card" });
  charsCard.appendChild(h("h2", {}, "Your Characters"));
  if (characters.length === 0) {
    charsCard.appendChild(h("p", {}, "No characters yet."));
  } else {
    const list = h("ul", { class: "member-list" });
    characters.forEach(c => {
      const cls = findById(ruleset.classes, c.classId);
      const li = h("li", {});
      li.innerHTML = `<span>${c.name} <span class="badge">Lvl ${c.level || 1} ${cls?.name || ""}</span></span>`;
      const btn = h("button", { class: "btn sm" }, "Open");
      btn.addEventListener("click", () => navigate(`/character/${c.id}`));
      li.appendChild(btn);
      list.appendChild(li);
    });
    charsCard.appendChild(list);
  }
  const newCharBtn = h("button", { class: "btn primary block", style: "margin-top:14px;" }, "+ Create Character");
  newCharBtn.addEventListener("click", () => navigate("/character/new"));
  charsCard.appendChild(newCharBtn);

  grid.appendChild(charsCard);
  container.appendChild(grid);
}
