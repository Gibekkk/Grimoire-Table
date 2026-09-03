import { db } from "../../db.js";
import { mountCharacterSheet } from "../../character-sheet.js";
import { loadRuleset, findById } from "../../data-loader.js";
import { h, toast, escapeHtml } from "../../util.js";
import { ABILITIES, ABILITY_NAMES } from "../../rules-engine.js";

export async function mountNpcPanel(container, { campaignId, user, isDm, getAdvMode }) {
  if (!isDm) {
    container.appendChild(h("div", { class: "empty-state" }, "<h3>DM tools</h3><p>Only the DM can manage NPCs.</p>"));
    return () => {};
  }

  const ruleset = await loadRuleset();
  const listCard = h("div", { class: "card" });
  listCard.appendChild(h("h3", {}, "NPC Roster"));
  const rosterTabs = h("div", { class: "tabs" });
  listCard.appendChild(rosterTabs);
  const newBtn = h("button", { class: "btn primary sm", style: "margin-top:10px;" }, "+ New NPC");
  const newMonsterBtn = h("button", { class: "btn sm", style: "margin-top:10px; margin-left:8px;" }, "+ From Monster Catalog");
  listCard.appendChild(newBtn);
  listCard.appendChild(newMonsterBtn);
  container.appendChild(listCard);

  const sheetHost = h("div", {});
  container.appendChild(sheetHost);

  let activeId = null;
  let sheetUnsub = null;
  let creating = false;

  function openNpc(id) {
    creating = false;
    activeId = id;
    [...rosterTabs.children].forEach(t => t.classList.toggle("active", t.dataset.id === id));
    sheetUnsub?.();
    sheetHost.innerHTML = "";
    mountCharacterSheet(sheetHost, id, {
      viewerUid: user.uid, isDm: true, getAdvMode,
      onRoll: (spec) => {
        import("../../dice/roll-logic.js").then(({ computeRoll }) => {
          const result = computeRoll({ ...spec, mode: getAdvMode?.() || spec.mode });
          db.log.add(campaignId, { type: "roll", uid: user.uid, displayName: "DM (NPC)", label: spec.label, result });
        });
      },
      showManageActions: false
    }).then(u => { sheetUnsub = u; });
  }

  function openCreateForm() {
    creating = true;
    activeId = null;
    [...rosterTabs.children].forEach(t => t.classList.remove("active"));
    sheetUnsub?.();
    sheetHost.innerHTML = "";
    sheetHost.appendChild(buildCreateForm());
  }
  newBtn.addEventListener("click", openCreateForm);

  function openMonsterPicker() {
    creating = true;
    activeId = null;
    [...rosterTabs.children].forEach(t => t.classList.remove("active"));
    sheetUnsub?.();
    sheetHost.innerHTML = "";
    sheetHost.appendChild(buildMonsterPicker());
  }
  newMonsterBtn.addEventListener("click", openMonsterPicker);

  function buildMonsterPicker() {
    const card = h("div", { class: "card" });
    card.appendChild(h("h3", {}, "Monster Catalog"));
    card.appendChild(h("p", {}, "Pick a stat block to instantly create an enemy NPC \u2014 ability scores, AC, HP, and attacks (as ready-to-roll weapons) are filled in for you. Traits and reactions land in Notes for quick reference."));
    const grid = h("div", { class: "grid cols-2" });
    (ruleset.monsters || []).forEach(m => {
      const card2 = h("div", { class: "choice-card" });
      card2.innerHTML = `
        <h4>${escapeHtml(m.name)}</h4>
        <div class="meta">${m.size} ${m.creatureType} \u2022 CR ${m.cr} \u2022 AC ${m.ac} \u2022 HP ${m.hpAverage}</div>
        <div class="meta" style="opacity:0.7; margin-top:4px;">${escapeHtml(m.source || "")}</div>
      `;
      card2.addEventListener("click", () => createFromMonster(m));
      grid.appendChild(card2);
    });
    if (!ruleset.monsters?.length) grid.appendChild(h("p", {}, "No monsters in the catalog yet."));
    card.appendChild(grid);
    return card;
  }

  function formatMonsterNotes(m) {
    const lines = [`Source: ${m.source || "Monster Catalog"}`, `${m.size} ${m.creatureType}, ${m.alignment}`, `Speed ${m.speed} \u2022 CR ${m.cr} (XP ${m.xp})`];
    if (m.senses) lines.push(`Senses: ${m.senses}`);
    if (m.languages) lines.push(`Languages: ${m.languages}`);
    if (m.skills) lines.push(`Skills: ${m.skills}`);
    if (m.vulnerabilities) lines.push(`Vulnerable: ${m.vulnerabilities}`);
    if (m.immunities) lines.push(`Immune: ${m.immunities}`);
    (m.traits || []).forEach(t => lines.push(`\nTrait \u2014 ${t.name}: ${t.description}`));
    (m.bonusActions || []).forEach(t => lines.push(`\nBonus Action \u2014 ${t.name}: ${t.description}`));
    (m.reactions || []).forEach(t => lines.push(`\nReaction \u2014 ${t.name}: ${t.description}`));
    (m.actions || []).filter(a => a.note).forEach(a => lines.push(`\n${a.name} note: ${a.note}`));
    if (m.spellcasting) lines.push(`\nSpellcasting (${m.spellcasting.ability?.toUpperCase()}, DC ${m.spellcasting.saveDc}): At will \u2014 ${(m.spellcasting.atWill || []).join(", ")}. 1/Day each \u2014 ${(m.spellcasting.perDay1 || []).join(", ")}.`);
    return lines.join("\n");
  }

  async function createFromMonster(m) {
    const name = prompt("Name this NPC:", m.name);
    if (!name) return;
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
      campaignId, personality: "", notes: formatMonsterNotes(m), monsterId: m.id
    };
    const id = await db.characters.create(npc);
    for (const action of (m.actions || [])) {
      await db.inventory.add(id, {
        type: "weapon", name: action.name, quantity: 1, equipped: true, isCustom: true,
        weaponData: {
          damageDice: action.damageDice || "1d4", damageType: action.damageType || "bludgeoning",
          ability: "str", ranged: /range/i.test(action.range || ""), ammoType: null,
          range: action.range || null, flatAttackBonus: action.attackBonus, flatDamageBonus: action.damageBonus
        }
      });
    }
    toast(`${name} created from ${m.name}`);
    openNpc(id);
  }

  function buildCreateForm() {
    const card = h("div", { class: "card" });
    card.appendChild(h("h3", {}, "New NPC"));
    card.appendChild(h("p", {}, "Classes, species, and background are optional \u2014 NPCs can just be regular people."));

    const portraitRow = h("div", { style: "display:flex; align-items:center; gap:14px; margin-bottom:14px;" });
    const preview = h("div", { class: "portrait-preview" }, "<span>?</span>");
    const fileInput = h("input", { type: "file", accept: "image/*" });
    let portraitBase64 = null;
    fileInput.addEventListener("change", async () => {
      if (!fileInput.files?.[0]) return;
      const { compressImageToBase64, IMAGE_PRESETS } = await import("../../image-utils.js");
      const result = await compressImageToBase64(fileInput.files[0], IMAGE_PRESETS.portrait);
      portraitBase64 = result.dataUrl;
      preview.innerHTML = `<img src="${portraitBase64}">`;
    });
    portraitRow.appendChild(preview); portraitRow.appendChild(fileInput);
    card.appendChild(portraitRow);

    const nameInput = h("input", { type: "text", placeholder: "NPC name" });
    card.appendChild(h("label", {}, "Name")); card.appendChild(nameInput);

    const row1 = h("div", { class: "grid cols-3" });
    const classSel = h("select", {});
    classSel.appendChild(h("option", { value: "" }, "No class (regular person)"));
    ruleset.classes.forEach(c => classSel.appendChild(h("option", { value: c.id }, c.name)));
    const speciesSel = h("select", {});
    speciesSel.appendChild(h("option", { value: "" }, "No species set"));
    ruleset.species.forEach(s => speciesSel.appendChild(h("option", { value: s.id }, s.name)));
    const levelInput = h("input", { type: "number", value: "1", min: "1", max: "20", placeholder: "Level" });
    [["Class", classSel], ["Species", speciesSel], ["Level", levelInput]].forEach(([label, el]) => {
      const f = h("div", {}); f.appendChild(h("label", {}, label)); f.appendChild(el); row1.appendChild(f);
    });
    card.appendChild(row1);

    card.appendChild(h("label", {}, "Ability Scores"));
    const abilGrid = h("div", { class: "grid cols-3" });
    const abilInputs = {};
    ABILITIES.forEach(a => {
      const f = h("div", {});
      f.appendChild(h("label", {}, ABILITY_NAMES[a]));
      const input = h("input", { type: "number", value: "10", min: "1", max: "30" });
      abilInputs[a] = input;
      f.appendChild(input);
      abilGrid.appendChild(f);
    });
    card.appendChild(abilGrid);

    const row2 = h("div", { class: "grid cols-2" });
    const hpInput = h("input", { type: "number", value: "10", placeholder: "Max HP" });
    const acInput = h("input", { type: "number", value: "10", placeholder: "Armor Class" });
    [["Max HP", hpInput], ["Armor Class (override)", acInput]].forEach(([label, el]) => {
      const f = h("div", {}); f.appendChild(h("label", {}, label)); f.appendChild(el); row2.appendChild(f);
    });
    card.appendChild(row2);

    const personalityInput = h("textarea", { placeholder: "Personality, mannerisms, motivations\u2026" });
    card.appendChild(h("label", {}, "Personality")); card.appendChild(personalityInput);
    const notesInput = h("textarea", { placeholder: "DM notes, stat block reference, plot relevance\u2026" });
    card.appendChild(h("label", {}, "Notes")); card.appendChild(notesInput);

    const createBtn = h("button", { class: "btn primary" }, "Create NPC");
    createBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) { toast("Name the NPC first", "error"); return; }
      const level = Math.max(1, parseInt(levelInput.value, 10) || 1);
      const abilityScores = {};
      ABILITIES.forEach(a => { abilityScores[a] = parseInt(abilInputs[a].value, 10) || 10; });
      const maxHp = parseInt(hpInput.value, 10) || 10;
      const npc = {
        ownerUid: user.uid, ownerName: user.displayName, isNpc: true,
        name, portraitBase64,
        classId: classSel.value || null,
        classes: classSel.value ? [{ classId: classSel.value, level, subclassId: null }] : [],
        speciesId: speciesSel.value || null,
        backgroundId: null, alignment: "", backstory: "",
        appearance: {}, level, xp: 0,
        abilityScores, abilityOverrides: {}, skillOverrides: {}, savingThrowOverrides: {},
        skillProficiencies: [], skillExpertise: [], savingThrowProficiencies: [],
        equipmentChoice: "A", weaponMasteries: [], featChoices: {},
        hp: { current: maxHp, max: maxHp, temp: 0 }, hitDiceUsed: 0,
        armorClassOverride: parseInt(acInput.value, 10) || null,
        acAdjustments: [], inspiration: false,
        currency: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
        resourcesUsed: {}, spellsPrepared: [], spellSlotsUsed: {}, pactSlotsUsed: 0,
        campaignId, personality: personalityInput.value.trim(), notes: notesInput.value.trim()
      };
      const id = await db.characters.create(npc);
      toast(`${name} added to the roster`);
      openNpc(id);
    });
    card.appendChild(createBtn);
    return card;
  }

  const unsubRoster = db.characters.subscribeCampaignNpcs(campaignId, (npcs) => {
    rosterTabs.innerHTML = "";
    npcs.forEach(npc => {
      const tab = h("button", { class: `tab-btn ${npc.id === activeId ? "active" : ""}` }, npc.name);
      tab.dataset.id = npc.id;
      tab.addEventListener("click", () => openNpc(npc.id));
      rosterTabs.appendChild(tab);
    });
    if (npcs.length === 0 && !creating) {
      sheetHost.innerHTML = "";
      sheetHost.appendChild(h("p", {}, "No NPCs yet. Click \u201c+ New NPC\u201d to create your first one."));
    } else if (!activeId && !creating && npcs.length > 0) {
      openNpc(npcs[0].id);
    }
  });

  return () => { unsubRoster(); sheetUnsub?.(); };
}
