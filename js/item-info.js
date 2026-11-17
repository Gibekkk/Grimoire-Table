// What any item the app knows about does: DMG magic items and the PHB's weapons,
// armor, adventuring gear, tools and ammunition. Shared by the Item Compendium page
// and anywhere an item is shown (monster loot), as an inline card or a popover.
import { h, escapeHtml } from "./util.js";

const GROUPS = [["weapons", "Weapon"], ["armor", "Armor"], ["gear", "Adventuring Gear"], ["tools", "Tool"], ["ammo", "Ammunition"]];
const key = (s) => String(s || "").toLowerCase().replace(/\(\d+\)/g, "").replace(/[^a-z0-9]/g, "");

// ref: a magic item id, a catalog id, or just a name ("Daggers (6)", "Leather Armor")
export function findItem(ruleset, ref = {}) {
  const magic = ruleset?.magicItems || [];
  const id = ref.magic?.id || ref.magicId;
  if (id) { const m = magic.find(x => x.id === id); if (m) return { kind: "magic", entry: m }; }
  const eq = ruleset?.equipment || {};
  for (const [g, label] of GROUPS) {
    const hit = (eq[g] || []).find(x => x.id === ref.catalogId);
    if (hit) return { kind: g, label, entry: hit };
  }
  const k = key(ref.name);
  if (!k) return null;
  const cands = [k, k.replace(/s$/, ""), k.replace(/es$/, "")];
  for (const c of cands) {
    for (const [g, label] of GROUPS) {
      const hit = (eq[g] || []).find(x => key(x.name) === c);
      if (hit) return { kind: g, label, entry: hit };
    }
    const m = magic.find(x => key(x.name) === c);
    if (m) return { kind: "magic", entry: m };
  }
  return null;
}

const para = (t) => String(t || "").split(/\n+/).filter(Boolean).map(p => `<p>${escapeHtml(p)}</p>`).join("");

// Card HTML for a found item (see findItem)
export function itemInfoHtml(ruleset, found) {
  if (!found) return `<p class="meta">No description for this item. It may be custom or homebrew.</p>`;
  const e = found.entry;
  const eq = ruleset?.equipment || {};
  const facts = [];
  let text = "";
  let sub = found.label || "";
  if (found.kind === "magic") {
    sub = [e.type, e.subtype ? `(${e.subtype})` : "", e.rarity, e.attunement ? `requires attunement${e.attunementBy ? ` ${e.attunementBy}` : ""}` : ""].filter(Boolean).join(", ");
    if (e.charges) facts.push(["Charges", e.charges]);
    text = para(e.description || e.summary);
  } else if (found.kind === "weapons") {
    sub = `${e.category === "martial" ? "Martial" : "Simple"} ${e.ranged ? "Ranged" : "Melee"} Weapon`;
    facts.push(["Damage", `${e.damageDice} ${e.damageType}`]);
    if (e.properties?.length) facts.push(["Properties", e.properties.join(", ")]);
    if (e.mastery) facts.push(["Mastery", e.mastery]);
    // What each property and the mastery mean (PHB definitions)
    const defs = (e.properties || []).map(p => p.replace(/\s*\(.*$/, "")).filter(p => eq.properties?.[p]).map(p => `<p><b>${escapeHtml(p)}.</b> ${escapeHtml(eq.properties[p])}</p>`);
    if (e.mastery && eq.masteries?.[e.mastery]) defs.push(`<p><b>${escapeHtml(e.mastery)} (mastery).</b> ${escapeHtml(eq.masteries[e.mastery])}</p>`);
    text = defs.join("");
  } else if (found.kind === "armor") {
    sub = e.armorType === "shield" ? "Shield" : `${e.armorType ? e.armorType[0].toUpperCase() + e.armorType.slice(1) : ""} Armor`;
    facts.push(["Armor Class", e.armorType === "shield" ? `+${e.baseAC || 2}` : `${e.baseAC}${e.dexBonus === "full" ? " + Dex modifier" : e.dexBonus === "max2" || e.dexBonus === 2 ? " + Dex modifier (max 2)" : ""}`]);
    if (e.strengthRequirement) facts.push(["Strength", e.strengthRequirement]);
    if (e.stealthDisadvantage) facts.push(["Stealth", "Disadvantage"]);
  } else {
    text = para(e.description);
    if (e.contents?.length) facts.push(["Contains", e.contents.map(c => typeof c === "string" ? c : `${c.name}${c.quantity > 1 ? ` (${c.quantity})` : ""}`).join(", ")]);
  }
  if (e.cost) facts.push(["Cost", e.cost]);
  if (e.weight) facts.push(["Weight", e.weight]);
  return `
    <div class="item-info-sub">${escapeHtml(sub)}</div>
    ${facts.length ? `<div class="item-info-facts">${facts.map(([k, v]) => `<span><b>${escapeHtml(k)}</b> ${escapeHtml(String(v))}</span>`).join("")}</div>` : ""}
    <div class="item-info-text">${text || (found.kind === "magic" ? "" : '<p class="meta">The Player\'s Handbook gives no further description.</p>')}</div>`;
}

// A popover card beside `anchor`; closes on Esc, a click elsewhere, or its ✕
let openPop = null;
export function showItemPopover(anchor, ruleset, ref) {
  openPop?.close();
  const found = findItem(ruleset, ref);
  const pop = h("div", { class: "item-pop", role: "dialog", "aria-label": ref.name || found?.entry?.name || "Item" });
  const title = found?.entry?.name || ref.name || "Item";
  const head = h("div", { class: "item-pop-head" }, `<b>${escapeHtml(title)}</b>`);
  const x = h("button", { class: "icon-btn", type: "button", title: "Close" }, "✕");
  head.appendChild(x);
  pop.appendChild(head);
  pop.appendChild(h("div", { class: "item-pop-body" }, itemInfoHtml(ruleset, found)));
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const w = Math.min(360, window.innerWidth - 16);
  pop.style.width = `${w}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  const below = r.bottom + 6, maxH = window.innerHeight - 16;
  pop.style.maxHeight = `${Math.min(420, maxH)}px`;
  const ph = Math.min(pop.offsetHeight, 420);
  pop.style.top = `${below + ph > window.innerHeight - 8 ? Math.max(8, r.top - ph - 6) : below}px`;
  const close = () => { pop.remove(); document.removeEventListener("mousedown", outside, true); document.removeEventListener("keydown", onKey, true); if (openPop?.pop === pop) openPop = null; };
  const outside = (e) => { if (!pop.contains(e.target) && e.target !== anchor) close(); };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  x.addEventListener("click", close);
  setTimeout(() => { document.addEventListener("mousedown", outside, true); document.addEventListener("keydown", onKey, true); }, 0);
  openPop = { pop, close };
  return close;
}
