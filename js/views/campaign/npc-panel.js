import { db } from "../../db.js";
import { mountCharacterSheet } from "../../character-sheet.js";
import { loadRuleset, findById } from "../../data-loader.js";
import { h, toast, escapeHtml } from "../../util.js";
import { ABILITIES, ABILITY_NAMES } from "../../rules-engine.js";
import { createNpcFromMonster, renderMonsterList, nextMonsterName, monsterImageFor } from "../../monsters.js";

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
  const hiddenToggle = h("button", { class: "btn sm ghost", style: "margin-top:10px; margin-left:8px; display:none;" });
  listCard.appendChild(newBtn);
  listCard.appendChild(newMonsterBtn);
  listCard.appendChild(hiddenToggle);
  container.appendChild(listCard);

  // Bar above the open NPC's sheet: hide from the roster (and the VTT's token list) or delete
  const npcBar = h("div", { class: "npc-bar", style: "display:none;" });
  container.appendChild(npcBar);

  const sheetHost = h("div", {});
  container.appendChild(sheetHost);

  let activeId = null;
  let showHidden = false;
  let allNpcs = [];
  let sheetUnsub = null;
  let creating = false;
  let pickerCleanup = null; // stops the monster catalog's live image subscription

  function renderNpcBar() {
    const npc = allNpcs.find(n => n.id === activeId);
    npcBar.innerHTML = "";
    npcBar.style.display = npc && !creating ? "flex" : "none";
    if (!npc || creating) return;
    npcBar.appendChild(h("span", { class: "meta", style: "flex:1;" }, npc.hiddenFromRoster ? "Hidden: not listed in the roster, the VTT's add-token menu or combat setup." : ""));
    const hide = h("button", { class: "btn sm" }, npc.hiddenFromRoster ? "\u{1F441} Unhide NPC" : "\u{1F576} Hide NPC");
    hide.title = "Hidden NPCs keep their sheet but drop out of the roster and the VTT's add-token list";
    hide.addEventListener("click", async () => {
      await db.characters.update(npc.id, { hiddenFromRoster: !npc.hiddenFromRoster });
      toast(npc.hiddenFromRoster ? `${npc.name} is back in the roster` : `${npc.name} hidden \u2014 use \u201cShow hidden\u201d to find it again`);
    });
    const del = h("button", { class: "btn sm danger" }, "Delete NPC");
    del.addEventListener("click", async () => {
      if (!confirm(`Delete ${npc.name} permanently? Its tokens stay on maps until you remove them.`)) return;
      await db.characters.remove(npc.id);
      activeId = null;
      sheetUnsub?.(); sheetUnsub = null;
      sheetHost.innerHTML = "";
      toast(`${npc.name} deleted`);
    });
    npcBar.appendChild(hide);
    npcBar.appendChild(del);
  }

  function openNpc(id) {
    creating = false;
    activeId = id;
    renderNpcBar();
    [...rosterTabs.children].forEach(t => t.classList.toggle("active", t.dataset.id === id));
    sheetUnsub?.();
    pickerCleanup?.(); pickerCleanup = null;
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
    renderNpcBar();
    [...rosterTabs.children].forEach(t => t.classList.remove("active"));
    sheetUnsub?.();
    pickerCleanup?.(); pickerCleanup = null;
    sheetHost.innerHTML = "";
    sheetHost.appendChild(buildCreateForm());
  }
  newBtn.addEventListener("click", openCreateForm);

  function openMonsterPicker() {
    creating = true;
    activeId = null;
    renderNpcBar();
    [...rosterTabs.children].forEach(t => t.classList.remove("active"));
    sheetUnsub?.();
    pickerCleanup?.(); pickerCleanup = null;
    sheetHost.innerHTML = "";
    sheetHost.appendChild(buildMonsterPicker());
  }
  newMonsterBtn.addEventListener("click", openMonsterPicker);

  function buildMonsterPicker() {
    const card = h("div", { class: "card" });
    card.appendChild(h("h3", {}, "Monster Catalog"));
    card.appendChild(h("p", { class: "hint" }, "For ordinary encounters, place monsters straight onto the VTT with the \u{1F409} button \u2014 they live on the map only. Use this for named, recurring monsters you want a full sheet for."));
    card.appendChild(h("p", {}, "Pick a stat block to instantly create an enemy NPC \u2014 ability scores, AC, HP, and attacks (as ready-to-roll weapons) are filled in for you. Traits and reactions land in Notes for quick reference. Use \u{1F5BC} on a monster to give it an image; every copy of it in this campaign uses that image."));
    pickerCleanup = renderMonsterList(card, ruleset.monsters || [], createFromMonster, { campaignId });
    return card;
  }

  async function createFromMonster(m) {
    const [name, portraitBase64] = await Promise.all([nextMonsterName(campaignId, m.name), monsterImageFor(campaignId, m.id)]);
    const id = await createNpcFromMonster(m, { name, user, campaignId, portraitBase64 });
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

  hiddenToggle.addEventListener("click", () => { showHidden = !showHidden; renderRoster(); });

  function renderRoster() {
    const hiddenCount = allNpcs.filter(n => n.hiddenFromRoster).length;
    hiddenToggle.style.display = hiddenCount ? "" : "none";
    hiddenToggle.textContent = showHidden ? `Hide hidden NPCs` : `Show hidden (${hiddenCount})`;
    const npcs = allNpcs.filter(n => showHidden || !n.hiddenFromRoster || n.id === activeId);
    rosterTabs.innerHTML = "";
    npcs.forEach(npc => {
      const tab = h("button", { class: `tab-btn ${npc.id === activeId ? "active" : ""} ${npc.hiddenFromRoster ? "is-hidden" : ""}` }, `${npc.hiddenFromRoster ? "\u{1F576} " : ""}${npc.name}`);
      tab.dataset.id = npc.id;
      tab.addEventListener("click", () => openNpc(npc.id));
      rosterTabs.appendChild(tab);
    });
    if (npcs.length === 0 && !creating) {
      pickerCleanup?.(); pickerCleanup = null;
    sheetHost.innerHTML = "";
      sheetHost.appendChild(h("p", {}, allNpcs.length ? "All NPCs are hidden \u2014 click \u201cShow hidden\u201d to see them." : "No NPCs yet. Click \u201c+ New NPC\u201d to create your first one."));
    } else if (!activeId && !creating && npcs.length > 0) {
      openNpc(npcs[0].id);
    }
    renderNpcBar();
  }

  const unsubRoster = db.characters.subscribeCampaignNpcs(campaignId, (list) => {
    allNpcs = list;
    if (activeId && !list.some(n => n.id === activeId)) activeId = null;
    renderRoster();
  });

  return () => { unsubRoster(); sheetUnsub?.(); };
}
