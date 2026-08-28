import { db } from "./db.js";
import { loadRuleset, findById } from "./data-loader.js";
import { h, toast, escapeHtml } from "./util.js";
import {
  ABILITIES, ABILITY_NAMES, abilityModifier, formatModifier, proficiencyBonus,
  skillModifier, savingThrowModifier, estimateArmorClass, maxHitPoints
} from "./rules-engine.js";

// Renders a full character sheet into `container`. Returns an unsubscribe fn.
// opts.onRoll(rollSpec) — called when the user clicks a rollable modifier (ability/skill/save).
// opts.compact — tighter layout for embedding inside the campaign room.
export async function mountCharacterSheet(container, characterId, opts = {}) {
  const ruleset = await loadRuleset();
  let character = await db.characters.get(characterId);
  if (!character) {
    container.innerHTML = `<div class="empty-state"><h3>Character not found</h3></div>`;
    return () => {};
  }

  let editable = !opts.readOnly;
  const unsub = db.characters.subscribe(characterId, (updated) => {
    if (updated) { character = updated; render(); }
  });

  function patch(partial) {
    Object.assign(character, partial);
    db.characters.update(characterId, partial);
    render();
  }

  async function render() {
    container.innerHTML = "";
    const cls = findById(ruleset.classes, character.classId);
    const sp = findById(ruleset.species, character.speciesId);
    const bg = findById(ruleset.backgrounds, character.backgroundId);
    const pb = proficiencyBonus(character.level || 1);
    const maxHp = character.hp?.max ?? maxHitPoints(character, cls);
    if (character.hp?.current == null) { character.hp = { current: maxHp, max: maxHp, temp: 0 }; }

    const header = h("div", { class: "card parchment" });
    header.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:10px;">
        <div>
          <h2 style="margin-bottom:2px;">${escapeHtml(character.name)}</h2>
          <div class="meta" style="color:#5c4f33;">Level ${character.level || 1} ${sp?.name || ""} ${cls?.name || ""} \u2022 ${bg?.name || ""} \u2022 ${character.alignment || ""}</div>
        </div>
        <div style="display:flex; gap:14px;">
          <div style="text-align:center;"><div class="mono" style="font-size:1.4rem;">${pb >= 0 ? "+" : ""}${pb}</div><div style="font-size:0.65rem; text-transform:uppercase;">Prof. Bonus</div></div>
          <div style="text-align:center;"><div class="mono" style="font-size:1.4rem;">${estimateArmorClass(character)}</div><div style="font-size:0.65rem; text-transform:uppercase;">Armor Class</div></div>
        </div>
      </div>
    `;
    container.appendChild(header);

    if (editable) {
      const levelCard = h("div", { class: "card", style: "display:flex; gap:16px; align-items:center; flex-wrap:wrap;" });
      levelCard.innerHTML = `<label style="margin:0;">Level <input type="number" min="1" max="20" value="${character.level || 1}" style="width:64px; display:inline-block; margin:0 0 0 6px;" id="level-input"></label>`;
      const inspBtn = h("button", { class: `btn sm ${character.inspiration ? "primary" : ""}` }, character.inspiration ? "\u2728 Inspired" : "Heroic Inspiration");
      inspBtn.addEventListener("click", () => patch({ inspiration: !character.inspiration }));
      levelCard.appendChild(inspBtn);
      container.appendChild(levelCard);
      levelCard.querySelector("#level-input").addEventListener("change", (e) => {
        patch({ level: Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 1)) });
      });
    }

    // HP / hit dice
    const hpCard = h("div", { class: "card" });
    hpCard.appendChild(h("h3", {}, "Hit Points"));
    const hpRow = h("div", { class: "hp-block" });
    hpRow.innerHTML = `
      <div class="big-stat"><input type="number" id="hp-current" value="${character.hp.current}"><div class="lbl">Current</div></div>
      <div class="big-stat"><div class="val">/ ${character.hp.max}</div><div class="lbl">Max</div></div>
      <div class="big-stat"><input type="number" id="hp-temp" value="${character.hp.temp || 0}"><div class="lbl">Temp</div></div>
      <div class="big-stat"><div class="val mono" style="font-size:1.1rem;">1d${cls?.hitDie || 8}</div><div class="lbl">Hit Die</div></div>
    `;
    hpCard.appendChild(hpRow);
    container.appendChild(hpCard);
    hpCard.querySelector("#hp-current").addEventListener("change", (e) => patch({ hp: { ...character.hp, current: parseInt(e.target.value, 10) || 0 } }));
    hpCard.querySelector("#hp-temp").addEventListener("change", (e) => patch({ hp: { ...character.hp, temp: parseInt(e.target.value, 10) || 0 } }));

    // Abilities & saves
    const abilCard = h("div", { class: "card" });
    abilCard.appendChild(h("h3", {}, "Ability Scores & Saving Throws"));
    const abilGrid = h("div", { class: "ability-grid" });
    ABILITIES.forEach(a => {
      const score = character.abilityScores[a];
      const mod = abilityModifier(score);
      const saveMod = savingThrowModifier(character, a);
      const isProf = character.savingThrowProficiencies?.includes(a);
      const box = h("div", { class: "ability-box" });
      box.innerHTML = `
        <div class="name">${ABILITY_NAMES[a]}</div>
        <div class="score">${score}</div>
        <div class="mod roll-target" style="cursor:pointer;" title="Roll ${ABILITY_NAMES[a]} check">${formatModifier(mod)}</div>
        <div style="font-size:0.65rem; color:${isProf ? "var(--gold-bright)" : "var(--text-dim)"}; margin-top:4px; cursor:pointer;" class="save-target">Save ${formatModifier(saveMod)}</div>
      `;
      box.querySelector(".roll-target").addEventListener("click", () => opts.onRoll?.({ sides: 20, count: 1, modifier: mod, label: `${ABILITY_NAMES[a]} Check`, mode: currentAdvMode() }));
      box.querySelector(".save-target").addEventListener("click", () => opts.onRoll?.({ sides: 20, count: 1, modifier: saveMod, label: `${ABILITY_NAMES[a]} Save`, mode: currentAdvMode() }));
      abilGrid.appendChild(box);
    });
    abilCard.appendChild(abilGrid);
    container.appendChild(abilCard);

    // Skills
    const skillsCard = h("div", { class: "card" });
    skillsCard.appendChild(h("h3", {}, "Skills"));
    skillsCard.appendChild(h("p", {}, `Passive Perception: ${10 + skillModifier(character, { id: "perception" }, ruleset.skills)}`));
    ruleset.skills.forEach(skill => {
      const mod = skillModifier(character, skill, ruleset.skills);
      const isProf = character.skillProficiencies?.includes(skill.id);
      const isExpert = character.skillExpertise?.includes(skill.id);
      const row = h("div", { class: "skill-row" });
      row.innerHTML = `
        <span class="prof-dot ${isExpert ? "expert" : isProf ? "on" : ""}"></span>
        <span class="ability-tag">${skill.ability.toUpperCase()}</span>
        <span class="name">${skill.name}</span>
        <span class="mod" style="cursor:pointer;">${formatModifier(mod)}</span>
      `;
      const dot = row.querySelector(".prof-dot");
      if (editable) {
        dot.addEventListener("click", () => {
          let profs = new Set(character.skillProficiencies || []);
          let experts = new Set(character.skillExpertise || []);
          if (!profs.has(skill.id)) { profs.add(skill.id); }
          else if (!experts.has(skill.id)) { experts.add(skill.id); }
          else { profs.delete(skill.id); experts.delete(skill.id); }
          patch({ skillProficiencies: [...profs], skillExpertise: [...experts] });
        });
      }
      row.querySelector(".mod").addEventListener("click", () => opts.onRoll?.({ sides: 20, count: 1, modifier: mod, label: skill.name, mode: currentAdvMode() }));
      skillsCard.appendChild(row);
    });
    container.appendChild(skillsCard);

    // Equipment & feat & notes
    const detailCard = h("div", { class: "card" });
    detailCard.appendChild(h("h3", {}, "Origin & Equipment"));
    detailCard.innerHTML += `
      <p><strong>Origin feat:</strong> ${bg?.feat || "\u2014"}</p>
      <p><strong>Starting equipment:</strong> ${cls?.startingEquipment?.[character.equipmentChoice === "B" ? 1 : 0] || "\u2014"}</p>
      ${character.backstory ? `<p><strong>Backstory:</strong> ${escapeHtml(character.backstory)}</p>` : ""}
    `;
    if (cls?.spellcasting) {
      detailCard.innerHTML += `<p><strong>Spellcasting:</strong> ${ABILITY_NAMES[cls.spellcasting.ability]} (${cls.spellcasting.type}). Track prepared/known spells and slots in the notes below \u2014 full spell automation is on the roadmap.</p>`;
    }
    const notesLabel = h("label", {}, "Player notes");
    const notesArea = h("textarea", {});
    notesArea.value = character.notes || "";
    notesArea.addEventListener("change", () => patch({ notes: notesArea.value }));
    detailCard.appendChild(notesLabel);
    detailCard.appendChild(notesArea);
    container.appendChild(detailCard);

    if (opts.showManageActions) {
      const manageCard = h("div", { class: "card" });
      manageCard.appendChild(h("h3", {}, "Manage"));
      if (!character.campaignId) {
        const joinRow = h("div", { class: "field-row" });
        const campInput = h("input", { type: "text", placeholder: "Campaign invite code to join with this character" });
        const joinBtn = h("button", { class: "btn" }, "Join Campaign");
        joinBtn.addEventListener("click", async () => {
          try {
            const campId = await db.campaigns.join(campInput.value.trim(), character.ownerUid, character.ownerName);
            patch({ campaignId: campId });
            toast("Joined campaign with this character");
          } catch (e) { toast(e.message, "error"); }
        });
        joinRow.appendChild(campInput); joinRow.appendChild(joinBtn);
        manageCard.appendChild(joinRow);
      } else {
        manageCard.appendChild(h("p", {}, `In campaign. `));
        const leaveBtn = h("button", { class: "btn sm" }, "Leave campaign (keep character)");
        leaveBtn.addEventListener("click", () => patch({ campaignId: null }));
        manageCard.appendChild(leaveBtn);
      }
      const delBtn = h("button", { class: "btn danger sm", style: "margin-top:12px;" }, "Delete Character");
      delBtn.addEventListener("click", async () => {
        if (!confirm(`Delete ${character.name}? This can't be undone.`)) return;
        await db.characters.remove(characterId);
        opts.onDelete?.();
      });
      manageCard.appendChild(delBtn);
      container.appendChild(manageCard);
    }
  }

  function currentAdvMode() {
    return opts.getAdvMode ? opts.getAdvMode() : "normal";
  }

  await render();
  return unsub;
}
