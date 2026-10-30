// Shared Monster Manual helpers: turning a catalog stat block into an NPC
// (used by the NPCs tab and the VTT's monster button), token sizing by
// creature size, and a searchable monster picker modal.
import { db } from "./db.js";
import { h, escapeHtml, toast, showContextMenu } from "./util.js";
import { compressImageToBase64, IMAGE_PRESETS } from "./image-utils.js";

// Squares (5 ft) a creature of each size occupies on the grid.
const SIZE_SQUARES = { tiny: 0.5, small: 1, medium: 1, large: 2, huge: 3, gargantuan: 4 };

// "Medium or Small" / "Huge or Gargantuan" use the first listed size.
export function tokenSquaresForSize(size) {
  const first = String(size || "").trim().split(/\s+/)[0]?.toLowerCase();
  return SIZE_SQUARES[first] || 1;
}

export function formatMonsterNotes(m) {
  const lines = [`Source: ${m.source || "Monster Catalog"}`, `${m.size} ${m.creatureType}, ${m.alignment}`, `Speed ${m.speed} \u2022 CR ${m.cr} (XP ${m.xp})`];
  if (m.senses) lines.push(`Senses: ${m.senses}`);
  if (m.languages) lines.push(`Languages: ${m.languages}`);
  if (m.skills) lines.push(`Skills: ${m.skills}`);
  if (m.saves) lines.push(`Saves: ${m.saves}`);
  if (m.vulnerabilities) lines.push(`Vulnerable: ${m.vulnerabilities}`);
  if (m.resistances) lines.push(`Resist: ${m.resistances}`);
  if (m.immunities) lines.push(`Immune: ${m.immunities}`);
  if (m.gear) lines.push(`Gear: ${m.gear}`);
  (m.traits || []).forEach(t => lines.push(`\nTrait \u2014 ${t.name}: ${t.description}`));
  // Attacks become ready-to-roll weapons; everything else (Multiattack, breath weapons, spellcasting) is listed here
  (m.actions || []).filter(a => !isWeaponAttack(a) && a.description).forEach(a => lines.push(`\nAction \u2014 ${a.name}: ${a.description}`));
  (m.bonusActions || []).forEach(t => lines.push(`\nBonus Action \u2014 ${t.name}: ${t.description}`));
  (m.reactions || []).forEach(t => lines.push(`\nReaction \u2014 ${t.name}: ${t.description}`));
  if (m.legendaryActions?.length) {
    lines.push(`\nLegendary Actions${m.legendaryUses ? ` (${m.legendaryUses})` : ""}:`);
    m.legendaryActions.forEach(t => lines.push(`  ${t.name}: ${t.description}`));
  }
  (m.actions || []).filter(a => a.note).forEach(a => lines.push(`\n${a.name} note: ${a.note}`));
  if (m.spellcasting) lines.push(`\nSpellcasting (${m.spellcasting.ability?.toUpperCase()}, DC ${m.spellcasting.saveDc}): At will \u2014 ${(m.spellcasting.atWill || []).join(", ")}. 1/Day each \u2014 ${(m.spellcasting.perDay1 || []).join(", ")}.`);
  return lines.join("\n");
}

function isWeaponAttack(a) {
  return a.attackBonus != null && !!a.damageDice;
}

// Resolves with the first value a db subscribe() call delivers, then unsubscribes.
export function once(subscribe) {
  return new Promise(resolve => {
    let unsub = null, done = false;
    unsub = subscribe((value) => {
      if (done) return;
      done = true;
      resolve(value);
      if (unsub) unsub(); else setTimeout(() => unsub?.(), 0);
    });
  });
}

// "Goblin Warrior", then "Goblin Warrior 2", "Goblin Warrior 3"... so copies on the map are told apart.
export async function nextMonsterName(campaignId, baseName) {
  const npcs = await once(cb => db.characters.subscribeCampaignNpcs(campaignId, cb));
  const taken = new Set(npcs.map(n => (n.name || "").trim().toLowerCase()));
  if (!taken.has(baseName.toLowerCase())) return baseName;
  let n = 2;
  while (taken.has(`${baseName} ${n}`.toLowerCase())) n++;
  return `${baseName} ${n}`;
}

// The campaign's artwork for a monster, or null.
export async function monsterImageFor(campaignId, monsterId) {
  const map = await once(cb => db.monsterImages.subscribe(campaignId, cb));
  return map?.[monsterId] || null;
}

// Saves a monster's campaign artwork and pushes it onto every NPC made from
// that monster and onto their tokens on every map, so existing copies update too.
export async function applyMonsterImage(campaignId, monsterId, imageBase64) {
  if (imageBase64) await db.monsterImages.set(campaignId, monsterId, imageBase64);
  else await db.monsterImages.remove(campaignId, monsterId);
  const npcs = (await once(cb => db.characters.subscribeCampaignNpcs(campaignId, cb))).filter(n => n.monsterId === monsterId);
  if (!npcs.length) return;
  const npcIds = new Set(npcs.map(n => n.id));
  await Promise.all(npcs.map(n => db.characters.update(n.id, { portraitBase64: imageBase64 || null })));
  const maps = await db.maps.listAll(campaignId);
  for (const map of maps) {
    const tokens = await once(cb => db.tokens.subscribe(campaignId, map.id, cb));
    await Promise.all(tokens.filter(t => npcIds.has(t.refId)).map(t => db.tokens.update(campaignId, map.id, t.id, { imageBase64: imageBase64 || null })));
  }
}

