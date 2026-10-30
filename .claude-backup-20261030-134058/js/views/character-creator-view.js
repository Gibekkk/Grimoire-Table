import { loadRuleset, findById } from "../data-loader.js";
import { db } from "../db.js";
import { getCurrentUser } from "../auth.js";
import { h, toast, escapeHtml } from "../util.js";
import { navigate } from "../router.js";
import {
  ABILITIES, ABILITY_NAMES, STANDARD_ARRAY, POINT_BUY_BUDGET,
  pointBuyTotalCost, abilityModifier, formatModifier, rollDie, estimateArmorClass, proficiencyBonus
} from "../rules-engine.js";
import {
  newBuildState, sanitize, selectedDefs, originFeats, grantedSkills, allSkillProficiencies,
  classLevel1Needs, masteryWeapons, cantripCount, preparedCount, classSpellList, hasSpellStep,
  finalScores, toolCatalog, toolsByCategory, knownLanguages, speciesCantrips, speciesOption,
  buildCharacter, startingInventory, STANDARD_LANGUAGES_FALLBACK,
  asiLevelsFor, buildCasting, buildMaxSpellLevel, spellbookSize, levelFeatOptions, scoresBeforeLevel
} from "../character-build.js";

// Step ids in PHB 2024 order: Class → Origin (Background, Species, Languages) → Ability
// Scores → choices → Equipment → Details. Spells only shows for casters / Magic Initiate.
const ALL_STEPS = [
  { id: "class", label: "Class" },
  { id: "background", label: "Background" },
  { id: "species", label: "Species" },
  { id: "abilities", label: "Abilities" },
  { id: "levels", label: "Level Choices" },
  { id: "proficiencies", label: "Skills & Languages" },
  { id: "features", label: "Features" },
  { id: "spells", label: "Spells" },
  { id: "equipment", label: "Equipment" },
  { id: "details", label: "Details" },
  { id: "review", label: "Review" }
];

const draftKey = (uid) => `gt_character_draft_${uid}`;

