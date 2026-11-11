// In-page dialogs used instead of alert / confirm / prompt. The browser's own dialogs
// freeze the page, can't be styled, and can't be answered from fullscreen (the browser
// leaves fullscreen or hides them). These sit above everything, fullscreen VTT included.
import { h, escapeHtml } from "./util.js";

// fields: [{ name, label, type: "text"|"number"|"select"|"checks", value, placeholder, min, max, step, options: [[value, label]] }]
// Resolves to { name: value, ... } (strings; an array of ticked values for "checks") on OK,
// or null on Cancel / Esc / click outside.
export function openDialog({ title = "", message = "", fields = [], okLabel = "OK", cancelLabel = "Cancel", danger = false } = {}) {
  return new Promise(resolve => {
    const overlay = h("div", { class: "modal-overlay dialog-overlay" });
    const box = h("form", { class: "modal-box dialog-box", role: "dialog", "aria-modal": "true", "aria-label": title || message.slice(0, 60) });
    if (title) box.appendChild(h("h3", { class: "dialog-title" }, escapeHtml(title)));
    if (message) box.appendChild(h("p", { class: "dialog-message" }, escapeHtml(message)));
    const inputs = {};
    fields.forEach(f => {
      const wrap = h("label", { class: "dialog-field" });
      if (f.label) wrap.appendChild(h("span", {}, escapeHtml(f.label)));
      let input;
      if (f.type === "checks") {
        // A group of checkboxes; `value` is the array ticked to start with
        input = h("div", { class: "dialog-checks" });
        input.getValue = () => [...input.querySelectorAll("input:checked")].map(el => el.value);
        if (!(f.options || []).length) input.appendChild(h("span", { class: "meta" }, escapeHtml(f.empty || "Nothing to choose from.")));
        (f.options || []).forEach(([v, l]) => {
          const row = h("label", { class: "dialog-check" });
          row.appendChild(h("input", { type: "checkbox", value: v, checked: (f.value || []).includes(v) ? "checked" : null }));
          row.appendChild(document.createTextNode(` ${l}`));
          input.appendChild(row);
        });
      } else if (f.type === "select") {
        input = h("select", { name: f.name });
        (f.options || []).forEach(([v, l]) => input.appendChild(h("option", { value: v, selected: String(v) === String(f.value) ? "selected" : null }, escapeHtml(l))));
      } else {
        input = h("input", { name: f.name, type: f.type || "text", value: f.value ?? "", placeholder: f.placeholder || null, min: f.min ?? null, max: f.max ?? null, step: f.step ?? null, autocomplete: "off" });
      }
      inputs[f.name] = input;
      wrap.appendChild(input);
      box.appendChild(wrap);
    });
    const row = h("div", { class: "dialog-buttons" });
    const cancel = h("button", { type: "button", class: "btn ghost" }, escapeHtml(cancelLabel));
    const ok = h("button", { type: "submit", class: `btn ${danger ? "danger" : "primary"}` }, escapeHtml(okLabel));
    row.appendChild(cancel); row.appendChild(ok);
    box.appendChild(row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(value);
    };
    // Captured first and stopped, so Esc here doesn't also close a panel or leave fullscreen
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(null); }
      else e.stopPropagation(); // typing in the dialog mustn't trigger VTT shortcuts
    };
    document.addEventListener("keydown", onKey, true);
    cancel.addEventListener("click", () => finish(null));
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) finish(null); });
    box.addEventListener("submit", (e) => {
      e.preventDefault();
      finish(Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.getValue ? el.getValue() : el.value])));
    });
    const first = Object.values(inputs).find(el => !el.getValue);
    setTimeout(() => { (first || ok).focus(); first?.select?.(); }, 0);
  });
}

export async function confirmDialog(message, { title = "Are you sure?", okLabel = "OK", danger = false } = {}) {
  return !!(await openDialog({ title, message, okLabel, danger }));
}

// Resolves to the entered string, or null when cancelled
export async function promptDialog(message, value = "", { title = "", type = "text", placeholder = "", okLabel = "OK", min, max } = {}) {
  const r = await openDialog({ title, message, okLabel, fields: [{ name: "value", type, value, placeholder, min, max }] });
  return r ? r.value : null;
}

// Several ways to answer; resolves to the chosen choice's value, or null when cancelled.
// choices: [{ value, label, primary?, danger? }]
export function chooseDialog({ title = "", message = "", choices = [], cancelLabel = "Cancel" } = {}) {
  return new Promise(resolve => {
    const overlay = h("div", { class: "modal-overlay dialog-overlay" });
    const box = h("div", { class: "modal-box dialog-box", role: "dialog", "aria-modal": "true", "aria-label": title || message.slice(0, 60) });
    if (title) box.appendChild(h("h3", { class: "dialog-title" }, escapeHtml(title)));
    if (message) box.appendChild(h("p", { class: "dialog-message" }, escapeHtml(message)));
    const row = h("div", { class: "dialog-buttons wrap" });
    let done = false;
    const finish = (v) => { if (done) return; done = true; document.removeEventListener("keydown", onKey, true); overlay.remove(); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(null); } else e.stopPropagation(); };
    const cancel = h("button", { type: "button", class: "btn ghost" }, escapeHtml(cancelLabel));
    cancel.addEventListener("click", () => finish(null));
    row.appendChild(cancel);
    choices.forEach(c => {
      const b = h("button", { type: "button", class: `btn ${c.danger ? "danger" : c.primary ? "primary" : ""}` }, escapeHtml(c.label));
      b.addEventListener("click", () => finish(c.value));
      row.appendChild(b);
    });
    box.appendChild(row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) finish(null); });
    setTimeout(() => (row.querySelector(".btn.primary") || cancel).focus(), 0);
  });
}
