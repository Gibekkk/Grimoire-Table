import { onAuthChange, getCurrentUser, isDemoMode, signOutUser } from "./auth.js";
import { initRouter, registerRoute, navigate } from "./router.js";
import { h, showContextMenu, toast } from "./util.js";
import { db } from "./db.js";

import { renderLogin } from "./views/login-view.js";
import { renderDashboard } from "./views/dashboard-view.js";
import { renderCharacterCreator } from "./views/character-creator-view.js";
import { renderCharacterSheetPage } from "./views/character-sheet-view.js";
import { renderCampaign } from "./views/campaign-view.js";

const appRoot = document.getElementById("app");

const NAV_ITEMS = [
  { path: "/dashboard", label: "Dashboard", icon: iconHome() },
  { path: "/character/new", label: "New Character", icon: iconPlus() }
];

function iconHome() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>`;
}
function iconPlus() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>`;
}
function iconD20() {
  return `<svg class="d20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 2l9 5.2v9.6L12 22l-9-5.2V7.2L12 2z"/><path d="M12 2v20M3 7.2l9 5 9-5M3 16.8l9-4.6 9 4.6M21 7.2l-9 5M21 16.8l-9-4.6"/></svg>`;
}

let charListEl = null;
let campaignListEl = null;

function buildShell() {
  appRoot.innerHTML = "";
  const sidebar = h("aside", { class: "sidebar" });
  sidebar.innerHTML = `<div class="brand">${iconD20()} Grimoire Table</div>`;

  const nav = h("nav", {});
  NAV_ITEMS.forEach(item => {
    const link = h("a", { class: "nav-link", href: `#${item.path}` }, `${item.icon} <span>${item.label}</span>`);
    link.style.display = "flex";
    nav.appendChild(link);
  });
  sidebar.appendChild(nav);

  sidebar.appendChild(h("div", { class: "section-label" }, "Your Campaigns"));
  campaignListEl = h("div", {});
  sidebar.appendChild(campaignListEl);

  sidebar.appendChild(h("div", { class: "section-label" }, "Your Characters"));
  charListEl = h("div", {});
  sidebar.appendChild(charListEl);

  sidebar.appendChild(h("div", { class: "spacer" }));

  const user = getCurrentUser();
  const userChip = h("div", { class: "user-chip" });
  userChip.innerHTML = `
    ${user?.photoURL ? `<img src="${user.photoURL}" alt="">` : `<div class="icon-btn" style="pointer-events:none">${(user?.displayName || "?")[0]}</div>`}
    <div style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${user?.displayName || "Adventurer"}</div>
  `;
  if (isDemoMode()) {
    const badge = h("span", { class: "demo-badge" }, "DEMO");
    userChip.appendChild(badge);
  }
  sidebar.appendChild(userChip);
  const signOutBtn = h("button", { class: "btn ghost sm block", style: "margin-top:8px;" }, "Sign out");
  signOutBtn.addEventListener("click", async () => { await signOutUser(); });
  sidebar.appendChild(signOutBtn);

  const main = h("main", { class: "main" });
  const view = h("div", { id: "view" });
  main.appendChild(view);

  const shell = h("div", { class: "shell" }, [sidebar, main]);
  appRoot.appendChild(shell);

  window.addEventListener("hashchange", () => { updateActiveNav(); refreshSidebarCharacters(); refreshSidebarCampaigns(); });
  updateActiveNav();
  refreshSidebarCharacters();
  refreshSidebarCampaigns();

  return view;
}

function updateActiveNav() {
  const path = (location.hash || "#/dashboard").slice(1);
  document.querySelectorAll(".nav-link, .char-link, .campaign-link").forEach(a => {
    a.classList.toggle("active", a.getAttribute("href") === `#${path}`);
  });
}

async function refreshSidebarCampaigns() {
  if (!campaignListEl) return;
  const user = getCurrentUser();
  if (!user) return;
  const campaigns = await db.campaigns.listMine(user.uid);
  campaignListEl.innerHTML = "";
  if (campaigns.length === 0) {
    campaignListEl.appendChild(h("div", { class: "char-link", style: "opacity:0.6; cursor:default;" }, "No campaigns yet"));
  } else {
    campaigns.forEach(c => {
      const isDm = c.dmUid === user.uid;
      const row = h("div", { class: "char-row" });
      const link = h("a", { class: "campaign-link char-link", href: `#/campaign/${c.id}` });
      link.innerHTML = `<span>${c.name}</span>${isDm ? '<span class="lvl">DM</span>' : ""}`;
      row.appendChild(link);
      const kebab = h("button", { class: "char-kebab", title: "Manage campaign" }, "\u22ee");
      kebab.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        const rect = kebab.getBoundingClientRect();
        showContextMenu(rect.right, rect.top, buildCampaignMenu(c, isDm));
      });
      row.appendChild(kebab);
      campaignListEl.appendChild(row);
    });
  }
  updateActiveNav();
}