// File dialog -> compressed portrait -> applyMonsterImage. Offers removal when one is already set.
export function chooseMonsterImage(campaignId, monster, currentImage, anchor) {
  const pickFile = () => {
    const input = h("input", { type: "file", accept: "image/*", style: "display:none;" });
    document.body.appendChild(input);
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      try {
        const { dataUrl } = await compressImageToBase64(file, IMAGE_PRESETS.portrait);
        await applyMonsterImage(campaignId, monster.id, dataUrl);
        toast(`Image set for ${monster.name}`);
      } catch (err) {
        console.error(err);
        toast("Couldn't save that image", "error");
      }
    });
    input.click();
  };
  if (!currentImage) { pickFile(); return; }
  const rect = anchor?.getBoundingClientRect();
  showContextMenu(rect?.left ?? 100, rect?.bottom ?? 100, [
    { label: "Change image\u2026", action: pickFile },
    { label: "Remove image", danger: true, action: async () => { await applyMonsterImage(campaignId, monster.id, null); toast(`Image removed from ${monster.name}`); } }
  ]);
}

// Creates an NPC (same shape as a hand-made one) from a stat block and gives it
// one equipped weapon per attack. Returns the new character id.
export async function createNpcFromMonster(m, { name, user, campaignId, portraitBase64 = null }) {
  const npc = {
    ownerUid: user.uid, ownerName: user.displayName, isNpc: true,
    name, portraitBase64,
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
// With `campaignId`, cards show the campaign's artwork and a button to set it.
// Returns a cleanup function.
export function renderMonsterList(container, monsters, onPick, { maxShown = 60, campaignId = null } = {}) {
  let images = {};
  const sorted = [...monsters].sort((a, b) => a.name.localeCompare(b.name));
  const search = h("input", { type: "search", placeholder: `Search ${sorted.length} monsters by name, type, or CR (e.g. "dragon", "cr 5")\u2026`, style: "margin-bottom:10px;" });
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
      const card = h("div", { class: "choice-card monster-card" });
      const img = images[m.id];
      card.innerHTML = `
        <div class="portrait-preview">${img ? `<img src="${img}">` : `<span>${escapeHtml(m.name[0].toUpperCase())}</span>`}</div>
        <div class="monster-card-text">
          <h4>${escapeHtml(m.name)}</h4>
          <div class="meta">${escapeHtml(`${m.size} ${m.creatureType}`)} \u2022 CR ${escapeHtml(String(m.cr))} \u2022 AC ${m.ac} \u2022 HP ${m.hpAverage}</div>
          <div class="meta" style="opacity:0.7; margin-top:4px;">${escapeHtml(m.source || "")}</div>
        </div>
      `;
      if (campaignId) {
        const imgBtn = h("button", { class: "icon-btn monster-img-btn", title: img ? "Change or remove this monster's image" : "Add an image for this monster" }, "\u{1F5BC}");
        imgBtn.addEventListener("click", (e) => { e.stopPropagation(); chooseMonsterImage(campaignId, m, img, imgBtn); });
        card.appendChild(imgBtn);
      }
      card.addEventListener("click", () => onPick(m));
      grid.appendChild(card);
    });
    countLine.textContent = matches.length > maxShown
      ? `Showing ${maxShown} of ${matches.length} \u2014 type to narrow it down.`
      : `${matches.length} monster${matches.length === 1 ? "" : "s"}`;
    if (!sorted.length) grid.appendChild(h("p", {}, "No monsters in the catalog yet."));
  }
  search.addEventListener("input", renderList);
  renderList();
  setTimeout(() => search.focus(), 0);
  // Artwork updates live, e.g. right after setting an image from a card
  const unsub = campaignId ? db.monsterImages.subscribe(campaignId, (map) => { images = map || {}; renderList(); }) : null;
  return () => unsub?.();
}

// Modal version of the list, used by the VTT. Resolves to the picked monster or null.
export function pickMonster(monsters, { title = "Add a Monster", campaignId = null } = {}) {
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

    let cleanup = null;
    const finish = (m) => { cleanup?.(); overlay.remove(); document.removeEventListener("keydown", onKey); resolve(m); };
    const onKey = (e) => { if (e.key === "Escape") finish(null); };
    document.addEventListener("keydown", onKey);
    closeBtn.addEventListener("click", () => finish(null));
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) finish(null); });
    if (campaignId) body.appendChild(h("p", { class: "meta", style: "margin-top:0;" }, "Click a monster to place it. Use \u{1F5BC} to give a monster an image \u2014 every copy of it in this campaign uses it."));
    cleanup = renderMonsterList(body, monsters, finish, { maxShown: 40, campaignId });
  });
}
