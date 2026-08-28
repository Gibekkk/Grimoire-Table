import { db, backendMode } from "../db.js";
import { h, toast } from "../util.js";

function d20Svg() {
  return `<svg class="d20-glow" viewBox="0 0 24 24" fill="none" stroke="#c69a3e" stroke-width="1.1">
    <path d="M12 2l9 5.2v9.6L12 22l-9-5.2V7.2L12 2z"/>
    <path d="M12 2v20M3 7.2l9 5 9-5M3 16.8l9-4.6 9 4.6M21 7.2l-9 5M21 16.8l-9-4.6"/>
  </svg>`;
}

export function renderLogin(root) {
  const wrap = h("div", { class: "login-hero" });
  wrap.innerHTML = `
    ${d20Svg()}
    <h1>Grimoire Table</h1>
    <p class="tagline">A digital table for your D&amp;D 2024 campaigns \u2014 build characters straight from the rules, roll physical dice together, and keep the party in sync in real time.</p>
  `;

  const card = h("div", { class: "card login-card" });

  if (backendMode === "firebase") {
    const btn = h("button", { class: "btn primary block" }, "Sign in with Google");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try { await db.auth.signInWithGoogle(); }
      catch (e) { toast(e.message || "Sign-in failed", "error"); btn.disabled = false; }
    });
    card.appendChild(btn);
  } else {
    card.innerHTML = `
      <p style="margin-top:0;">Firebase isn't configured yet, so you're in <strong>Demo Mode</strong>: data is saved to this browser (and synced live across tabs) so you can try every feature before connecting your own Firebase project.</p>
      <label for="demo-name">Your name</label>
      <input type="text" id="demo-name" placeholder="e.g. Alarik Stormwind" />
    `;
    const input = card.querySelector("#demo-name");
    const btn = h("button", { class: "btn primary block" }, "Enter the table");
    btn.addEventListener("click", async () => {
      const name = input.value.trim();
      if (!name) { toast("Enter a name first", "error"); return; }
      await db.auth.signInDemo(name);
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") btn.click(); });
    card.appendChild(btn);
  }

  wrap.appendChild(card);
  root.appendChild(wrap);
}