function buildCampaignMenu(c, isDm) {
  const items = [{ label: "Open", action: () => navigate(`/campaign/${c.id}`) }];
  items.push({
    label: "Copy Invite Code", action: () => { navigator.clipboard?.writeText(c.inviteCode); toast("Invite code copied"); }
  });
  if (isDm) {
    items.push("---");
    items.push({
      label: "Delete Campaign", danger: true, action: async () => {
        if (!confirm(`Delete "${c.name}"? This removes all maps, NPCs, logs, and notes. Player characters are unlinked, not deleted. This can't be undone.`)) return;
        await db.campaigns.remove(c.id);
        toast(`${c.name} deleted`);
        if (location.hash === `#/campaign/${c.id}`) navigate("/dashboard");
        refreshSidebarCampaigns();
        refreshSidebarCharacters();
      }
    });
  }
  return items;
}

async function refreshSidebarCharacters() {
  if (!charListEl) return;
  const user = getCurrentUser();
  if (!user) return;
  const characters = await db.characters.listMine(user.uid);
  charListEl.innerHTML = "";
  if (characters.length === 0) {
    charListEl.appendChild(h("div", { class: "char-link", style: "opacity:0.6; cursor:default;" }, "No characters yet"));
  } else {
    characters.forEach(c => {
      const row = h("div", { class: "char-row" });
      const link = h("a", { class: "char-link", href: `#/character/${c.id}` });
      link.innerHTML = `<span>${c.campaignId ? '<span class="campaign-dot" title="In a campaign"></span> ' : ""}${c.name}</span><span class="lvl">Lv${c.level || 1}</span>`;
      row.appendChild(link);
      const kebab = h("button", { class: "char-kebab", title: "Manage character" }, "\u22ee");
      kebab.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        const rect = kebab.getBoundingClientRect();
        showContextMenu(rect.right, rect.top, buildCharacterMenu(c));
      });
      row.appendChild(kebab);
      charListEl.appendChild(row);
    });
  }
  updateActiveNav();
}

function buildCharacterMenu(c) {
  const items = [];
  if (c.campaignId) {
    items.push({ label: "Quit Campaign", action: async () => { await db.characters.update(c.id, { campaignId: null }); toast(`${c.name} left the campaign`); refreshSidebarCharacters(); } });
  } else {
    items.push({
      label: "Join Campaign\u2026", action: async () => {
        const code = prompt("Campaign invite code:");
        if (!code) return;
        try {
          const campId = await db.campaigns.join(code.trim(), c.ownerUid, c.ownerName);
          await db.characters.update(c.id, { campaignId: campId });
          toast(`${c.name} joined the campaign`);
          refreshSidebarCharacters();
        } catch (e) { toast(e.message, "error"); }
      }
    });
  }
  items.push("---");
  items.push({
    label: "Delete Character", danger: true, action: async () => {
      if (!confirm(`Delete ${c.name}? This can't be undone.`)) return;
      await db.characters.remove(c.id);
      toast(`${c.name} deleted`);
      if (location.hash === `#/character/${c.id}`) navigate("/dashboard");
      refreshSidebarCharacters();
    }
  });
  return items;
}

function registerAllRoutes() {
  registerRoute("/dashboard", { render: renderDashboard });
  registerRoute("/character/new", { render: renderCharacterCreator });
  registerRoute("/character/:id", { render: renderCharacterSheetPage });
  registerRoute("/campaign/:id", { render: renderCampaign });
}

let routesRegistered = false;

onAuthChange((user) => {
  if (user) {
    const view = buildShell();
    if (!routesRegistered) { registerAllRoutes(); routesRegistered = true; }
    initRouter(view);
  } else {
    charListEl = null;
    appRoot.innerHTML = "";
    renderLogin(appRoot);
  }
});
