export function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function h(tag, attrs = {}, children = "") {
  const el = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  });
  if (Array.isArray(children)) children.forEach(c => el.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
  else if (children instanceof Node) el.appendChild(children);
  else if (children != null) el.innerHTML = children;
  return el;
}

let toastWrap = null;
export function toast(message, type = "info") {
  if (!toastWrap) {
    toastWrap = document.createElement("div");
    toastWrap.className = "toast-wrap";
    document.body.appendChild(toastWrap);
  }
  const t = document.createElement("div");
  t.className = `toast ${type === "error" ? "error" : ""}`;
  t.textContent = message;
  toastWrap.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

export function timeAgo(ts) {
  const ms = typeof ts === "number" ? ts : (ts?.seconds ? ts.seconds * 1000 : Date.now());
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

// Small popup menu, positioned at a point. items: [{ label, action, danger? }] or "---" for a divider.
export function showContextMenu(x, y, items) {
  document.querySelector(".ctx-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  items.forEach(item => {
    if (item === "---") { menu.appendChild(h("div", { class: "ctx-menu-divider" })); return; }
    if (item.header) { menu.appendChild(h("div", { class: "ctx-menu-header" }, item.header)); return; }
    const btn = h("button", { class: item.danger ? "danger" : "" }, item.label);
    btn.addEventListener("click", () => { item.action(); menu.remove(); });
    menu.appendChild(btn);
  });
  document.body.appendChild(menu);
  const vw = window.innerWidth, vh = window.innerHeight;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, vw - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, vh - rect.height - 8)}px`;
  requestAnimationFrame(() => menu.classList.add("show"));
  const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("mousedown", close); } };
  setTimeout(() => document.addEventListener("mousedown", close), 0);
}

// Attaches left-click = normal roll, right-click = a menu offering Advantage/Disadvantage
// (and an optional custom action list, e.g. "Set Override…"). Used on every d20 roll target.
export function attachRollMenu(el, { onRoll, extraItems } = {}) {
  el.style.cursor = "pointer";
  el.addEventListener("click", () => onRoll?.("normal"));
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: "Roll Normal", action: () => onRoll?.("normal") },
      { label: "Roll Advantage", action: () => onRoll?.("advantage") },
      { label: "Roll Disadvantage", action: () => onRoll?.("disadvantage") },
      ...(extraItems?.length ? ["---", ...extraItems] : [])
    ]);
  });
}