function md(text) {
  // Feature/spell text: escape, then bold the "Lead-in." labels the PHB uses.
  return escapeHtml(text || "").split("\n").map(p => p.replace(/^([A-Z][A-Za-z' ,\-()/]{1,48}\.)(\s)/, "<strong>$1</strong>$2")).map(p => `<p>${p}</p>`).join("");
}

export async function renderCharacterCreator(container) {
  const ruleset = await loadRuleset();
  const user = getCurrentUser();
  let state = newBuildState(ruleset);
  let saving = false;

  // Restore an unfinished draft (refreshes / accidental navigation don't lose progress)
  try {
    const saved = JSON.parse(localStorage.getItem(draftKey(user.uid)) || "null");
    if (saved && saved.classId) state = Object.assign(newBuildState(ruleset), saved);
  } catch { /* ignore corrupt drafts */ }

  const wrap = h("div", { class: "main narrow creator" });
  const headRow = h("div", { style: "display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;" });
  headRow.appendChild(h("h1", { style: "margin:0;" }, "Create Character"));
  const resetBtn = h("button", { class: "btn ghost sm" }, "Start over");
  resetBtn.addEventListener("click", () => {
    if (!confirm("Discard this character and start over?")) return;
    state = newBuildState(ruleset);
    try { localStorage.removeItem(draftKey(user.uid)); } catch { /* noop */ }
    renderAll();
  });
  headRow.appendChild(resetBtn);
  const stepsBar = h("div", { class: "wizard-steps" });
  const content = h("div", { class: "creator-content" });
  const nav = h("div", { class: "creator-nav" });
  wrap.appendChild(headRow);
  wrap.appendChild(stepsBar);
  wrap.appendChild(content);
  wrap.appendChild(nav);
  container.appendChild(wrap);

  const steps = () => ALL_STEPS.filter(s => {
    if (s.id === "spells") return hasSpellStep(state, ruleset);
    if (s.id === "features") return hasFeatureStep();
    if (s.id === "levels") return (state.startLevel || 1) > 1;
    return true;
  });
  const currentStep = () => steps()[Math.min(state.step, steps().length - 1)];

  function persist() {
    try { localStorage.setItem(draftKey(user.uid), JSON.stringify(state)); } catch { /* quota / private mode */ }
  }

  function hasFeatureStep() {
    const { cls } = selectedDefs(state, ruleset);
    const n = classLevel1Needs(cls, state.startLevel);
    const featNeeds = originFeats(state, ruleset).some(f => ["skilled", "musician", "crafter"].includes(f.feat.id));
    return !!(n.weaponMasteries || n.fightingStyle || n.divineOrder || n.primalOrder || n.invocations || n.expertise || featNeeds);
  }

  function renderStepsBar() {
    stepsBar.innerHTML = "";
    const list = steps();
    list.forEach((s, i) => {
      const pill = h("button", { class: `wizard-step-pill ${i === state.step ? "active" : ""} ${i < state.step ? "done" : ""}`, type: "button" }, `${i + 1}. ${s.label}`);
      pill.disabled = i > state.step && !!firstError(i);
      pill.addEventListener("click", () => {
        if (i <= state.step) { state.step = i; renderAll(); return; }
        const err = firstError(i);
        if (err) { toast(err, "error"); return; }
        state.step = i; renderAll();
      });
      stepsBar.appendChild(pill);
    });
  }

  // First validation error among steps before `target` (so pills can jump ahead safely).
  function firstError(target) {
    const list = steps();
    for (let i = 0; i < target; i++) {
      const err = validate(list[i].id);
      if (err) return `${list[i].label}: ${err}`;
    }
    return null;
  }

  function renderNav() {
    nav.innerHTML = "";
    const list = steps();
    if (state.step > 0) {
      const back = h("button", { class: "btn" }, "← Back");
      back.addEventListener("click", () => { state.step--; renderAll(); });
      nav.appendChild(back);
    } else nav.appendChild(h("span"));
    const status = h("span", { class: "creator-status" });
    const err = validate(currentStep().id);
    status.textContent = err || "";
    nav.appendChild(status);
    const isLast = state.step === list.length - 1;
    const next = h("button", { class: "btn primary" }, isLast ? "Create Character" : "Next →");
    next.addEventListener("click", async () => {
      const e = validate(currentStep().id);
      if (e) { toast(e, "error"); return; }
      if (isLast) { await saveCharacter(next); return; }
      state.step++; renderAll();
    });
    nav.appendChild(next);
  }

  function validate(stepId) {
    const { cls, bg, sp } = selectedDefs(state, ruleset);
    switch (stepId) {
      case "class": return cls ? null : "Choose a class.";
      case "background": {
        if (!bg) return "Choose a background.";
        if (bg.toolChoice && !state.backgroundTool) return `Choose your ${bg.tool.replace(/\s*\(one kind\)/, "")}.`;
        return null;
      }
      case "species": {
        if (!sp) return "Choose a species.";
        if (sp.size.length > 1 && !state.size) return "Choose your size.";
        for (const ch of sp.choices || []) if (!state.speciesChoices[ch.id]) return `Choose ${ch.label}.`;
        return null;
      }
      case "abilities": {
        if (ABILITIES.some(a => !state.baseScores[a])) return "Assign all six ability scores.";
        if (state.abilityMethod === "pointbuy" && pointBuyTotalCost(state.baseScores) > POINT_BUY_BUDGET) return "You've spent more than 27 points.";
        if (state.abilityMethod !== "pointbuy") {
          const pool = state.abilityMethod === "standard" ? [...STANDARD_ARRAY] : [...(state.rolledPool || [])];
          for (const a of ABILITIES) {
            const idx = pool.indexOf(state.baseScores[a]);
            if (idx === -1) return "Each value can only be used once — fix a duplicate.";
            pool.splice(idx, 1);
          }
        }
        if (state.asiChoice.mode === "twoOne" && (!state.asiChoice.plusTwo || !state.asiChoice.plusOne || state.asiChoice.plusTwo === state.asiChoice.plusOne)) return "Choose two different abilities for the background bonus.";
        return null;
      }
      case "levels": {
        const n = classLevel1Needs(cls, state.startLevel);
        if (n.subclass && !state.subclassId) return `Choose your ${cls.subclassLabel}.`;
        for (const l of asiLevelsFor(cls, state.startLevel)) {
          const c = state.levelChoices[l];
          if (!c) return `Level ${l}: choose an Ability Score Improvement or a feat.`;
          if (c.mode === "asi" && (!c.a || (c.split === "oneone" && (!c.b || c.b === c.a)))) return `Level ${l}: choose which abilities increase.`;
          if (c.mode === "feat") {
            const f = findById(ruleset.feats, c.featId);
            if (!f) return `Level ${l}: choose a feat.`;
            if (f.asi?.abilities?.length && !c.featAbility) return `Level ${l}: choose the ability ${f.name} increases.`;
          }
        }
        if (state.hpMethod === "roll") for (let l = 2; l <= state.startLevel; l++) if (!state.hpRolls[l]) return "Roll Hit Points for every level (or switch to fixed HP).";
        return null;
      }
      case "proficiencies": {
        if (state.skillChoices.length !== cls.skillChoices.count) return `Choose ${cls.skillChoices.count} class skills (${state.skillChoices.length} chosen).`;
        if (cls.toolChoices && state.classTools.length !== cls.toolChoices.count) return `Choose ${cls.toolChoices.count} tool proficienc${cls.toolChoices.count > 1 ? "ies" : "y"}.`;
        const wantLang = 2 + (classLevel1Needs(cls, state.startLevel).extraLanguage || 0);
        if (state.languages.length !== wantLang) return `Choose ${wantLang} languages.`;
        return null;
      }
      case "features": {
        const n = classLevel1Needs(cls, state.startLevel);
        if (n.fightingStyle && !state.classChoices.fightingStyle) return "Choose a Fighting Style.";
        if (n.divineOrder && !state.classChoices.divineOrder) return "Choose a Divine Order.";
        if (n.primalOrder && !state.classChoices.primalOrder) return "Choose a Primal Order.";
        if (n.invocations && state.classChoices.invocations.length !== n.invocations) return "Choose an Eldritch Invocation.";
        if (n.expertise && state.expertise.length !== n.expertise) return `Choose ${n.expertise} skills for Expertise.`;
        if (n.weaponMasteries && state.weaponMasteries.length !== n.weaponMasteries) return `Choose ${n.weaponMasteries} weapons for Weapon Mastery.`;
        for (const { source, feat } of originFeats(state, ruleset)) {
          const fc = state.featChoices[source] || {};
          if (feat.id === "skilled" && ((fc.skills?.length || 0) + (fc.tools?.length || 0)) !== 3) return "Skilled: choose 3 skills or tools.";
          if ((feat.id === "musician" || feat.id === "crafter") && (fc.tools?.length || 0) !== 3) return `${feat.name}: choose 3 tools.`;
        }
        return null;
      }
      case "spells": {
        const sc = buildCasting(state, ruleset);
        if (sc) {
          const nc = cantripCount(state, ruleset), np = preparedCount(state, ruleset), nb = spellbookSize(state);
          if (state.cantrips.length !== nc) return `Choose ${nc} cantrips (${state.cantrips.length} chosen).`;
          if (sc.spellbook && state.spellbook.length !== nb) return `Add ${nb} spells to your spellbook (${state.spellbook.length} chosen).`;
          if (state.preparedSpells.length !== np) return `Prepare ${np} spells (${state.preparedSpells.length} chosen).`;
        }
        for (const { source, feat } of originFeats(state, ruleset)) {
          if (feat.id !== "magic-initiate") continue;
          const fc = state.featChoices[source] || {};
          if (!fc.list) return "Magic Initiate: choose a spell list.";
          if (!fc.ability) return "Magic Initiate: choose a spellcasting ability.";
          if ((fc.cantrips || []).length !== 2) return "Magic Initiate: choose 2 cantrips.";
          if (!fc.spell) return "Magic Initiate: choose a level 1 spell.";
        }
        return null;
      }
      case "equipment": return null;
      case "details": return state.name.trim() ? null : "Give your character a name.";
      default: return null;
    }
  }

  function renderAll() {
    sanitize(state, ruleset);
    state.step = Math.min(state.step, steps().length - 1);
    persist();
    renderStepsBar();
    content.innerHTML = "";
    const renderers = {
      class: renderClassStep, background: renderBackgroundStep, species: renderSpeciesStep,
      abilities: renderAbilitiesStep, levels: renderLevelsStep, proficiencies: renderProficienciesStep, features: renderFeaturesStep,
      spells: renderSpellsStep, equipment: renderEquipmentStep, details: renderDetailsStep, review: renderReviewStep
    };
    renderers[currentStep().id](content);
    renderNav();
  }
  // Re-render while keeping the page scroll position (choice grids re-render on every click)
  function rerender() {
    const y = window.scrollY;
    renderAll();
    window.scrollTo(0, y);
  }

  // ---------------- small UI helpers ----------------
  function detailPanel(title, bodyHtml) {
    const d = h("details", { class: "creator-detail" });
    d.appendChild(h("summary", {}, title));
    d.appendChild(h("div", { class: "creator-detail-body" }, bodyHtml));
    return d;
  }
  // Multi-select grid: items [{id, label, meta, disabled, title}], keeps `selected` (array) ≤ max.
  function pickGrid(items, selected, max, onChange, cols = "cols-3") {
    const grid = h("div", { class: `grid ${cols} pick-grid` });
    items.forEach(it => {
      const on = selected.includes(it.id);
      const card = h("button", { type: "button", class: `choice-card compact ${on ? "selected" : ""} ${it.disabled ? "disabled" : ""}`, title: it.title || "" });
      card.innerHTML = `<h4>${escapeHtml(it.label)}</h4>${it.meta ? `<div class="meta">${it.meta}</div>` : ""}`;
      if (!it.disabled) card.addEventListener("click", () => {
        let next = [...selected];
        if (on) next = next.filter(x => x !== it.id);
        else if (max === 1) next = [it.id];
        else if (next.length >= max) { toast(`You can choose ${max}. Deselect one first.`, "error"); return; }
        else next.push(it.id);
        onChange(next);
        rerender();
      });
      grid.appendChild(card);
    });
    return grid;
  }
  function counter(n, max) { return `<span class="pick-counter ${n === max ? "ok" : ""}">${n} / ${max}</span>`; }
  const skillName = (id) => findById(ruleset.skills, id)?.name || id;

  // ---------------- Class ----------------
  function renderClassStep(root) {
    root.appendChild(h("p", { class: "step-intro" }, "Your class is your primary training: it sets your Hit Points, proficiencies, and the features you gain as you level. Click a class to see its details."));
    const grid = h("div", { class: "grid cols-3" });
    ruleset.classes.forEach(cls => {
      const card = h("button", { type: "button", class: `choice-card ${state.classId === cls.id ? "selected" : ""}` });
      card.innerHTML = `
        <h4>${cls.name}</h4>
        <div class="meta">d${cls.hitDie} Hit Die • ${cls.primaryAbility.map(a => ABILITY_NAMES[a]).join(" or ")}</div>
        <div class="meta">${cls.spellcasting ? `${cls.spellcasting.type === "full" ? "Full" : cls.spellcasting.type === "half" ? "Half" : "Pact"} caster` : "Martial"} • Saves ${cls.savingThrows.map(a => a.toUpperCase()).join("/")}</div>`;
      card.addEventListener("click", () => {
        if (state.classId !== cls.id) {
          state.classId = cls.id; state.skillChoices = []; state.weaponMasteries = []; state.expertise = [];
          state.cantrips = []; state.preparedSpells = []; state.spellbook = []; state.classTools = [];
          state.classChoices = { fightingStyle: null, divineOrder: null, primalOrder: null, invocations: [] };
          state.subclassId = null; state.levelChoices = {}; state.hpRolls = {};
          state.classEquip = cls.equipmentOptions[0]?.id || "A";
        }
        rerender();
      });
      grid.appendChild(card);
    });
    root.appendChild(grid);

    const cls = findById(ruleset.classes, state.classId);
    if (!cls) return;
    const lvlCard = h("div", { class: "card" });
    lvlCard.appendChild(h("h3", {}, "Starting Level & Hit Points"));
    const lvlRow = h("div", { class: "field-row wrap", style: "align-items:center;" });
    const lvlSel = h("select", { style: "width:auto; margin:0;" });
    for (let l = 1; l <= 20; l++) lvlSel.appendChild(h("option", { value: String(l), selected: state.startLevel === l ? "selected" : null }, `Level ${l}`));
    lvlSel.addEventListener("change", () => { state.startLevel = parseInt(lvlSel.value, 10); rerender(); });
    lvlRow.appendChild(lvlSel);
    [["fixed", "Fixed HP (average)"], ["roll", "Roll HP"]].forEach(([m, label]) => {
      const b = h("button", { type: "button", class: `btn sm ${state.hpMethod === m ? "primary" : ""}` }, label);
      b.addEventListener("click", () => { state.hpMethod = m; rerender(); });
      lvlRow.appendChild(b);
    });
    lvlCard.appendChild(lvlRow);
    lvlCard.appendChild(h("p", { class: "meta", style: "margin-top:8px;" }, state.startLevel > 1 ? `You'll make the choices for levels 2\u2013${state.startLevel} (subclass, Ability Score Improvements or feats, Hit Points) in the Level Choices step.` : "Most campaigns start at level 1. You can level up any time from the character sheet."));
    root.appendChild(lvlCard);
    const info = h("div", { class: "card creator-info" });
    const feats1 = ruleset.classFeatures.filter(f => f.classId === cls.id && !f.subclassId && f.level <= Math.max(3, state.startLevel));
    info.innerHTML = `
      <h3>${cls.name}</h3>
      <div class="info-grid">
        <div><span class="lbl">Hit Points at Level 1</span>${cls.hitDie} + Con modifier</div>
        <div><span class="lbl">Saving Throws</span>${cls.savingThrows.map(a => ABILITY_NAMES[a]).join(", ")}</div>
        <div><span class="lbl">Skills</span>Choose ${cls.skillChoices.count}${cls.skillChoices.options === "any" ? " (any)" : `: ${cls.skillChoices.options.map(skillName).join(", ")}`}</div>
        <div><span class="lbl">Armor Training</span>${cls.armorTraining.length ? cls.armorTraining.map(a => a === "shield" ? "Shields" : a[0].toUpperCase() + a.slice(1)).join(", ") : "None"}</div>
        <div><span class="lbl">Weapons</span>${cls.weaponTraining.map(w => ({ simple: "Simple", martial: "Martial", "martial-light": "Martial (Light)", "martial-finesse-light": "Martial (Finesse or Light)" }[w] || w)).join(", ")}</div>
        <div><span class="lbl">${cls.subclassLabel}</span>Level ${cls.subclassLevel}: ${cls.subclasses.map(s => s.name).join(", ")}</div>
      </div>`;
    feats1.forEach(f => info.appendChild(detailPanel(`Level ${f.level}: ${f.name}`, md(f.description))));
    root.appendChild(info);
  }

  // ---------------- Background ----------------
  function renderBackgroundStep(root) {
    root.appendChild(h("p", { class: "step-intro" }, "Your background grants two skills, a tool, an Origin feat, starting gear, and the three abilities you can raise in the Abilities step."));
    const grid = h("div", { class: "grid cols-3" });
    ruleset.backgrounds.forEach(bg => {
      const card = h("button", { type: "button", class: `choice-card ${state.backgroundId === bg.id ? "selected" : ""}` });
      card.innerHTML = `<h4>${bg.name}</h4>
        <div class="meta">${bg.abilityScores.map(a => a.toUpperCase()).join(" / ")} • ${escapeHtml(bg.feat)}</div>
        <div class="meta">${bg.skills.map(skillName).join(", ")}</div>`;
      card.addEventListener("click", () => {
        if (state.backgroundId !== bg.id) { state.backgroundId = bg.id; state.asiChoice = { mode: "twoOne", plusTwo: null, plusOne: null }; state.backgroundTool = null; }
        rerender();
      });
      grid.appendChild(card);
    });
    root.appendChild(grid);
    const bg = findById(ruleset.backgrounds, state.backgroundId);
    if (!bg) return;
    const feat = findById(ruleset.feats, bg.featId);
    const info = h("div", { class: "card creator-info" });
    info.innerHTML = `<h3>${bg.name}</h3>
      <div class="info-grid">
        <div><span class="lbl">Ability Scores</span>${bg.abilityScores.map(a => ABILITY_NAMES[a]).join(", ")}</div>
        <div><span class="lbl">Skill Proficiencies</span>${bg.skills.map(skillName).join(", ")}</div>
        <div><span class="lbl">Tool Proficiency</span>${escapeHtml(bg.tool)}</div>
        <div><span class="lbl">Origin Feat</span>${escapeHtml(bg.feat)}</div>
        <div class="span2"><span class="lbl">Equipment</span>(A) ${escapeHtml(bg.equipmentText)}; or (B) ${bg.goldAlternative} GP</div>
      </div>`;
    if (bg.toolChoice) {
      const cat = bg.toolChoice;
      info.appendChild(h("label", {}, `Choose your ${bg.tool.replace(/\s*\(one kind\)/, "")}`));
      const sel = h("select", {});
      sel.appendChild(h("option", { value: "" }, "— choose —"));
      toolsByCategory(ruleset, cat).forEach(t => sel.appendChild(h("option", { value: t.id, selected: state.backgroundTool === t.id ? "selected" : null }, t.name)));
      sel.addEventListener("change", () => { state.backgroundTool = sel.value || null; rerender(); });
      info.appendChild(sel);
    }
    if (feat) info.appendChild(detailPanel(`Origin Feat: ${feat.name}`, md(feat.description)));
    root.appendChild(info);
  }

  // ---------------- Species ----------------
  function renderSpeciesStep(root) {
    root.appendChild(h("p", { class: "step-intro" }, "Your species grants innate traits. (In the 2024 rules ability score increases come from your background, not your species.)"));
    const grid = h("div", { class: "grid cols-3" });
    ruleset.species.forEach(sp => {
      const card = h("button", { type: "button", class: `choice-card ${state.speciesId === sp.id ? "selected" : ""}` });
      card.innerHTML = `<h4>${sp.name}</h4>
        <div class="meta">${sp.size.join(" or ")} • Speed ${sp.speed} ft.${sp.darkvision ? ` • Darkvision ${sp.darkvision} ft.` : ""}</div>
        <div class="meta">${sp.traits.filter(t => t.unlockLevel === 1).map(t => t.name).join(", ")}</div>`;
      card.addEventListener("click", () => {
        if (state.speciesId !== sp.id) { state.speciesId = sp.id; state.speciesChoices = {}; state.size = sp.size.length === 1 ? sp.size[0] : null; }
        rerender();
      });
      grid.appendChild(card);
    });
    root.appendChild(grid);

    const sp = findById(ruleset.species, state.speciesId);
    if (!sp) return;
    const info = h("div", { class: "card creator-info" });
    info.appendChild(h("h3", {}, sp.name));
    if (sp.size.length > 1) {
      info.appendChild(h("label", {}, "Size"));
      const row = h("div", { class: "field-row" });
      sp.size.forEach(sz => {
        const b = h("button", { type: "button", class: `btn sm ${state.size === sz ? "primary" : ""}` }, sz);
        b.addEventListener("click", () => { state.size = sz; rerender(); });
        row.appendChild(b);
      });
      info.appendChild(row);
    }
    (sp.choices || []).forEach(ch => {
      info.appendChild(h("label", { style: "margin-top:12px;" }, ch.label));
      const current = state.speciesChoices[ch.id];
      const set = (v) => { state.speciesChoices[ch.id] = v; rerender(); };
      if (ch.type === "option") {
        const g = h("div", { class: "grid cols-3" });
        ch.options.forEach(o => {
          const c = h("button", { type: "button", class: `choice-card compact ${current === o.id ? "selected" : ""}` });
          c.innerHTML = `<h4>${escapeHtml(o.name)}</h4>${o.damageType ? `<div class="meta">${o.damageType} damage</div>` : ""}${o.description ? `<div class="meta">${escapeHtml(o.description)}</div>` : ""}`;
          c.addEventListener("click", () => set(o.id));
          g.appendChild(c);
        });
        info.appendChild(g);
      } else if (ch.type === "ability") {
        const row = h("div", { class: "field-row" });
        ch.options.forEach(a => {
          const b = h("button", { type: "button", class: `btn sm ${current === a ? "primary" : ""}` }, ABILITY_NAMES[a]);
          b.addEventListener("click", () => set(a));
          row.appendChild(b);
        });
        info.appendChild(row);
      } else if (ch.type === "skill") {
        const opts = ch.options === "any" ? ruleset.skills.map(s => s.id) : ch.options;
        const bg = findById(ruleset.backgrounds, state.backgroundId);
        info.appendChild(pickGrid(opts.map(id => ({ id, label: skillName(id), disabled: bg?.skills.includes(id), title: bg?.skills.includes(id) ? "Already granted by your background" : "" })),
          current ? [current] : [], 1, (v) => { state.speciesChoices[ch.id] = v[0] || null; }));
      } else if (ch.type === "feat") {
        const bgFeat = findById(ruleset.backgrounds, state.backgroundId)?.featId;
        const feats = ruleset.feats.filter(f => f.category === ch.category && (f.repeatable || f.id !== bgFeat));
        const sel = h("select", {});
        sel.appendChild(h("option", { value: "" }, "— choose an Origin feat —"));
        feats.forEach(f => sel.appendChild(h("option", { value: f.id, selected: current === f.id ? "selected" : null }, f.name)));
        sel.addEventListener("change", () => set(sel.value || null));
        info.appendChild(sel);
        const f = findById(ruleset.feats, current);
        if (f) info.appendChild(detailPanel(f.name, md(f.description)));
      }
    });
    info.appendChild(h("h4", { style: "margin-top:16px;" }, "Traits"));
    sp.traits.forEach(t => info.appendChild(detailPanel(`${t.name}${t.unlockLevel > 1 ? ` (level ${t.unlockLevel})` : ""}`, md(t.description))));
    root.appendChild(info);
  }

  // ---------------- Abilities ----------------
  function renderAbilitiesStep(root) {
    const { cls, bg } = selectedDefs(state, ruleset);
    const methodRow = h("div", { class: "field-row wrap" });
    [["standard", "Standard Array"], ["pointbuy", "Point Buy (27)"], ["roll", "Roll 4d6"]].forEach(([val, label]) => {
      const btn = h("button", { type: "button", class: `btn sm ${state.abilityMethod === val ? "primary" : ""}` }, label);
      btn.addEventListener("click", () => {
        if (state.abilityMethod === val) return;
        state.abilityMethod = val;
        state.baseScores = val === "pointbuy" ? { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 } : { str: null, dex: null, con: null, int: null, wis: null, cha: null };
        state.rolledPool = null;
        rerender();
      });
      methodRow.appendChild(btn);
    });
    root.appendChild(methodRow);

    const card = h("div", { class: "card" });
    card.appendChild(h("h3", {}, `${cls.name}: put your highest score in ${cls.primaryAbility.map(a => ABILITY_NAMES[a]).join(" or ")}`));
    if (state.abilityMethod === "roll" && !state.rolledPool) {
      state.rolledPool = Array.from({ length: 6 }, () => {
        const rolls = [rollDie(6), rollDie(6), rollDie(6), rollDie(6)].sort((a, b) => b - a);
        return rolls[0] + rolls[1] + rolls[2];
      }).sort((a, b) => b - a);
      persist();
    }
    if (state.abilityMethod === "standard") {
      const auto = h("button", { type: "button", class: "btn sm ghost" }, "Auto-assign for my class");
      auto.addEventListener("click", () => {
        const order = [...cls.primaryAbility, "con", "dex", "wis", "str", "cha", "int"].filter((a, i, arr) => arr.indexOf(a) === i);
        order.forEach((a, i) => { state.baseScores[a] = STANDARD_ARRAY[i]; });
        rerender();
      });
      card.appendChild(auto);
    }
    const pool = state.abilityMethod === "standard" ? STANDARD_ARRAY : state.abilityMethod === "roll" ? state.rolledPool : null;
    const grid = h("div", { class: "ability-grid", style: "margin-top:10px;" });
    ABILITIES.forEach(a => {
      const box = h("div", { class: `ability-box ${cls.primaryAbility.includes(a) ? "primary" : ""}` });
      box.appendChild(h("div", { class: "name" }, ABILITY_NAMES[a]));
      if (state.abilityMethod === "pointbuy") {
        const val = state.baseScores[a] || 8;
        box.appendChild(h("div", { class: "score" }, String(val)));
        const row = h("div", { style: "display:flex; gap:4px; justify-content:center;" });
        const minus = h("button", { type: "button", class: "icon-btn" }, "−");
        const plus = h("button", { type: "button", class: "icon-btn" }, "+");
        minus.disabled = val <= 8; plus.disabled = val >= 15;
        minus.addEventListener("click", () => { state.baseScores[a] = Math.max(8, val - 1); rerender(); });
        plus.addEventListener("click", () => {
          const trial = { ...state.baseScores, [a]: Math.min(15, val + 1) };
          if (pointBuyTotalCost(trial) <= POINT_BUY_BUDGET) { state.baseScores = trial; rerender(); }
          else toast("Not enough points left", "error");
        });
        row.appendChild(minus); row.appendChild(plus);
        box.appendChild(row);
      } else {
        const select = h("select", {});
        select.appendChild(h("option", { value: "" }, "—"));
        // Only offer values not already used by another ability (duplicates in the pool stay available)
        const used = ABILITIES.filter(x => x !== a).map(x => state.baseScores[x]).filter(Boolean);
        const remaining = [...(pool || [])];
        used.forEach(v => { const i = remaining.indexOf(v); if (i >= 0) remaining.splice(i, 1); });
        [...new Set(remaining)].sort((x, y) => y - x).forEach(v => select.appendChild(h("option", { value: v }, String(v))));
        select.value = state.baseScores[a] || "";
        select.addEventListener("change", () => { state.baseScores[a] = select.value ? parseInt(select.value, 10) : null; rerender(); });
        box.appendChild(select);
      }
      const base = state.baseScores[a];
      box.appendChild(h("div", { class: "mod" }, base ? formatModifier(abilityModifier(base)) : "—"));
      grid.appendChild(box);
    });
    card.appendChild(grid);
    if (state.abilityMethod === "pointbuy") card.appendChild(h("p", { style: "margin-top:10px;" }, `Points spent: ${pointBuyTotalCost(state.baseScores)} / ${POINT_BUY_BUDGET}`));
    if (state.abilityMethod === "roll") {
      card.appendChild(h("p", { style: "margin-top:10px;" }, `Rolled: ${state.rolledPool.join(", ")} — assign each value once.`));
      const reroll = h("button", { type: "button", class: "btn sm" }, "Reroll");
      reroll.addEventListener("click", () => { state.rolledPool = null; state.baseScores = { str: null, dex: null, con: null, int: null, wis: null, cha: null }; rerender(); });
      card.appendChild(reroll);
    }
    root.appendChild(card);

    const asiCard = h("div", { class: "card" });
    asiCard.appendChild(h("h3", {}, `Background Bonus — ${bg.name}`));
    asiCard.appendChild(h("p", {}, `Increase one of ${bg.abilityScores.map(a => ABILITY_NAMES[a]).join(" / ")} by 2 and a different one by 1, or all three by 1 (max 20).`));
    const modeRow = h("div", { class: "field-row wrap" });
    const twoOneBtn = h("button", { type: "button", class: `btn sm ${state.asiChoice.mode === "twoOne" ? "primary" : ""}` }, "+2 / +1");
    const allOneBtn = h("button", { type: "button", class: `btn sm ${state.asiChoice.mode === "allOne" ? "primary" : ""}` }, "+1 / +1 / +1");
    twoOneBtn.addEventListener("click", () => { state.asiChoice = { mode: "twoOne", plusTwo: null, plusOne: null }; rerender(); });
    allOneBtn.addEventListener("click", () => { state.asiChoice = { mode: "allOne" }; rerender(); });
    modeRow.appendChild(twoOneBtn); modeRow.appendChild(allOneBtn);
    asiCard.appendChild(modeRow);
    if (state.asiChoice.mode === "twoOne") {
      const row = h("div", { class: "field-row" });
      [["plusTwo", "+2 to…"], ["plusOne", "+1 to…"]].forEach(([key, label]) => {
        const sel = h("select", {});
        sel.appendChild(h("option", { value: "" }, label));
        bg.abilityScores.forEach(a => sel.appendChild(h("option", { value: a }, ABILITY_NAMES[a])));
        sel.value = state.asiChoice[key] || "";
        sel.addEventListener("change", () => { state.asiChoice[key] = sel.value || null; rerender(); });
        row.appendChild(sel);
      });
      asiCard.appendChild(row);
    }
    if (ABILITIES.every(a => state.baseScores[a])) {
      const fs = finalScores(state, ruleset);
      const preview = h("div", { class: "ability-grid", style: "margin-top:14px;" });
      ABILITIES.forEach(a => {
        const box = h("div", { class: "ability-box" });
        const delta = fs[a] - state.baseScores[a];
        box.innerHTML = `<div class="name">${ABILITY_NAMES[a]}</div><div class="score">${fs[a]}</div><div class="mod">${formatModifier(abilityModifier(fs[a]))}</div>${delta ? `<div class="meta-up">+${delta}</div>` : ""}`;
        preview.appendChild(box);
      });
      asiCard.appendChild(h("p", { style: "margin-top:10px;" }, "Final scores:"));
      asiCard.appendChild(preview);
    }
    root.appendChild(asiCard);
  }

  // ---------------- Level choices (starting above level 1) ----------------
  function renderLevelsStep(root) {
    const { cls } = selectedDefs(state, ruleset);
    const n = classLevel1Needs(cls, state.startLevel);
    if (n.subclass) {
      const card = h("div", { class: "card" });
      card.appendChild(h("h3", {}, `${cls.subclassLabel} (level ${cls.subclassLevel})`));
      const g = h("div", { class: "grid cols-2" });
      cls.subclasses.forEach(sc => {
        const c = h("button", { type: "button", class: `choice-card ${state.subclassId === sc.id ? "selected" : ""}` });
        c.innerHTML = `<h4>${escapeHtml(sc.name)}</h4><div class="meta">${escapeHtml((sc.description || "").slice(0, 220))}</div>`;
        c.addEventListener("click", () => { state.subclassId = sc.id; rerender(); });
        g.appendChild(c);
      });
      card.appendChild(g);
      if (state.subclassId) {
        ruleset.classFeatures.filter(f => f.classId === cls.id && f.subclassId === state.subclassId && f.level <= state.startLevel)
          .forEach(f => card.appendChild(detailPanel(`Level ${f.level}: ${f.name}`, md(f.description))));
      }
      root.appendChild(card);
    }
    asiLevelsFor(cls, state.startLevel).forEach(l => {
      const c = state.levelChoices[l] || (state.levelChoices[l] = { mode: l >= 19 ? "feat" : "asi", split: "two" });
      const card = h("div", { class: "card" });
      card.appendChild(h("h3", {}, `Level ${l}: ${l >= 19 ? "Epic Boon (or another feat)" : "Ability Score Improvement or Feat"}`));
      const before = scoresBeforeLevel(state, ruleset, l);
      const modeRow = h("div", { class: "field-row wrap" });
      [["asi", "Ability Score Improvement"], ["feat", "Feat"]].forEach(([m, label]) => {
        if (l >= 19 && m === "asi") return;
        const b = h("button", { type: "button", class: `btn sm ${c.mode === m ? "primary" : ""}` }, label);
        b.addEventListener("click", () => { state.levelChoices[l] = { mode: m, split: "two" }; rerender(); });
        modeRow.appendChild(b);
      });
      card.appendChild(modeRow);
      const abilSel = (key, exclude) => {
        const sel = h("select", {});
        sel.appendChild(h("option", { value: "" }, "\u2014 ability \u2014"));
        ABILITIES.forEach(a => {
          const o = h("option", { value: a }, `${ABILITY_NAMES[a]} (${before[a]})`);
          if (before[a] >= 20 || a === exclude) o.disabled = true;
          sel.appendChild(o);
        });
        sel.value = c[key] || "";
        sel.addEventListener("change", () => { c[key] = sel.value || null; rerender(); });
        return sel;
      };
      if (c.mode === "asi") {
        const split = h("div", { class: "field-row wrap" });
        [["two", "+2 to one ability"], ["oneone", "+1 to two abilities"]].forEach(([m, label]) => {
          const b = h("button", { type: "button", class: `btn sm ghost ${c.split === m ? "primary" : ""}` }, label);
          b.addEventListener("click", () => { c.split = m; c.a = null; c.b = null; rerender(); });
          split.appendChild(b);
        });
        card.appendChild(split);
        const row = h("div", { class: "field-row" });
        row.appendChild(abilSel("a", c.split === "oneone" ? c.b : null));
        if (c.split === "oneone") row.appendChild(abilSel("b", c.a));
        card.appendChild(row);
      } else {
        const opts = levelFeatOptions(state, ruleset, l);
        const sel = h("select", {});
        sel.appendChild(h("option", { value: "" }, "\u2014 choose a feat \u2014"));
        [["epic-boon", "Epic Boons"], ["general", "General Feats"], ["origin", "Origin Feats"]].forEach(([cat, label]) => {
          const list = opts.filter(f => f.category === cat);
          if (!list.length) return;
          const og = h("optgroup", { label });
          list.forEach(f => og.appendChild(h("option", { value: f.id, selected: c.featId === f.id ? "selected" : null }, f.name)));
          sel.appendChild(og);
        });
        sel.addEventListener("change", () => { c.featId = sel.value || null; c.featAbility = null; rerender(); });
        card.appendChild(sel);
        const f = findById(ruleset.feats, c.featId);
        if (f?.asi?.abilities?.length) {
          const aSel = h("select", {});
          aSel.appendChild(h("option", { value: "" }, "\u2014 +1 to ability \u2014"));
          f.asi.abilities.forEach(a => aSel.appendChild(h("option", { value: a, selected: c.featAbility === a ? "selected" : null }, `${ABILITY_NAMES[a]} (${before[a]})`)));
          aSel.addEventListener("change", () => { c.featAbility = aSel.value || null; rerender(); });
          card.appendChild(aSel);
        }
        if (f) card.appendChild(detailPanel(f.name, md(f.description)));
      }
      root.appendChild(card);
    });
    if (state.hpMethod === "roll") {
      const card = h("div", { class: "card" });
      card.appendChild(h("h3", {}, `Hit Points (d${cls.hitDie} per level after 1st)`));
      const row = h("div", { class: "hp-roll-grid" });
      for (let l = 2; l <= state.startLevel; l++) {
        const cell = h("button", { type: "button", class: `choice-card compact ${state.hpRolls[l] ? "selected" : ""}` }, `<h4>Level ${l}</h4><div class="meta">${state.hpRolls[l] ? `Rolled ${state.hpRolls[l]}` : "Roll"}</div>`);
        cell.addEventListener("click", () => { state.hpRolls[l] = rollDie(cls.hitDie); rerender(); });
        row.appendChild(cell);
      }
      card.appendChild(row);
      const all = h("button", { type: "button", class: "btn sm", style: "margin-top:8px;" }, "Roll all remaining");
      all.addEventListener("click", () => { for (let l = 2; l <= state.startLevel; l++) if (!state.hpRolls[l]) state.hpRolls[l] = rollDie(cls.hitDie); rerender(); });
      card.appendChild(all);
      root.appendChild(card);
    }
    const fs = finalScores(state, ruleset);
    const preview = h("div", { class: "card" });
    preview.appendChild(h("h3", {}, "Ability scores at this level"));
    const grid = h("div", { class: "ability-grid" });
    ABILITIES.forEach(a => grid.appendChild(h("div", { class: "ability-box" }, `<div class="name">${ABILITY_NAMES[a]}</div><div class="score">${fs[a]}</div><div class="mod">${formatModifier(abilityModifier(fs[a]))}</div>`)));
    preview.appendChild(grid);
    root.appendChild(preview);
  }

  // ---------------- Skills, tools, languages ----------------
  function renderProficienciesStep(root) {
    const { cls } = selectedDefs(state, ruleset);
    const granted = grantedSkills(state, ruleset);
    const skillCard = h("div", { class: "card" });
    skillCard.appendChild(h("h3", {}, `${cls.name} Skills ${counter(state.skillChoices.length, cls.skillChoices.count)}`));
    skillCard.appendChild(h("p", {}, granted.size ? `Already proficient (background/species/feat): ${[...granted].map(skillName).join(", ")}.` : ""));
    const opts = cls.skillChoices.options === "any" ? ruleset.skills.map(s => s.id) : cls.skillChoices.options;
    skillCard.appendChild(pickGrid(opts.map(id => {
      const sk = findById(ruleset.skills, id);
      return { id, label: sk?.name || id, meta: `${ABILITY_NAMES[sk?.ability] || ""}${granted.has(id) ? " — already proficient" : ""}`, disabled: granted.has(id) };
    }), state.skillChoices, cls.skillChoices.count, v => { state.skillChoices = v; }));
    root.appendChild(skillCard);

    if (cls.toolChoices) {
      const tc = cls.toolChoices;
      const cats = tc.category === "artisan-or-instrument" ? ["artisan", "instrument"] : [tc.category];
      const toolCard = h("div", { class: "card" });
      toolCard.appendChild(h("h3", {}, `Tool Proficienc${tc.count > 1 ? "ies" : "y"} ${counter(state.classTools.length, tc.count)}`));
      toolCard.appendChild(h("p", {}, tc.category === "instrument" ? "Choose Musical Instruments." : "Choose one type of Artisan's Tools or a Musical Instrument."));
      const tools = toolCatalog(ruleset).filter(t => cats.includes(t.toolCategory));
      toolCard.appendChild(pickGrid(tools.map(t => ({ id: t.id, label: t.name })), state.classTools, tc.count, v => { state.classTools = v; }, "cols-4"));
      root.appendChild(toolCard);
    }

    const langs = ruleset.languages?.standard || STANDARD_LANGUAGES_FALLBACK;
    const want = 2 + (classLevel1Needs(cls, state.startLevel).extraLanguage || 0);
    const langCard = h("div", { class: "card" });
    langCard.appendChild(h("h3", {}, `Languages ${counter(state.languages.length, want)}`));
    const auto = knownLanguages({ ...state, languages: [] }, ruleset);
    langCard.appendChild(h("p", {}, `You know ${auto.join(", ")}${cls.id === "rogue" ? " (Thieves' Cant lets you pick one extra language)" : ""}. Choose ${want} more from the Standard Languages.`));
    const pickable = [...langs, ...(ruleset.languages?.rare || [])].filter(l => !auto.includes(l));
    langCard.appendChild(pickGrid(pickable.map(l => ({ id: l, label: l, meta: (ruleset.languages?.rare || []).includes(l) ? "Rare (ask your DM)" : "" })), state.languages, want, v => { state.languages = v; }, "cols-4"));
    root.appendChild(langCard);
  }

  // ---------------- Class features & feat choices ----------------
  function renderFeaturesStep(root) {
    const { cls } = selectedDefs(state, ruleset);
    const n = classLevel1Needs(cls, state.startLevel);
    const featText = (id) => findById(ruleset.classFeatures, id)?.description || "";

    if (n.fightingStyle) {
      const card = h("div", { class: "card" });
      card.appendChild(h("h3", {}, "Fighting Style"));
      const styles = ruleset.feats.filter(f => f.category === "fighting-style");
      card.appendChild(pickGrid(styles.map(f => ({ id: f.id, label: f.name, meta: escapeHtml(f.summary) })), state.classChoices.fightingStyle ? [state.classChoices.fightingStyle] : [], 1,
        v => { state.classChoices.fightingStyle = v[0] || null; }, "cols-2"));
      root.appendChild(card);
    }
    const orderPick = (key, title, featureId, options) => {
      const card = h("div", { class: "card" });
      card.appendChild(h("h3", {}, title));
      card.appendChild(detailPanel("Rules text", md(featText(featureId))));
      card.appendChild(pickGrid(options, state.classChoices[key] ? [state.classChoices[key]] : [], 1, v => { state.classChoices[key] = v[0] || null; }, "cols-2"));
      root.appendChild(card);
    };
    if (n.divineOrder) orderPick("divineOrder", "Divine Order", "cleric-divine-order", [
      { id: "protector", label: "Protector", meta: "Martial weapons and Heavy armor training." },
      { id: "thaumaturge", label: "Thaumaturge", meta: "One extra Cleric cantrip; add Wis to Arcana/Religion checks." }]);
    if (n.primalOrder) orderPick("primalOrder", "Primal Order", "druid-primal-order", [
      { id: "magician", label: "Magician", meta: "One extra Druid cantrip; add Wis to Arcana/Nature checks." },
      { id: "warden", label: "Warden", meta: "Martial weapons and Medium armor training." }]);
    if (n.invocations) {
      const card = h("div", { class: "card" });
      card.appendChild(h("h3", {}, `Eldritch Invocations ${counter(state.classChoices.invocations.length, n.invocations)}`));
      const inv = (ruleset.classOptions?.invocations || []).filter(i => i.minLevel <= state.startLevel);
      card.appendChild(pickGrid(inv.map(i => ({ id: i.id, label: i.name, meta: (i.requires ? `<em>Requires: ${escapeHtml(i.requires)}</em> • ` : "") + escapeHtml(i.description.slice(0, 160)) + (i.description.length > 160 ? "…" : "") })),
        state.classChoices.invocations, n.invocations, v => { state.classChoices.invocations = v; }, "cols-2"));
      root.appendChild(card);
    }
    if (n.expertise) {
      const card = h("div", { class: "card" });
      const profs = allSkillProficiencies(state, ruleset);
      card.appendChild(h("h3", {}, `Expertise ${counter(state.expertise.length, n.expertise)}`));
      card.appendChild(h("p", {}, `Choose ${n.expertise} skills you're proficient in; your Proficiency Bonus is doubled for them.`));
      card.appendChild(pickGrid(profs.map(id => ({ id, label: skillName(id) })), state.expertise, n.expertise, v => { state.expertise = v; }));
      root.appendChild(card);
    }
    if (n.weaponMasteries) {
      const card = h("div", { class: "card" });
      card.appendChild(h("h3", {}, `Weapon Mastery ${counter(state.weaponMasteries.length, n.weaponMasteries)}`));
      card.appendChild(h("p", {}, "You can use the mastery property of these weapons. You can change one choice after each Long Rest."));
      card.appendChild(pickGrid(masteryWeapons(cls, ruleset).map(w => ({ id: w.id, label: w.name, meta: `${w.mastery} • ${w.damageDice} ${w.damageType}` })),
        state.weaponMasteries, n.weaponMasteries, v => { state.weaponMasteries = v; }, "cols-4"));
      root.appendChild(card);
    }
    // Origin feat sub-choices
    originFeats(state, ruleset).forEach(({ source, feat }) => {
      const fc = state.featChoices[source] || (state.featChoices[source] = {});
      if (feat.id === "skilled") {
        const card = h("div", { class: "card" });
        const total = (fc.skills?.length || 0) + (fc.tools?.length || 0);
        card.appendChild(h("h3", {}, `Skilled (${source === "versatile" ? "Human" : "Background"}) ${counter(total, 3)}`));
        card.appendChild(h("p", {}, "Choose any combination of three skills or tools."));
        const taken = new Set([...allSkillProficiencies({ ...state, featChoices: { ...state.featChoices, [source]: { ...fc, skills: [] } } }, ruleset)]);
        const items = [
          ...ruleset.skills.map(s => ({ id: `skill:${s.id}`, label: s.name, meta: "Skill", disabled: taken.has(s.id) })),
          ...toolCatalog(ruleset).map(t => ({ id: `tool:${t.id}`, label: t.name, meta: "Tool" }))
        ];
        const selected = [...(fc.skills || []).map(s => `skill:${s}`), ...(fc.tools || []).map(t => `tool:${t}`)];
        card.appendChild(pickGrid(items, selected, 3, v => {
          fc.skills = v.filter(x => x.startsWith("skill:")).map(x => x.slice(6));
          fc.tools = v.filter(x => x.startsWith("tool:")).map(x => x.slice(5));
        }, "cols-4"));
        root.appendChild(card);
      }
      if (feat.id === "musician" || feat.id === "crafter") {
        const cat = feat.id === "musician" ? "instrument" : "artisan";
        const card = h("div", { class: "card" });
        card.appendChild(h("h3", {}, `${feat.name} ${counter(fc.tools?.length || 0, 3)}`));
        card.appendChild(h("p", {}, feat.id === "musician" ? "Choose three Musical Instruments." : "Choose three Artisan's Tools."));
        card.appendChild(pickGrid(toolsByCategory(ruleset, cat).map(t => ({ id: t.id, label: t.name })), fc.tools || [], 3, v => { fc.tools = v; }, "cols-4"));
        root.appendChild(card);
      }
    });
  }

  // ---------------- Spells ----------------
  function spellPicker(title, spells, selected, max, onChange) {
    const card = h("div", { class: "card spell-pick" });
    card.appendChild(h("h3", {}, `${title} ${counter(selected.length, max)}`));
    const search = h("input", { type: "search", placeholder: "Search spells…", class: "spell-search" });
    card.appendChild(search);
    const list = h("div", { class: "spell-pick-list" });
    function draw() {
      list.innerHTML = "";
      const q = search.value.trim().toLowerCase();
      spells.filter(s => !q || s.name.toLowerCase().includes(q) || s.school?.toLowerCase().includes(q)).forEach(s => {
        const on = selected.includes(s.id);
        const row = h("div", { class: `spell-pick-row ${on ? "selected" : ""}` });
        const top = h("div", { class: "spell-pick-top" });
        const check = h("button", { type: "button", class: `pick-check ${on ? "on" : ""}`, title: on ? "Remove" : "Choose" }, on ? "✓" : "+");
        check.addEventListener("click", () => {
          let next = [...selected];
          if (on) next = next.filter(x => x !== s.id);
          else if (next.length >= max) { toast(`You can choose ${max}. Remove one first.`, "error"); return; }
          else next.push(s.id);
          onChange(next); rerender();
        });
        top.appendChild(check);
        top.appendChild(h("div", { class: "spell-pick-name" }, `<strong>${escapeHtml(s.name)}</strong> <span class="meta">${s.level ? `L${s.level} \u2022 ` : ""}${s.school || ""}${s.concentration ? " • C" : ""}${s.ritual ? " • R" : ""} • ${escapeHtml(s.castingTime)} • ${escapeHtml(s.range)}</span>`));
        row.appendChild(top);
        row.appendChild(detailPanel("Details", md(s.description) + (s.higherLevel ? `<p><strong>${s.level === 0 ? "Cantrip Upgrade." : "Using a Higher-Level Spell Slot."}</strong> ${escapeHtml(s.higherLevel)}</p>` : "")));
        list.appendChild(row);
      });
    }
    search.addEventListener("input", draw);
    draw();
    card.appendChild(list);
    return card;
  }

  function renderSpellsStep(root) {
    const { cls, sp } = selectedDefs(state, ruleset);
    const free = speciesCantrips(sp, state.speciesChoices);
    if (free.length) root.appendChild(h("p", { class: "step-intro" }, `From your species you also know: ${free.map(id => findById(ruleset.spells, id)?.name || id).join(", ")}.`));
    const sc = buildCasting(state, ruleset);
    if (sc) {
      const listId = sc.list;
      const maxLvl = buildMaxSpellLevel(state, ruleset);
      root.appendChild(h("p", { class: "step-intro" }, `You cast ${listId[0].toUpperCase() + listId.slice(1)} spells with ${ABILITY_NAMES[sc.ability]}${maxLvl ? `, up to level ${maxLvl}` : ""}. You can change these choices later on your sheet.`));
      const nc = cantripCount(state, ruleset);
      const miCantrips = Object.values(state.featChoices).flatMap(fc => fc.cantrips || []);
      if (nc) root.appendChild(spellPicker("Cantrips", classSpellList(ruleset, listId, 0).filter(s => !free.includes(s.id) && !miCantrips.includes(s.id)), state.cantrips, nc, v => { state.cantrips = v; }));
      const leveled = classSpellList(ruleset, listId, { max: maxLvl }).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
      if (sc.spellbook) {
        root.appendChild(spellPicker(`Spellbook (levels 1\u2013${maxLvl})`, leveled, state.spellbook, spellbookSize(state), v => { state.spellbook = v; }));
        root.appendChild(spellPicker("Prepared Spells (from your spellbook)", ruleset.spells.filter(s => state.spellbook.includes(s.id)), state.preparedSpells, preparedCount(state, ruleset), v => { state.preparedSpells = v; }));
      } else if (preparedCount(state, ruleset)) {
        root.appendChild(spellPicker(maxLvl > 1 ? `Prepared Spells (levels 1\u2013${maxLvl})` : "Prepared Spells (level 1)", leveled, state.preparedSpells, preparedCount(state, ruleset), v => { state.preparedSpells = v; }));
      }
    }
    originFeats(state, ruleset).filter(f => f.feat.id === "magic-initiate").forEach(({ source, list: fixedList }) => {
      const fc = state.featChoices[source] || (state.featChoices[source] = {});
      const card = h("div", { class: "card" });
      card.appendChild(h("h3", {}, `Magic Initiate (${source === "versatile" ? "Human" : "Background"})`));
      if (!fixedList) {
        card.appendChild(h("label", {}, "Spell list"));
        const row = h("div", { class: "field-row wrap" });
        ["cleric", "druid", "wizard"].forEach(l => {
          const b = h("button", { type: "button", class: `btn sm ${fc.list === l ? "primary" : ""}` }, l[0].toUpperCase() + l.slice(1));
          b.addEventListener("click", () => { if (fc.list !== l) { fc.list = l; fc.cantrips = []; fc.spell = null; } rerender(); });
          row.appendChild(b);
        });
        card.appendChild(row);
      } else card.appendChild(h("p", {}, `Spell list: ${fixedList[0].toUpperCase() + fixedList.slice(1)}`));
      card.appendChild(h("label", {}, "Spellcasting ability"));
      const ab = h("div", { class: "field-row wrap" });
      ["int", "wis", "cha"].forEach(a => {
        const b = h("button", { type: "button", class: `btn sm ${fc.ability === a ? "primary" : ""}` }, ABILITY_NAMES[a]);
        b.addEventListener("click", () => { fc.ability = a; rerender(); });
        ab.appendChild(b);
      });
      card.appendChild(ab);
      root.appendChild(card);
      if (fc.list) {
        root.appendChild(spellPicker("Magic Initiate cantrips", classSpellList(ruleset, fc.list, 0).filter(s => !free.includes(s.id) && !state.cantrips.includes(s.id)), fc.cantrips || [], 2, v => { fc.cantrips = v; }));
        root.appendChild(spellPicker("Magic Initiate level 1 spell (cast once per Long Rest for free)", classSpellList(ruleset, fc.list, 1), fc.spell ? [fc.spell] : [], 1, v => { fc.spell = v[0] || null; }));
      }
    });
  }

  // ---------------- Equipment ----------------
  function renderEquipmentStep(root) {
    const { cls, bg } = selectedDefs(state, ruleset);
    const card = h("div", { class: "card" });
    card.appendChild(h("h3", {}, `${cls.name} Starting Equipment`));
    const g = h("div", { class: "grid cols-3" });
    cls.equipmentOptions.forEach(o => {
      const c = h("button", { type: "button", class: `choice-card ${state.classEquip === o.id ? "selected" : ""}` });
      c.innerHTML = `<h4>Option ${o.id}</h4><div class="meta">${escapeHtml(o.text)}</div>`;
      c.addEventListener("click", () => { state.classEquip = o.id; rerender(); });
      g.appendChild(c);
    });
    card.appendChild(g);
    root.appendChild(card);

    const card2 = h("div", { class: "card" });
    card2.appendChild(h("h3", {}, `${bg.name} Equipment`));
    const g2 = h("div", { class: "grid cols-2" });
    [["A", bg.equipmentText], ["B", `${bg.goldAlternative} GP`]].forEach(([id, text]) => {
      const c = h("button", { type: "button", class: `choice-card ${state.bgEquip === id ? "selected" : ""}` });
      c.innerHTML = `<h4>Option ${id}</h4><div class="meta">${escapeHtml(text)}</div>`;
      c.addEventListener("click", () => { state.bgEquip = id; rerender(); });
      g2.appendChild(c);
    });
    card2.appendChild(g2);
    root.appendChild(card2);

    const { items, gold } = startingInventory(state, ruleset);
    const sum = h("div", { class: "card parchment" });
    sum.innerHTML = `<h3>You'll start with</h3>
      <ul class="equip-summary">${items.map(i => `<li>${i.quantity > 1 ? `${i.quantity}× ` : ""}${escapeHtml(i.name)}${i.equipped ? " <em>(equipped)</em>" : ""}${i.packContents ? `<div class="meta">${i.packContents.map(c => `${c.quantity > 1 ? c.quantity + " " : ""}${escapeHtml(c.name)}`).join(", ")}</div>` : ""}</li>`).join("")}</ul>
      <p><strong>${gold} GP</strong></p>
      <p class="meta">Gold-only options let you shop from the equipment list on your sheet.</p>`;
    root.appendChild(sum);
  }

  // ---------------- Details ----------------
  function renderDetailsStep(root) {
    const card = h("div", { class: "card" });
    card.appendChild(h("label", {}, "Portrait (optional)"));
    const portraitRow = h("div", { style: "display:flex; align-items:center; gap:14px; margin-bottom:14px;" });
    const preview = h("div", { class: "portrait-preview" });
    preview.innerHTML = state.portraitBase64 ? `<img src="${state.portraitBase64}">` : `<span>${escapeHtml((state.name || "?")[0].toUpperCase())}</span>`;
    const fileInput = h("input", { type: "file", accept: "image/*" });
    fileInput.addEventListener("change", async () => {
      if (!fileInput.files?.[0]) return;
      const { compressImageToBase64, IMAGE_PRESETS } = await import("../image-utils.js");
      const result = await compressImageToBase64(fileInput.files[0], IMAGE_PRESETS.portrait);
      state.portraitBase64 = result.dataUrl;
      preview.innerHTML = `<img src="${result.dataUrl}">`;
      persist();
    });
    portraitRow.appendChild(preview); portraitRow.appendChild(fileInput);
    card.appendChild(portraitRow);

    card.appendChild(h("label", {}, "Character name"));
    const nameInput = h("input", { type: "text", value: state.name, maxlength: "60" });
    nameInput.addEventListener("input", () => { state.name = nameInput.value; persist(); renderNav(); });
    card.appendChild(nameInput);

    card.appendChild(h("label", {}, "Alignment"));
    const alignSel = h("select", {});
    ruleset.alignments.forEach(a => alignSel.appendChild(h("option", { value: a, selected: state.alignment === a ? "selected" : null }, a)));
    alignSel.addEventListener("change", () => { state.alignment = alignSel.value; persist(); });
    card.appendChild(alignSel);

    const grid = h("div", { class: "grid cols-2" });
    [["gender", "Gender"], ["age", "Age"], ["height", "Height"], ["weight", "Weight"], ["eyes", "Eyes"], ["hair", "Hair"], ["skin", "Skin"], ["faith", "Faith"]].forEach(([k, label]) => {
      const f = h("div", {});
      f.appendChild(h("label", {}, label));
      const inp = h("input", { type: "text", value: state.appearance[k] || "" });
      inp.addEventListener("input", () => { state.appearance[k] = inp.value; persist(); });
      f.appendChild(inp);
      grid.appendChild(f);
    });
    card.appendChild(grid);

    card.appendChild(h("label", {}, "Lifestyle"));
    const life = h("select", {});
    ["", "Wretched", "Squalid", "Poor", "Modest", "Comfortable", "Wealthy", "Aristocratic"].forEach(v => life.appendChild(h("option", { value: v, selected: state.lifestyle === v ? "selected" : null }, v || "\u2014")));
    life.addEventListener("change", () => { state.lifestyle = life.value; persist(); });
    card.appendChild(life);
    const pgrid = h("div", { class: "grid cols-2" });
    [["personalityTraits", "Personality Traits"], ["ideals", "Ideals"], ["bonds", "Bonds"], ["flaws", "Flaws"]].forEach(([k, label]) => {
      const f = h("div", {});
      f.appendChild(h("label", {}, label));
      const ta = h("textarea", { style: "min-height:64px;" });
      ta.value = state[k] || "";
      ta.addEventListener("input", () => { state[k] = ta.value; persist(); });
      f.appendChild(ta);
      pgrid.appendChild(f);
    });
    card.appendChild(pgrid);
    card.appendChild(h("label", {}, "Backstory (optional)"));
    const bioInput = h("textarea", {});
    bioInput.value = state.backstory;
    bioInput.addEventListener("input", () => { state.backstory = bioInput.value; persist(); });
    card.appendChild(bioInput);
    root.appendChild(card);
    setTimeout(() => { if (!state.name) nameInput.focus(); }, 0);
  }

  // ---------------- Review ----------------
  function renderReviewStep(root) {
    const { cls, sp, bg } = selectedDefs(state, ruleset);
    const character = buildCharacter(state, ruleset, user);
    const { items, gold } = startingInventory(state, ruleset);
    const armor = items.find(i => i.type === "armor" && i.equipped && i.armorData.armorType !== "shield");
    const shield = items.some(i => i.type === "armor" && i.equipped && i.armorData.armorType === "shield");
    const ac = estimateArmorClass(character, armor?.armorData || null, shield);
    const spellNames = (ids) => ids.map(id => findById(ruleset.spells, id)?.name || id).join(", ");
    const lineage = (sp.choices || []).filter(c => c.type === "option").map(c => speciesOption(sp, state.speciesChoices, c.id)?.name).filter(Boolean).join(", ");
    const card = h("div", { class: "card parchment" });
    card.innerHTML = `
      <div style="display:flex; gap:14px; align-items:center;">
        <div class="portrait-preview lg">${state.portraitBase64 ? `<img src="${state.portraitBase64}">` : `<span>${escapeHtml((state.name || "?")[0].toUpperCase())}</span>`}</div>
        <div><h2 style="margin:0;">${escapeHtml(state.name) || "Unnamed"}</h2>
        <p style="margin:2px 0;">Level ${state.startLevel} ${escapeHtml(sp.name)}${lineage ? ` (${escapeHtml(lineage)})` : ""} ${cls.name}${state.subclassId ? ` (${escapeHtml(cls.subclasses.find(x => x.id === state.subclassId)?.name || "")})` : ""} • ${bg.name} • ${escapeHtml(state.alignment)}</p></div>
      </div>
      <div class="combat-strip" style="margin:12px 0;">
        <div class="combat-stat"><div class="val">${character.hp.max}</div><div class="lbl">Hit Points</div></div>
        <div class="combat-stat"><div class="val">${ac}</div><div class="lbl">Armor Class</div></div>
        <div class="combat-stat"><div class="val">${sp.choices?.find(c => c.id === "lineage") && speciesOption(sp, state.speciesChoices, "lineage")?.speed || sp.speed} ft.</div><div class="lbl">Speed</div></div>
        <div class="combat-stat"><div class="val">+${proficiencyBonus(state.startLevel)}</div><div class="lbl">Prof. Bonus</div></div>
      </div>
      <div class="ability-grid">
        ${ABILITIES.map(a => `<div class="ability-box"><div class="name">${ABILITY_NAMES[a]}</div><div class="score">${character.abilityScores[a]}</div><div class="mod">${formatModifier(abilityModifier(character.abilityScores[a]))}</div></div>`).join("")}
      </div>
      <p style="margin-top:14px;"><strong>Skills:</strong> ${character.skillProficiencies.map(s => skillName(s) + (character.skillExpertise.includes(s) ? " (Expertise)" : "")).join(", ")}</p>
      <p><strong>Saving Throws:</strong> ${character.savingThrowProficiencies.map(a => ABILITY_NAMES[a]).join(", ")}</p>
      <p><strong>Tools:</strong> ${escapeHtml(character.toolProficiencies.join(", ") || "None")}</p>
      <p><strong>Languages:</strong> ${escapeHtml(character.languages.join(", "))}</p>
      <p><strong>Feats:</strong> ${character.feats.map(f => findById(ruleset.feats, f.featId)?.name).filter(Boolean).join(", ")}</p>
      ${state.weaponMasteries.length ? `<p><strong>Weapon Mastery:</strong> ${state.weaponMasteries.map(id => findById(ruleset.equipment.weapons, id)?.name).join(", ")}</p>` : ""}
      ${state.classChoices.invocations.length ? `<p><strong>Invocations:</strong> ${state.classChoices.invocations.map(id => (ruleset.classOptions?.invocations || []).find(i => i.id === id)?.name).join(", ")}</p>` : ""}
      ${state.classChoices.divineOrder ? `<p><strong>Divine Order:</strong> ${state.classChoices.divineOrder}</p>` : ""}
      ${state.classChoices.primalOrder ? `<p><strong>Primal Order:</strong> ${state.classChoices.primalOrder}</p>` : ""}
      ${character.spellsKnown.cantrips.length || character.spellsKnown.species.length ? `<p><strong>Cantrips:</strong> ${spellNames([...character.spellsKnown.species, ...character.spellsKnown.cantrips])}</p>` : ""}
      ${state.spellbook.length ? `<p><strong>Spellbook:</strong> ${spellNames(state.spellbook)}</p>` : ""}
      ${state.preparedSpells.length ? `<p><strong>Prepared:</strong> ${spellNames(state.preparedSpells)}</p>` : ""}
      <p><strong>Equipment:</strong> ${items.map(i => `${i.quantity > 1 ? i.quantity + "× " : ""}${escapeHtml(i.name)}`).join(", ")}; ${gold} GP</p>
      ${state.backstory ? `<p><strong>Backstory:</strong> ${escapeHtml(state.backstory)}</p>` : ""}
    `;
    root.appendChild(card);
    root.appendChild(h("p", {}, "Everything look right? Use the step buttons above to change anything, then create your character."));
  }

  async function saveCharacter(btn) {
    if (saving) return;
    for (const s of steps()) {
      const err = validate(s.id);
      if (err) { toast(`${s.label}: ${err}`, "error"); return; }
    }
    saving = true;
    btn.disabled = true; btn.textContent = "Creating…";
    try {
      const character = buildCharacter(state, ruleset, user);
      const { items, gold } = startingInventory(state, ruleset);
      character.currency = { cp: 0, sp: 0, ep: 0, gp: gold, pp: 0 };
      const id = await db.characters.create(character);
      // Containers first so their contents can reference the new container id
      await Promise.all(items.map(async (item) => {
        const { packContents, ...rest } = item;
        const containerId = await db.inventory.add(id, rest);
        if (packContents?.length) await Promise.all(packContents.map(c => db.inventory.add(id, { ...c, containerId })));
      }));
      try { localStorage.removeItem(draftKey(user.uid)); } catch { /* noop */ }
      toast(`${character.name} created!`);
      navigate(`/character/${id}`);
    } catch (e) {
      console.error(e);
      toast(e.message || "Couldn't save the character", "error");
      saving = false; btn.disabled = false; btn.textContent = "Create Character";
    }
  }

  renderAll();
}
