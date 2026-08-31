import { loadRuleset, findById } from "../data-loader.js";
import { db } from "../db.js";
import { getCurrentUser } from "../auth.js";
import { h, toast, escapeHtml } from "../util.js";
import { navigate } from "../router.js";
import {
  ABILITIES, ABILITY_NAMES, STANDARD_ARRAY, POINT_BUY_COST, POINT_BUY_BUDGET,
  pointBuyTotalCost, abilityModifier, formatModifier, applyBackgroundAsi, rollDie
} from "../rules-engine.js";

const STEPS = ["Class", "Species", "Background", "Abilities", "Skills", "Equipment", "Details", "Review"];

export async function renderCharacterCreator(container) {
  const ruleset = await loadRuleset();
  const state = {
    step: 0,
    classId: null,
    speciesId: null,
    backgroundId: null,
    abilityMethod: "standard", // standard | pointbuy | roll
    baseScores: { str: null, dex: null, con: null, int: null, wis: null, cha: null },
    rolledPool: null,
    asiChoice: { mode: "twoOne", plusTwo: null, plusOne: null },
    skillChoices: [],
    equipmentChoice: "A",
    alignment: ruleset.alignments[4],
    name: "",
    backstory: ""
  };

  const wrap = h("div", { class: "main narrow" });
  const stepsBar = h("div", { class: "wizard-steps" });
  const content = h("div", {});
  const nav = h("div", { class: "field-row", style: "margin-top:20px;" });
  wrap.appendChild(h("h1", {}, "Create Character"));
  wrap.appendChild(stepsBar);
  wrap.appendChild(content);
  wrap.appendChild(nav);
  container.appendChild(wrap);

  function renderStepsBar() {
    stepsBar.innerHTML = "";
    STEPS.forEach((label, i) => {
      const pill = h("div", { class: `wizard-step-pill ${i === state.step ? "active" : ""} ${i < state.step ? "done" : ""}` }, label);
      stepsBar.appendChild(pill);
    });
  }

  function renderNav() {
    nav.innerHTML = "";
    if (state.step > 0) {
      const back = h("button", { class: "btn" }, "Back");
      back.addEventListener("click", () => { state.step--; renderAll(); });
      nav.appendChild(back);
    }
    const isLast = state.step === STEPS.length - 1;
    const next = h("button", { class: "btn primary" }, isLast ? "Create Character" : "Next");
    next.addEventListener("click", async () => {
      if (isLast) { await saveCharacter(); return; }
      const err = validateStep();
      if (err) { toast(err, "error"); return; }
      state.step++; renderAll();
    });
    nav.appendChild(next);
  }

  function validateStep() {
    switch (state.step) {
      case 0: return state.classId ? null : "Choose a class first.";
      case 1: return state.speciesId ? null : "Choose a species first.";
      case 2: return state.backgroundId ? null : "Choose a background first.";
      case 3: {
        if (ABILITIES.some(a => !state.baseScores[a])) return "Assign all six ability scores.";
        if (state.abilityMethod === "pointbuy" && pointBuyTotalCost(state.baseScores) > POINT_BUY_BUDGET) return "You've spent more than 27 points.";
        if (state.abilityMethod !== "pointbuy") {
          const pool = state.abilityMethod === "standard" ? [...STANDARD_ARRAY] : [...state.rolledPool];
          const used = ABILITIES.map(a => state.baseScores[a]);
          for (const v of used) {
            const idx = pool.indexOf(v);
            if (idx === -1) return "Each rolled/array value can only be used once \u2014 fix a duplicate.";
            pool.splice(idx, 1);
          }
        }
        if (state.asiChoice.mode === "twoOne" && (!state.asiChoice.plusTwo || !state.asiChoice.plusOne || state.asiChoice.plusTwo === state.asiChoice.plusOne)) return "Choose two different background abilities to improve.";
        return null;
      }
      case 4: {
        const cls = findById(ruleset.classes, state.classId);
        if (state.skillChoices.length !== cls.skillChoices.count) return `Choose exactly ${cls.skillChoices.count} skills.`;
        return null;
      }
      case 5: return null;
      case 6: return state.name.trim() ? null : "Give your character a name.";
      default: return null;
    }
  }

  function renderAll() {
    renderStepsBar();
    content.innerHTML = "";
    const steps = [renderClassStep, renderSpeciesStep, renderBackgroundStep, renderAbilitiesStep, renderSkillsStep, renderEquipmentStep, renderDetailsStep, renderReviewStep];
    steps[state.step](content);
    renderNav();
  }

  // ---------------- Step 0: Class ----------------
  function renderClassStep(root) {
    root.appendChild(h("p", {}, "Your class defines your talents, hit points, and tactics."));
    const grid = h("div", { class: "grid cols-2" });
    ruleset.classes.forEach(cls => {
      const card = h("div", { class: `choice-card ${state.classId === cls.id ? "selected" : ""}` });
      card.innerHTML = `
        <h4>${cls.name}</h4>
        <div class="meta">d${cls.hitDie} Hit Die \u2022 ${cls.primaryAbility.map(a => ABILITY_NAMES[a]).join("/")} \u2022 ${cls.subclassLabel} at level ${cls.subclassLevel}</div>
        <ul><li>Saves: ${cls.savingThrows.map(a => ABILITY_NAMES[a]).join(", ")}</li>
        <li>Choose ${cls.skillChoices.count} skills</li>
        <li>Subclasses: ${cls.subclasses.join(", ")}</li></ul>
      `;
      card.addEventListener("click", () => { state.classId = cls.id; state.skillChoices = []; renderAll(); });
      grid.appendChild(card);
    });
    root.appendChild(grid);
  }

  // ---------------- Step 1: Species ----------------
  function renderSpeciesStep(root) {
    root.appendChild(h("p", {}, "Species grants special traits. Per 2024 rules, ability score increases come from your background, not your species."));
    const grid = h("div", { class: "grid cols-2" });
    ruleset.species.forEach(sp => {
      const card = h("div", { class: `choice-card ${state.speciesId === sp.id ? "selected" : ""}` });
      card.innerHTML = `
        <h4>${sp.name}</h4>
        <div class="meta">Size: ${sp.size.join(" or ")} \u2022 Speed: ${sp.speed} ft.</div>
        <ul>${sp.traits.map(t => `<li>${t}</li>`).join("")}</ul>
      `;
      card.addEventListener("click", () => { state.speciesId = sp.id; renderAll(); });
      grid.appendChild(card);
    });
    root.appendChild(grid);
  }

  // ---------------- Step 2: Background ----------------
  function renderBackgroundStep(root) {
    root.appendChild(h("p", {}, "Background grants an origin feat, two skills, a tool proficiency, and the three abilities you can improve in the next step."));
    const grid = h("div", { class: "grid cols-2" });
    ruleset.backgrounds.forEach(bg => {
      const card = h("div", { class: `choice-card ${state.backgroundId === bg.id ? "selected" : ""}` });
      card.innerHTML = `
        <h4>${bg.name}</h4>
        <div class="meta">Abilities: ${bg.abilityScores.map(a => ABILITY_NAMES[a]).join(", ")}</div>
        <ul>
          <li>Feat: ${bg.feat}</li>
          <li>Skills: ${bg.skills.map(s => findById(ruleset.skills, s)?.name).join(", ")}</li>
          <li>Tool: ${bg.tool}</li>
        </ul>
      `;
      card.addEventListener("click", () => {
        state.backgroundId = bg.id;
        state.asiChoice = { mode: "twoOne", plusTwo: null, plusOne: null };
        renderAll();
      });
      grid.appendChild(card);
    });
    root.appendChild(grid);
  }

  // ---------------- Step 3: Abilities ----------------
  function renderAbilitiesStep(root) {
    const cls = findById(ruleset.classes, state.classId);
    const bg = findById(ruleset.backgrounds, state.backgroundId);

    const methodRow = h("div", { class: "field-row" });
    [["standard", "Standard Array (15,14,13,12,10,8)"], ["pointbuy", "Point Buy (27 points)"], ["roll", "Roll 4d6 drop lowest"]].forEach(([val, label]) => {
      const btn = h("button", { class: `btn sm ${state.abilityMethod === val ? "primary" : ""}` }, label);
      btn.addEventListener("click", () => {
        state.abilityMethod = val;
        state.baseScores = { str: null, dex: null, con: null, int: null, wis: null, cha: null };
        state.rolledPool = null;
        renderAll();
      });
      methodRow.appendChild(btn);
    });
    root.appendChild(methodRow);

    const card = h("div", { class: "card" });
    card.appendChild(h("h3", {}, `Recommended for ${cls.name}: ${cls.primaryAbility.map(a => ABILITY_NAMES[a]).join(" / ")} first`));

    if (state.abilityMethod === "roll" && !state.rolledPool) {
      state.rolledPool = Array.from({ length: 6 }, () => {
        const rolls = [rollDie(6), rollDie(6), rollDie(6), rollDie(6)].sort((a, b) => b - a);
        return rolls[0] + rolls[1] + rolls[2];
      });
    }
    const pool = state.abilityMethod === "standard" ? [...STANDARD_ARRAY] : state.abilityMethod === "roll" ? state.rolledPool : null;

    const grid = h("div", { class: "ability-grid" });
    ABILITIES.forEach(a => {
      const box = h("div", { class: "ability-box" });
      const label = h("div", { class: "name" }, ABILITY_NAMES[a]);
      box.appendChild(label);

      if (state.abilityMethod === "pointbuy") {
        const val = state.baseScores[a] || 8;
        const scoreEl = h("div", { class: "score" }, String(val));
        box.appendChild(scoreEl);
        const row = h("div", { style: "display:flex; gap:4px; justify-content:center;" });
        const minus = h("button", { class: "icon-btn" }, "\u2212");
        const plus = h("button", { class: "icon-btn" }, "+");
        minus.addEventListener("click", () => { state.baseScores[a] = Math.max(8, (state.baseScores[a] || 8) - 1); renderAll(); });
        plus.addEventListener("click", () => {
          const next = Math.min(15, (state.baseScores[a] || 8) + 1);
          const trial = { ...state.baseScores, [a]: next };
          if (pointBuyTotalCost({ ...trial, ...Object.fromEntries(ABILITIES.filter(x => !trial[x]).map(x => [x, 8])) }) <= POINT_BUY_BUDGET) {
            state.baseScores[a] = next; renderAll();
          } else toast("Not enough points left", "error");
        });
        row.appendChild(minus); row.appendChild(plus);
        box.appendChild(row);
        if (!state.baseScores[a]) state.baseScores[a] = 8;
        const mod = h("div", { class: "mod" }, formatModifier(abilityModifier(state.baseScores[a])));
        box.appendChild(mod);
      } else {
        const select = h("select", {});
        select.appendChild(h("option", { value: "" }, "\u2014"));
        (pool || []).forEach(v => {
          select.appendChild(h("option", { value: v, selected: state.baseScores[a] === v ? "selected" : null }, String(v)));
        });
        select.value = state.baseScores[a] || "";
        select.addEventListener("change", () => {
          state.baseScores[a] = select.value ? parseInt(select.value, 10) : null;
          renderAll();
        });
        box.appendChild(select);
        const mod = h("div", { class: "mod" }, state.baseScores[a] ? formatModifier(abilityModifier(state.baseScores[a])) : "\u2014");
        box.appendChild(mod);
      }
      grid.appendChild(box);
    });
    card.appendChild(grid);
    if (state.abilityMethod === "pointbuy") {
      const spent = pointBuyTotalCost(Object.fromEntries(ABILITIES.map(a => [a, state.baseScores[a] || 8])));
      card.appendChild(h("p", { style: "margin-top:10px;" }, `Points spent: ${spent} / ${POINT_BUY_BUDGET}`));
    }
    if (state.abilityMethod === "roll") {
      card.appendChild(h("p", { style: "margin-top:10px;" }, `Rolled pool: ${state.rolledPool.join(", ")} \u2014 assign each to an ability above (each value can be used once).`));
      const reroll = h("button", { class: "btn sm" }, "Reroll");
      reroll.addEventListener("click", () => { state.rolledPool = null; state.baseScores = { str: null, dex: null, con: null, int: null, wis: null, cha: null }; renderAll(); });
      card.appendChild(reroll);
    }
    root.appendChild(card);

    // Background ASI
    const asiCard = h("div", { class: "card" });
    asiCard.appendChild(h("h3", {}, `Background Bonus \u2014 ${bg.name}`));
    asiCard.appendChild(h("p", {}, `Increase one of ${bg.abilityScores.map(a => ABILITY_NAMES[a]).join("/")} by 2 and a different one by 1, or all three by 1.`));
    const modeRow = h("div", { class: "field-row" });
    const allOneBtn = h("button", { class: `btn sm ${state.asiChoice.mode === "allOne" ? "primary" : ""}` }, "+1 to all three");
    const twoOneBtn = h("button", { class: `btn sm ${state.asiChoice.mode === "twoOne" ? "primary" : ""}` }, "+2 / +1 split");
    allOneBtn.addEventListener("click", () => { state.asiChoice = { mode: "allOne" }; renderAll(); });
    twoOneBtn.addEventListener("click", () => { state.asiChoice = { mode: "twoOne", plusTwo: null, plusOne: null }; renderAll(); });
    modeRow.appendChild(twoOneBtn); modeRow.appendChild(allOneBtn);
    asiCard.appendChild(modeRow);

    if (state.asiChoice.mode === "twoOne") {
      const row = h("div", { class: "field-row" });
      const plus2Sel = h("select", {});
      plus2Sel.appendChild(h("option", { value: "" }, "+2 to\u2026"));
      bg.abilityScores.forEach(a => plus2Sel.appendChild(h("option", { value: a, selected: state.asiChoice.plusTwo === a ? "selected" : null }, ABILITY_NAMES[a])));
      plus2Sel.value = state.asiChoice.plusTwo || "";
      plus2Sel.addEventListener("change", () => { state.asiChoice.plusTwo = plus2Sel.value; renderAll(); });

      const plus1Sel = h("select", {});
      plus1Sel.appendChild(h("option", { value: "" }, "+1 to\u2026"));
      bg.abilityScores.forEach(a => plus1Sel.appendChild(h("option", { value: a, selected: state.asiChoice.plusOne === a ? "selected" : null }, ABILITY_NAMES[a])));
      plus1Sel.value = state.asiChoice.plusOne || "";
      plus1Sel.addEventListener("change", () => { state.asiChoice.plusOne = plus1Sel.value; renderAll(); });

      row.appendChild(plus2Sel); row.appendChild(plus1Sel);
      asiCard.appendChild(row);
    }

    if (ABILITIES.every(a => state.baseScores[a])) {
      const finalScores = applyBackgroundAsi(state.baseScores, bg, state.asiChoice);
      const preview = h("div", { class: "ability-grid", style: "margin-top:14px;" });
      ABILITIES.forEach(a => {
        const box = h("div", { class: "ability-box" });
        box.innerHTML = `<div class="name">${ABILITY_NAMES[a]}</div><div class="score">${finalScores[a]}</div><div class="mod">${formatModifier(abilityModifier(finalScores[a]))}</div>`;
        preview.appendChild(box);
      });
      asiCard.appendChild(h("p", { style: "margin-top:10px;" }, "Final scores after background bonus:"));
      asiCard.appendChild(preview);
    }
    root.appendChild(asiCard);
  }

  // ---------------- Step 4: Skills ----------------
  function renderSkillsStep(root) {
    const cls = findById(ruleset.classes, state.classId);
    const bg = findById(ruleset.backgrounds, state.backgroundId);
    root.appendChild(h("p", {}, `${bg.name} already grants proficiency in ${bg.skills.map(s => findById(ruleset.skills, s)?.name).join(" and ")}. Choose ${cls.skillChoices.count} more from your class list.`));
    const grid = h("div", { class: "grid cols-3" });
    cls.skillChoices.options.forEach(skillId => {
      const skill = findById(ruleset.skills, skillId);
      const grantedByBg = bg.skills.includes(skillId);
      const selected = state.skillChoices.includes(skillId);
      const card = h("div", { class: `choice-card ${selected ? "selected" : ""}`, style: grantedByBg ? "opacity:0.5;" : "" });
      card.innerHTML = `<h4 style="font-size:0.85rem;">${skill.name}</h4><div class="meta">${ABILITY_NAMES[skill.ability]}${grantedByBg ? " \u2014 already granted" : ""}</div>`;
      if (!grantedByBg) {
        card.addEventListener("click", () => {
          if (selected) { state.skillChoices = state.skillChoices.filter(s => s !== skillId); }
          else {
            if (state.skillChoices.length >= cls.skillChoices.count) { toast(`You can only choose ${cls.skillChoices.count}`, "error"); return; }
            state.skillChoices.push(skillId);
          }
          renderAll();
        });
      }
      grid.appendChild(card);
    });
    root.appendChild(grid);
    root.appendChild(h("p", { style: "margin-top:12px;" }, `Selected: ${state.skillChoices.length} / ${cls.skillChoices.count}`));
  }

  // ---------------- Step 5: Equipment ----------------
  function renderEquipmentStep(root) {
    const cls = findById(ruleset.classes, state.classId);
    root.appendChild(h("p", {}, "Choose your starting equipment package."));
    const grid = h("div", { class: "grid cols-2" });
    ["A", "B"].forEach((opt, i) => {
      const card = h("div", { class: `choice-card ${state.equipmentChoice === opt ? "selected" : ""}` });
      card.innerHTML = `<h4>Option ${opt}</h4><p style="color:var(--text-dim); font-size:0.85rem;">${cls.startingEquipment[i]}</p>`;
      card.addEventListener("click", () => { state.equipmentChoice = opt; renderAll(); });
      grid.appendChild(card);
    });
    root.appendChild(grid);
  }

  // ---------------- Step 6: Details ----------------
  function renderDetailsStep(root) {
    const card = h("div", { class: "card" });
    const nameLabel = h("label", {}, "Character name");
    const nameInput = h("input", { type: "text", value: state.name });
    nameInput.addEventListener("input", () => { state.name = nameInput.value; });
    card.appendChild(nameLabel); card.appendChild(nameInput);

    const alignLabel = h("label", {}, "Alignment");
    const alignSel = h("select", {});
    ruleset.alignments.forEach(a => alignSel.appendChild(h("option", { value: a, selected: state.alignment === a ? "selected" : null }, a)));
    alignSel.addEventListener("change", () => { state.alignment = alignSel.value; });
    card.appendChild(alignLabel); card.appendChild(alignSel);

    const bioLabel = h("label", {}, "Backstory / appearance (optional)");
    const bioInput = h("textarea", {});
    bioInput.value = state.backstory;
    bioInput.addEventListener("input", () => { state.backstory = bioInput.value; });
    card.appendChild(bioLabel); card.appendChild(bioInput);

    root.appendChild(card);
  }

  // ---------------- Step 7: Review ----------------
  function renderReviewStep(root) {
    const cls = findById(ruleset.classes, state.classId);
    const sp = findById(ruleset.species, state.speciesId);
    const bg = findById(ruleset.backgrounds, state.backgroundId);
    const finalScores = applyBackgroundAsi(state.baseScores, bg, state.asiChoice);

    const card = h("div", { class: "card parchment" });
    card.innerHTML = `
      <h2>${escapeHtml(state.name) || "Unnamed"}</h2>
      <p>${sp.name} ${cls.name} \u2022 ${bg.name} \u2022 ${state.alignment}</p>
      <div class="ability-grid">
        ${ABILITIES.map(a => `<div class="ability-box"><div class="name">${ABILITY_NAMES[a]}</div><div class="score">${finalScores[a]}</div><div class="mod">${formatModifier(abilityModifier(finalScores[a]))}</div></div>`).join("")}
      </div>
      <p style="margin-top:14px;"><strong>Skills:</strong> ${[...bg.skills, ...state.skillChoices].map(s => findById(ruleset.skills, s)?.name).join(", ")}</p>
      <p><strong>Origin feat:</strong> ${bg.feat}</p>
      <p><strong>Equipment:</strong> ${cls.startingEquipment[state.equipmentChoice === "A" ? 0 : 1]}</p>
      ${state.backstory ? `<p><strong>Backstory:</strong> ${escapeHtml(state.backstory)}</p>` : ""}
    `;
    root.appendChild(card);
    root.appendChild(h("p", {}, "Review everything above, then create your character."));
  }

  async function saveCharacter() {
    const user = getCurrentUser();
    const bg = findById(ruleset.backgrounds, state.backgroundId);
    const finalScores = applyBackgroundAsi(state.baseScores, bg, state.asiChoice);
    const cls = findById(ruleset.classes, state.classId);

    const character = {
      ownerUid: user.uid,
      ownerName: user.displayName,
      name: state.name.trim(),
      classId: state.classId,
      classes: [{ classId: state.classId, level: 1, subclassId: null }],
      speciesId: state.speciesId,
      backgroundId: state.backgroundId,
      alignment: state.alignment,
      backstory: state.backstory,
      appearance: { height: "", weight: "", eyes: "", hair: "", faction: "" },
      level: 1,
      xp: 0,
      abilityScores: finalScores,
      abilityOverrides: {},
      skillOverrides: {},
      savingThrowOverrides: {},
      skillProficiencies: [...bg.skills, ...state.skillChoices],
      skillExpertise: [],
      savingThrowProficiencies: cls.savingThrows,
      equipmentChoice: state.equipmentChoice,
      weaponMasteries: [],
      featChoices: {},
      hp: { current: null, max: null, temp: 0 },
      hitDiceUsed: 0,
      acAdjustments: [],
      inspiration: false,
      currency: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
      resourcesUsed: {},
      spellsPrepared: [],
      spellSlotsUsed: {},
      pactSlotsUsed: 0,
      campaignId: null,
      notes: ""
    };
    try {
      const id = await db.characters.create(character);
      await grantStartingEquipment(id, cls, state.equipmentChoice);
      toast("Character created!");
      navigate(`/character/${id}`);
    } catch (e) { toast(e.message, "error"); }
  }

  async function grantStartingEquipment(characterId, cls, choice) {
    const idx = choice === "B" ? 1 : 0;
    const items = cls.startingEquipmentItems?.[idx] || [];
    for (const spec of items) {
      if (spec.category === "weapon") {
        const entry = findById(ruleset.equipment.weapons, spec.catalogId);
        if (!entry) continue;
        await db.inventory.add(characterId, {
          type: "weapon", name: entry.name, quantity: spec.quantity, equipped: false, isCustom: false, catalogId: entry.id,
          weightLb: parseFloat(entry.weight) || 0, valueGp: 0,
          weaponData: { damageDice: entry.damageDice, damageType: entry.damageType, ability: entry.ability, ranged: entry.ranged, ammoType: entry.ammoType, properties: entry.properties, proficient: true, attackBonus: 0, damageBonus: 0 }
        });
      } else if (spec.category === "armor") {
        const entry = findById(ruleset.equipment.armor, spec.catalogId);
        if (!entry) continue;
        await db.inventory.add(characterId, {
          type: "armor", name: entry.name, quantity: spec.quantity, equipped: false, isCustom: false, catalogId: entry.id, valueGp: 0,
          armorData: { armorType: entry.armorType, baseAC: entry.baseAC, dexBonus: entry.dexBonus, strengthRequirement: entry.strengthRequirement, stealthDisadvantage: entry.stealthDisadvantage }
        });
      } else if (spec.category === "ammo") {
        const entry = findById(ruleset.equipment.ammo, spec.catalogId);
        if (!entry) continue;
        await db.inventory.add(characterId, { type: "ammo", name: entry.name, quantity: entry.quantity * spec.quantity, ammoType: entry.ammoType, isCustom: false, valueGp: 0 });
      } else if (spec.category === "gear") {
        const entry = findById(ruleset.equipment.gear, spec.catalogId);
        if (!entry) continue;
        await db.inventory.add(characterId, { type: "gear", name: entry.name, quantity: spec.quantity, isCustom: false, isContainer: !!entry.isContainer, valueGp: 0 });
      }
    }
    const gold = cls.startingGold?.[idx] || 0;
    if (gold > 0) await db.characters.update(characterId, { currency: { cp: 0, sp: 0, ep: 0, gp: gold, pp: 0 } });
  }

  renderAll();
}
