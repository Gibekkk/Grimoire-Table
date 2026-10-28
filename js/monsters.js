// Shared Monster Manual helpers: turning a catalog stat block into an NPC
// (used by the NPCs tab and the VTT's monster button), token sizing by
// creature size, and a searchable monster picker modal.
import { db } from "./db.js";
import { h, escapeHtml } from "./util.js";

// Squares (5 ft) a creature of each size occupies on the grid.
const SIZE_SQUARES = { tiny: 0.5, small: 1, medium: 1, large: 2, huge: 3, gargantuan: 4 };

// "Medium or Small" / "Huge or Gargantuan" use the first listed size.
export function tokenSquaresForSize(size) {
  const first = String(size || "").trim().split(/\s+/)[0]?.toLowerCase();
  return SIZE_SQUARES[first] || 1;
}

export function formatMonsterNotes(m) {
  const lines = [`Source: ${m.source || "Monster Catalog"}`, `${m.size} ${m.creatureType}, ${m.alignment}`, `Speed ${m.speed} • CR ${m.cr} (XP ${m.xp})`];
  if (m.senses) lines.push(`Senses: ${m.senses}`);
  if (m.languages) lines.push(`Languages: ${m.languages}`);
  if (m.skills) lines.push(`Skills: ${m.skills}`);
  if (m.saves) lines.push(`Saves: ${m.saves}`);
  if (m.vulnerabilities) lines.push(`Vulnerable: ${m.vulnerabilities}`);
  if (m.resistances) lines.push(`Resist: ${m.resistances}`);
  if (m.immunities) lines.push(`Immune: ${m.immunities}`);
  if (m.gear) lines.push(`Gear: ${m.gear}`);
  (m.traits || []).forEach(t => lines.push(`\nTrait — ${t.name}: ${t.description}`));
  // Attacks become ready-to-roll weapons; everything else (Multiattack, breath weapons, spellcasting) is listed here
  (m.actions || []).filter(a => !isWeaponAttack(a) && a.description).forEach(a => lines.push(`\nAction — ${a.name}: ${a.description}`));
  (m.bonusActions || []).forEach(t => lines.push(`\nBonus Action — ${t.name}: ${t.description}`));
  (m.reactions || []).forEach(t => lines.push(`\nReaction — ${t.name}: ${t.description}`));
  if (m.legendaryActions?.length) {
    lines.push(`\nLegendary Actions${m.legendaryUses ? ` (${m.legendaryUses})` : ""}:`);
    m.legendaryActions.forEach(t => lines.push(`  ${t.name}: ${t.description}`));
  }
  (m.actions || []).filter(a => a.note).forEach(a => lines.push(`\n${a.name} note: ${a.note}`));
  if (m.spellcasting) lines.push(`\nSpellcasting (${m.spellcasting.ability?.toUpperCase()}, DC ${m.spellcasting.saveDc}): At will — ${(m.spellcasting.atWill || []).join(", ")}. 1/Day each — ${(m.spellcasting.perDay1 || []).join(", ")}.`);
  return lines.join("\n");
}

function isWeaponAttack(a) {
  return a.attackBonus != null && !!a.damageDice;
}

// Creates an NPC (same shape as a hand-made one) from a stat block and gives it
// one equipped weapon per attack. Returns the new character id.
export async function createNpcFromMonster(m, { name, user, campaignId }) {
  const npc = {
    ownerUid: user.uid, ownerName: user.displayName, isNpc: true,
    name, portraitBase64: null,
    classId: null, classes: [], speciesId: null, backgroundId: null,
    alignment: m.alignment || "", backstory: "",
    appearance: {}, level: 1, xp: 0,
    abilityScores: { ...m.abilityScores }, abilityOverrides: {}, skillOverrides: {}, savingThrowOverrides: {},
    skillProficiencies: [], skillExpertise: [], savingThrowProficiencies: [],
    equipmentChoice: "A", weaponMasteries: [], featChoices: {},
    hp: { current: m.hpAverage, max: m.hpAverage, temp: 0 }, hitDiceUsed: 0,
    armorClassOverride: m.ac || null,
    acAdjustments: [], inspiration: false,
    currency: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
    resourcesUsed: {}, spellsPrepared: [], spellSlotsUsed: {}, pactSlotsUsed: 0,
    campaignId, personality: "", notes: formatMonsterNotes(m), monsterId: m.id, size: m.size || null
  };
  const id = await db.characters.create(npc);
  for (const action of (m.actions || []).filter(isWeaponAttack)) {
    await db.inventory.add(id, {
      type: "weapon", name: action.name, quantity: 1, equipped: true, isCustom: true,
      weaponData: {
        damageDice: action.damageDice, damageType: action.damageType || "bludgeoning",
        ability: "str", ranged: /range/i.test(action.range || ""), ammoType: null,
        range: action.range || null, flatAttackBonus: action.attackBonus, flatDamageBonus: action.damageBonus
      }
    });
  }
  return id;
}

