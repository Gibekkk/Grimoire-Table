import { h, attachRollMenu, showContextMenu, escapeHtml } from "../util.js";
import { findById } from "../data-loader.js";
import {
  ABILITIES, ABILITY_NAMES, abilityModifier, formatModifier,
  skillModifier, savingThrowModifier
} from "../rules-engine.js";

export function renderCoreTab(ctx) {
  const { character, ruleset, canEditCore, patch, onRoll } = ctx;
  const wrap = h("div", {});

  const abilCard = h("div", { class: "card" });
  abilCard.appendChild(h("h3", {}, "Ability Scores & Saves"));
  abilCard.appendChild(h("p", {}, "Right-click a modifier to roll with Advantage/Disadvantage."));
  const abilGrid = h("div", { class: "ability-grid" });
  ABILITIES.forEach(a => {
    const override = character.abilityOverrides?.[a];
    const score = override != null ? override : character.abilityScores[a];
    const mod = abilityModifier(score);
    const saveOverride = character.savingThrowOverrides?.[a];
    const saveMod = saveOverride != null ? saveOverride : savingThrowModifier(character, a) + (ctx.saveBonus || 0);
    const isProf = character.savingThrowProficiencies?.includes(a);
    const box = h("div", { class: "ability-box" });
    box.innerHTML = `
      <div class="name">${ABILITY_NAMES[a]}</div>
      <div class="score">${score}${override != null ? " \u2022" : ""}</div>
      <div class="mod roll-target">${formatModifier(mod)}</div>
      <div style="font-size:0.65rem; color:${isProf ? "var(--gold-bright)" : "var(--text-dim)"}; margin-top:4px;" class="save-target">Save ${formatModifier(saveMod)}</div>
    `;
    const rollTarget = box.querySelector(".roll-target");
    attachRollMenu(rollTarget, {
      onRoll: (mode) => onRoll({ sides: 20, count: 1, modifier: mod, label: `${ABILITY_NAMES[a]} Check`, mode }),
      extraItems: canEditCore ? [{
        label: override != null ? "Clear Override" : "Set Override\u2026",
        action: () => {
          if (override != null) { patch({ abilityOverrides: { ...character.abilityOverrides, [a]: null } }); return; }
          const val = prompt(`Override ${ABILITY_NAMES[a]} score (blank cancels):`, String(score));
          if (val === null || val === "") return;
          patch({ abilityOverrides: { ...character.abilityOverrides, [a]: parseInt(val, 10) } });
        }
      }] : null
    });
    const saveTarget = box.querySelector(".save-target");
    attachRollMenu(saveTarget, { onRoll: (mode) => onRoll({ sides: 20, count: 1, modifier: saveMod, label: `${ABILITY_NAMES[a]} Save`, mode }) });
    abilGrid.appendChild(box);
  });
  abilCard.appendChild(abilGrid);
  wrap.appendChild(abilCard);

  const skillsCard = h("div", { class: "card" });
  skillsCard.appendChild(h("h3", {}, "Skills"));

  const passives = ["perception", "investigation", "insight"];
  const passiveStrip = h("div", { class: "combat-strip" });
  passives.forEach(id => {
    const skill = ruleset.skills.find(s => s.id === id);
    if (!skill) return;
    const val = 10 + skillModifier(character, skill, ruleset.skills);
    passiveStrip.innerHTML += `<div class="combat-stat" style="cursor:default;"><div class="val">${val}</div><div class="lbl">Passive ${skill.name}</div></div>`;
  });
  skillsCard.appendChild(passiveStrip);
  skillsCard.appendChild(h("hr", { class: "divider" }));

  ruleset.skills.forEach(skill => {
    const override = character.skillOverrides?.[skill.id];
    const mod = override != null ? override : skillModifier(character, skill, ruleset.skills);
    const isProf = character.skillProficiencies?.includes(skill.id);
    const isExpert = character.skillExpertise?.includes(skill.id);
    const row = h("div", { class: "skill-row" });
    row.innerHTML = `
      <span class="prof-dot ${isExpert ? "expert" : isProf ? "on" : ""}"></span>
      <span class="ability-tag">${skill.ability.toUpperCase()}</span>
      <span class="name">${skill.name}</span>
      <span class="mod">${formatModifier(mod)}${override != null ? " \u2022" : ""}</span>
    `;
    const dot = row.querySelector(".prof-dot");
    if (canEditCore) {
      dot.addEventListener("click", () => {
        let profs = new Set(character.skillProficiencies || []);
        let experts = new Set(character.skillExpertise || []);
        if (!profs.has(skill.id)) { profs.add(skill.id); }
        else if (!experts.has(skill.id)) { experts.add(skill.id); }
        else { profs.delete(skill.id); experts.delete(skill.id); }
        patch({ skillProficiencies: [...profs], skillExpertise: [...experts] });
      });
    }
    const modEl = row.querySelector(".mod");
    attachRollMenu(modEl, {
      onRoll: (mode) => onRoll({ sides: 20, count: 1, modifier: mod, label: skill.name, mode }),
      extraItems: canEditCore ? [{
        label: override != null ? "Clear Override" : "Set Override\u2026",
        action: () => {
          if (override != null) { patch({ skillOverrides: { ...character.skillOverrides, [skill.id]: null } }); return; }
          const val = prompt(`Override ${skill.name} modifier (blank cancels):`, String(mod));
          if (val === null || val === "") return;
          patch({ skillOverrides: { ...character.skillOverrides, [skill.id]: parseInt(val, 10) } });
        }
      }] : null
    });
    skillsCard.appendChild(row);
  });
  wrap.appendChild(skillsCard);

  // ---- Proficiencies, senses, languages ----
  const sp = findById(ruleset.species, character.speciesId);
  const lineageOpt = (sp?.choices || []).filter(c => c.type === "option").map(c => c.options.find(o => o.id === character.speciesChoices?.[c.id])).filter(Boolean);
  const speed = lineageOpt.find(o => o.speed)?.speed || sp?.speed || 30;
  const darkvision = lineageOpt.find(o => o.darkvision)?.darkvision || sp?.darkvision || 0;
  const resist = [...(sp?.resistances || []), ...lineageOpt.flatMap(o => o.resistances || [])];
  const ancestry = lineageOpt.find(o => o.damageType);
  if (ancestry) resist.push(ancestry.damageType);
  // Characters from the old builder never stored training; derive it from their classes.
  const primaryCls = findById(ruleset.classes, (character.classes?.[0] || {}).classId || character.classId);
  const armorTraining = character.armorTraining || primaryCls?.armorTraining || [];
  const weaponTraining = character.weaponTraining || primaryCls?.weaponTraining || [];
  const titleCase = (x) => String(x).split("-").map(w => w[0]?.toUpperCase() + w.slice(1)).join(" ");
  const profCard = h("div", { class: "card" });
  profCard.appendChild(h("h3", {}, "Proficiencies & Senses"));
  const rows = [
    ["Speed", `${speed} ft.`],
    ["Size", character.size || sp?.size?.[0] || "\u2014"],
    ["Senses", darkvision ? `Darkvision ${darkvision} ft.` : "\u2014"],
    ["Resistances", resist.length || character.damageResistances?.length ? [...new Set([...resist, ...(character.damageResistances || [])].map(x => String(x).toLowerCase()))].map(titleCase).join(", ") : "\u2014"],
    ...[["Immunities", character.damageImmunities], ["Vulnerabilities", character.damageVulnerabilities], ["Condition Immunities", character.conditionImmunities]]
      .filter(([, v]) => v?.length).map(([k, v]) => [k, v.map(titleCase).join(", ")]),
    ["Armor Training", armorTraining.map(a => a === "shield" ? "Shields" : titleCase(a)).join(", ") || "\u2014"],
    ["Weapons", weaponTraining.map(w => ({ simple: "Simple", martial: "Martial", "martial-light": "Martial (Light)", "martial-finesse-light": "Martial (Finesse/Light)" }[w] || w)).join(", ") || "\u2014"],
    ["Tools", (character.toolProficiencies || []).join(", ") || "\u2014"],
    ["Languages", (character.languages || []).join(", ") || "\u2014"]
  ];
  const grid = h("div", { class: "info-grid" });
  rows.forEach(([k, v]) => grid.appendChild(h("div", {}, `<span class="lbl">${k}</span>${escapeHtml(v)}`)));
  profCard.appendChild(grid);
  if (canEditCore) {
    const editRow = h("div", { class: "field-row wrap" });
    [["languages", "Edit languages"], ["toolProficiencies", "Edit tools"]].forEach(([key, label]) => {
      const b = h("button", { class: "btn sm ghost" }, label);
      b.addEve