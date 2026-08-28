import { onAuthChange, getCurrentUser, isDemoMode, signOutUser } from "./auth.js";
import { initRouter, registerRoute, navigate } from "./router.js";
import { h } from "./util.js";

import { renderLogin } from "./views/login-view.js";
import { renderDashboard } from "./views/dashboard-view.js";
import { renderCharacterCreator } from "./views/character-creator-view.js";
import { renderCharacterSheetPage } from "./views/character-sheet-view.js";
import { renderCampaign } from "./views/campaign-view.js";

const appRoot = document.getElementById("app");
let shellBuilt = false;

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
  return `<svg class="d20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 2l9 5.2v9.6L12 22l-9-5.2V7.2L12 2z"/><path d="M12 2v20M3 7.2l9 5 9-5M3 16.8l9-4.6 9 4.6M12 12.2V2"/></svg>`;
}

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

  window.addEventListener("hashchange", updateActiveNav);
  updateActiveNav();

  return view;
}

function updateActiveNav() {
  const path = (location.hash || "#/dashboard").slice(1);
  document.querySelectorAll(".nav-link").forEach(a => {
    a.classList.toggle("active", a.getAttribute("href") === `#${path}` || (path.startsWith("/character/") && path !== "/character/new" && a.getAttribute("href") === "#/dashboard"));
  });
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
    shellBuilt = true;
  } else {
    shellBuilt = false;
    appRoot.innerHTML = "";
    renderLogin(appRoot);
  }
});
