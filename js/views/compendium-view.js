// Item Compendium: every magic item (DMG 2024) and every weapon, armor, piece of gear,
// tool and ammunition (PHB 2024) with its description, open to everyone using the site.
import { h, escapeHtml } from "../util.js";
import { loadRuleset } from "../data-loader.js";
import { itemInfoHtml } from "../item-info.js";

const RARITIES = ["Common", "Uncommon", "Rare", "Very Rare", "Legendary", "Artifact"];
const TABS = [["magic", "Magic Items"], ["weapons", "Weapons"], ["armor", "Armor"], ["gear", "Adventuring Gear"], ["tools", "Tools"], ["ammo", "Ammunition"], ["rules", "Weapon Properties"]];
const PAGE = 60;

export async function renderCompendium(container) {
  const ruleset = await loadRuleset();
  const eq = ruleset.equipment || {};
  const main = h("div", { class: "main compendium" });
  main.appendChild(h("h1", {}, "Item Compendium"));
  main.appendChild(h("p", { class: "meta" }, "Every magic item from the 2024 Dungeon Master's Guide and all the weapons, armor, gear and tools from the 2024 Player's Handbook. Click an item to read what it does."));
  const tabs = h("div", { class: "tabs" });
  const controls = h("div", { class: "compendium-controls" });
  const list = h("div", { class: "compendium-list" });
  const more = h("button", { class: "btn ghost", type: "button" }, "Show more");
  main.appendChild(tabs); main.appendChild(controls); main.appendChild(list); main.appendChild(more);
  container.appendChild(main);

  let tab = "magic", shown = PAGE;
  const open = new Set();
  try { tab = sessionStorage.getItem("gt_compendium_tab") || "magic"; } catch { /* noop */ }
  const search = h("input", { type: "search", placeholder: "Search by name or text…", "aria-label": "Search items" });
  const rarity = h("select", { "aria-label": "Rarity" });
  rarity.appendChild(h("option", { value: "" }, "Any rarity"));
  RARITIES.forEach(r => rarity.appendChild(h("option", { value: r }, r)));
  const type = h("select", { "aria-label": "Type" });
  type.appendChild(h("option", { value: "" }, "Any type"));
  [...new Set((ruleset.magicItems || []).map(m => m.type).filter(Boolean))].sort().forEach(t => type.appendChild(h("option", { value: t }, t)));
  const attune = h("select", { "aria-label": "Attunement" });
  [["", "Attunement: any"], ["yes", "Requires attunement"], ["no", "No attunement"]].forEach(([v, l]) => attune.appendChild(h("option", { value: v }, l)));
  const count = h("span", { class: "meta" });
  [search, rarity, type, attune, count].forEach(el => controls.appendChild(el));

  function rows() {
    const q = search.value.trim().toLowerCase();
    const match = (...parts) => !q || parts.some(p => String(p || "").toLowerCase().includes(q));
    if (tab === "magic") {
      return (ruleset.magicItems || [])
        .filter(m => (!rarity.value || (m.rarity || "").startsWith(rarity.value)) && (!type.value || m.type === type.value) && (!attune.value || !!m.attunement === (attune.value === "yes")))
        .filter(m => match(m.name, m.description, m.type))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(m => ({ id: `magic:${m.id}`, name: m.name, meta: `${m.type || ""}${m.rarity ? ` • ${m.rarity}` : ""}${m.attunement ? " • attunement" : ""}`, rarity: m.rarity, found: { kind: "magic", entry: m } }));
    }
    if (tab === "rules") {
      return [...Object.entries(eq.properties || {}).map(([k, v]) => ({ id: `p:${k}`, name: k, meta: "Weapon property", text: v })),
        ...Object.entries(eq.masteries || {}).map(([k, v]) => ({ id: `m:${k}`, name: k, meta: "Mastery property", text: v }))]
        .filter(r => match(r.name, r.text));
    }
    const label = TABS.find(t => t[0] === tab)[1];
    return (eq[tab] || []).filter(e => match(e.name, e.description, (e.properties || []).join(" ")))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => ({ id: `${tab}:${e.id}`, name: e.name, meta: [e.cost, e.weight, e.damageDice && `${e.damageDice} ${e.damageType}`, e.baseAC && `AC ${e.baseAC}`].filter(Boolean).join(" • "), found: { kind: tab, label, entry: e } }));
  }

  function draw() {
    [...tabs.children].forEach(b => b.classList.toggle("active", b.dataset.id === tab));
    [rarity, type, attune].forEach(el => { el.style.display = tab === "magic" ? "" : "none"; });
    const all = rows();
    count.textContent = `${all.length} item${all.length === 1 ? "" : "s"}`;
    list.innerHTML = "";
    if (!all.length) list.appendChild(h("p", { class: "meta" }, "Nothing matches."));
    all.slice(0, shown).forEach(r => {
      const row = h("div", { class: "compendium-row" });
      const btn = h("button", { class: "compendium-toggle", type: "button", "aria-expanded": String(open.has(r.id)) },
        `<span class="arrow">${open.has(r.id) ? "▾" : "▸"}</span> <b>${escapeHtml(r.name)}</b>${r.rarity ? ` <span class="badge rarity-${r.rarity.toLowerCase().split(" (")[0].replace(/\s+/g, "-")}">${escapeHtml(r.rarity)}</span>` : ""} <span class="meta">${escapeHtml(r.meta || "")}</span>`);
      const body = h("div", { class: "compendium-body" }, r.text ? `<p>${escapeHtml(r.text)}</p>` : open.has(r.id) ? itemInfoHtml(ruleset, r.found) : "");
      body.hidden = !open.has(r.id);
      btn.addEventListener("click", () => {
        open.has(r.id) ? open.delete(r.id) : open.add(r.id);
        if (!r.text && !body.innerHTML) body.innerHTML = itemInfoHtml(ruleset, r.found);
        body.hidden = !open.has(r.id);
        btn.setAttribute("aria-expanded", String(open.has(r.id)));
        btn.querySelector(".arrow").textContent = open.has(r.id) ? "▾" : "▸";
      });
      row.appendChild(btn); row.appendChild(body);
      list.appendChild(row);
    });
    more.style.display = all.length > shown ? "" : "none";
  }
  TABS.forEach(([id, label]) => {
    const b = h("button", { class: "tab-btn", type: "button" }, label);
    b.dataset.id = id;
    b.addEventListener("click", () => { tab = id; shown = PAGE; try { sessionStorage.setItem("gt_compendium_tab", id); } catch { /* noop */ } draw(); });
    tabs.appendChild(b);
  });
  [search, rarity, type, attune].forEach(el => el.addEventListener(el === search ? "input" : "change", () => { shown = PAGE; draw(); }));
  more.addEventListener("click", () => { shown += PAGE; draw(); });
  draw();
}