// Renders a searchable monster list into `container`; calls onPick(monster).
// Rendering all ~500 cards at once is slow, so the list is capped.
export function renderMonsterList(container, monsters, onPick, { maxShown = 60 } = {}) {
  const sorted = [...monsters].sort((a, b) => a.name.localeCompare(b.name));
  const search = h("input", { type: "search", placeholder: `Search ${sorted.length} monsters by name, type, or CR (e.g. "dragon", "cr 5")…`, style: "margin-bottom:10px;" });
  const countLine = h("div", { class: "meta", style: "margin-bottom:8px; opacity:0.7;" });
  const grid = h("div", { class: "grid cols-2" });
  container.appendChild(search);
  container.appendChild(countLine);
  container.appendChild(grid);

  function renderList() {
    const q = search.value.trim().toLowerCase();
    const crMatch = q.match(/^cr\s*(\S+)$/);
    const matches = sorted.filter(m => crMatch
      ? String(m.cr) === crMatch[1]
      : !q || `${m.name} ${m.creatureType} ${m.size}`.toLowerCase().includes(q));
    grid.innerHTML = "";
    matches.slice(0, maxShown).forEach(m => {
      const card = h("div", { class: "choice-card" });
      card.innerHTML = `
        <h4>${escapeHtml(m.name)}</h4>
        <div class="meta">${escapeHtml(`${m.size} ${m.creatureType}`)} • CR ${escapeHtml(String(m.cr))} • AC ${m.ac} • HP ${m.hpAverage}</div>
        <div class="meta" style="opacity:0.7; margin-top:4px;">${escapeHtml(m.source || "")}</div>
      `;
      card.addEventListener("click", () => onPick(m));
      grid.appendChild(card);
    });
    countLine.textContent = matches.length > maxShown
      ? `Showing ${maxShown} of ${matches.length} — type to narrow it down.`
      : `${matches.length} monster${matches.length === 1 ? "" : "s"}`;
    if (!sorted.length) grid.appendChild(h("p", {}, "No monsters in the catalog yet."));
  }
  search.addEventListener("input", renderList);
  renderList();
  setTimeout(() => search.focus(), 0);
}

// Modal version of the list, used by the VTT. Resolves to the picked monster or null.
export function pickMonster(monsters, { title = "Add a Monster" } = {}) {
  return new Promise(resolve => {
    const overlay = h("div", { class: "modal-overlay" });
    const box = h("div", { class: "modal-box monster-picker" });
    const header = h("div", { style: "display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;" });
    header.appendChild(h("h3", { style: "margin:0;" }, title));
    const closeBtn = h("button", { class: "icon-btn", title: "Close" }, "✕");
    header.appendChild(closeBtn);
    box.appendChild(header);
    const body = h("div", { class: "monster-picker-body" });
    box.appendChild(body);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const finish = (m) => { overlay.remove(); document.removeEventListener("keydown", onKey); resolve(m); };
    const onKey = (e) => { if (e.key === "Escape") finish(null); };
    document.addEventListener("keydown", onKey);
    closeBtn.addEventListener("click", () => finish(null));
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) finish(null); });
    renderMonsterList(body, monsters, finish, { maxShown: 40 });
  });
}
