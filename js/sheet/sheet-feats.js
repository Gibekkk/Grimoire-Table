import { h, toast } from "../util.js";
import { findById } from "../data-loader.js";
import { getClassEntries, totalLevel, proficiencyBonus } from "../rules-engine.js";

function lockedCard(name, desc, unlocked, extraTag) {
  const card = h("div", { class: `lore-card ${unlocked ? "" : "locked"}` });
  card.innerHTML = `<div class="lore-title"><span>${name}</span>${extraTag || ""}</div><div class="lore-desc">${desc}</div>`;
  return card;
}

export function renderFeatsTab(ctx) {
  const { character, ruleset, canEditCore, patch } = ctx;
  const wrap = h("div", {});
  const level = totalLevel(character);
  const bg = findById(ruleset.backgrounds, character.backgroundId);
  const sp = findById(ruleset.species, character.speciesId);
  const feat = bg ? findById(ruleset.feats, bg.featId) : null;

  // ---- Origin feat ----
  const featCard = h("div", { class: "card" });
  featCard.appendChild(h("h3", {}, "Origin Feat"));
  if (character.isNpc && canEditCore) {
    const bgSelect = h("select", {});
    bgSelect.appendChild(h("option", { value: "" }, "\u2014 No background \u2014"));
    ruleset.backgrounds.forEach(b => bgSelect.appendChild(h("option", { value: b.id, selected: character.backgroundId === b.id ? "selected" : null }, b.name)));
    bgSelect.addEventListener("change", () => patch({ backgroundId: bgSelect.value || null }));
    featCard.appendChild(h("label", {}, "Background (sets the origin feat below)"));
    featCard.appendChild(bgSelect);
  }
  if (character.isNpc && canEditCore) {
    const bgSelect = h("select", {});
    bgSelect.appendChild(h("option", { value: "" }, "\u2014 No background \u2014"));
    ruleset.backgrounds.forEach(b => bgSelect.appendChild(h("option", { value: b.id, selected: character.backgroundId === b.id ? "selected" : null }, b.name)));
    bgSelect.addEventListener("change", () => patch({ backgroundId: bgSelect.value || null }));
    featCard.appendChild(h("label", {}, "Background (sets the origin feat below)"));
    featCard.appendChild(bgSelect);
  }
  if (feat) {
    featCard.appendChild(lockedCard(feat.name, feat.summary, true));
    if (feat.id === "skilled") {
      const chosen = character.featChoices?.skilled?.skills || [];
      featCard.appendChild(h("p", { style: "margin-top:10px;" }, "Choose 3 skills for Skilled:"));
      const skillGrid = h("div", { class: "grid cols-3" });
      ruleset.skills.forEach(skill => {
        const selected = chosen.includes(skill.id);
        const card = h("div", { class: `choice-card ${selected ? "selected" : ""}`, style: "padding:8px;" });
        card.innerHTML = `<span style="font-size:0.8rem;">${skill.name}</span>`;
        if (canEditCore) {
          card.addEventListener("click", () => {
            let next = new Set(chosen);
            if (next.has(skill.id)) next.delete(skill.id);
            else { if (next.size >= 3) { toast("Choose only 3", "error"); return; } next.add(skill.id); }
            const skillsArr = [...next];
            patch({
              featChoices: { ...character.featChoices, skilled: { skills: skillsArr } },
              skillProficiencies: [...new Set([...(character.skillProficiencies || []), ...skillsArr])]
            });
          });
        }
        skillGrid.appendChild(card);
      });
      featCard.appendChild(skillGrid);
    }
  } else {
    featCard.appendChild(h("p", {}, "No background selected."));
  }
  wrap.appendChild(featCard);

  // ---- Species traits ----
  const spCard = h("div", { class: "card" });
  spCard.appendChild(h("h3", {}, `${sp?.name || "Species"} Traits`));
  if (character.isNpc && canEditCore) {
    const spSelect = h("select", {});
    spSelect.appendChild(h("option", { value: "" }, "\u2014 No species set \u2014"));
    ruleset.species.forEach(s => spSelect.appendChild(h("option", { value: s.id, selected: character.speciesId === s.id ? "selected" : null }, s.name)));
    spSelect.addEventListener("change", () => patch({ speciesId: spSelect.value || null }));
    spCard.appendChild(spSelect);
  }
  if (character.isNpc && canEditCore) {
    const spSelect = h("select", {});
    spSelect.appendChild(h("option", { value: "" }, "\u2014 No species set \u2014"));
    ruleset.species.forEach(s => spSelect.appendChild(h("option", { value: s.id, selected: character.speciesId === s.id ? "selected" : null }, s.name)));
    spSelect.addEventListener("change", () => patch({ speciesId: spSelect.value || null }));
    spCard.appendChild(spSelect);
  }
  (sp?.traits || []).forEach(t => {
    const unlocked = level >= (t.unlockLevel || 1);
    spCard.appendChild(lockedCard(t.name, t.description || "", unlocked, unlocked ? "" : `<span class="badge">Lv ${t.unlockLevel}</span>`));
  });
  wrap.appendChild(spCard);

  // ---- Class features per class (multiclass-aware) ----
  const entries = getClassEntries(character);
  entries.forEach(entry => {
    const cls = findById(ruleset.classes, entry.classId);
    if (!cls) return;
    const clsCard = h("div", { class: "card" });
    clsCard.appendChild(h("h3", {}, `${cls.name} Features`));
    const features = ruleset.classFeatures.filter(f => f.classId === entry.classId).sort((a, b) => a.level - b.level);
    features.forEach(f => {
      const unlocked = entry.level >= f.level;
      clsCard.appendChild(lockedCard(f.name, f.description, unlocked, unlocked ? (f.toggleable ? '<span class="badge rune">Actions tab</span>' : "") : `<span class="badge">Lv ${f.level}</span>`));
    });

    // Subclass selection — NPCs can set a subclass regardless of level (a DM
    // building a one-off "Level 1 goblin shaman" shouldn't need to level them
    // up to 3 first just to tag a subclass for flavor/reference).
    if (entry.level >= cls.subclassLevel || character.isNpc) {
      clsCard.appendChild(h("hr", { class: "divider" }));
      clsCard.appendChild(h("label", {}, cls.subclassLabel));
      const sel = h("select", {});
      sel.appendChild(h("option", { value: "" }, "\u2014 Not yet chosen \u2014"));
      cls.subclasses.forEach(sc => sel.appendChild(h("option", { value: sc, selected: entry.subclassId === sc ? "selected" : null }, sc)));
      sel.disabled = !canEditCore;
      sel.addEventListener("change", () => {
        const newEntries = getClassEntries(character).map(e => e.classId === entry.classId ? { ...e, subclassId: sel.value || null } : e);
        patch({ classes: newEntries, subclassId: newEntries[0]?.subclassId || null });
      });
      clsCard.appendChild(sel);
    }

    // Weapon Mastery selection
    if (cls.weaponMasteryCount > 0) {
      clsCard.appendChild(h("hr", { class: "divider" }));
      clsCard.appendChild(h("label", {}, `Weapon Mastery (choose ${cls.weaponMasteryCount})`));
      const chosen = character.weaponMasteries || [];
      const allWeapons = ruleset.equipment.weapons;
      const msRow = h("div", { class: "grid cols-3" });
      allWeapons.forEach(w => {
        const selected = chosen.includes(w.id);
        const card = h("div", { class: `choice-card ${selected ? "selected" : ""}`, style: "padding:8px;" });
        card.innerHTML = `<span style="font-size:0.78rem;">${w.name}</span><div class="meta">${w.mastery}</div>`;
        if (canEditCore) {
          card.addEventListener("click", () => {
            let next = new Set(chosen);
            if (next.has(w.id)) next.delete(w.id);
            else { if (next.size >= cls.weaponMasteryCount) { toast(`Choose only ${cls.weaponMasteryCount}`, "error"); return; } next.add(w.id); }
            patch({ weaponMasteries: [...next] });
          });
        }
        msRow.appendChild(card);
      });
      clsCard.appendChild(msRow);
    }

    wrap.appendChild(clsCard);
  });

  // ---- Multiclassing ----
  if (canEditCore) {
    const mcCard = h("div", { class: "card" });
    mcCard.appendChild(h("h3", {}, "Multiclassing"));
    const takenIds = entries.map(e => e.classId);
    const available = ruleset.classes.filter(c => !takenIds.includes(c.id));
    if (available.length > 0) {
      const primaryCls = findById(ruleset.classes, entries[0]?.classId);
      mcCard.appendChild(h("p", {}, `Total level ${level}, Proficiency Bonus +${proficiencyBonus(level)}. Multiclassing needs 13+ in both your current class's key ability and the new class's key ability.`));
      const row = h("div", { class: "field-row" });
      const sel = h("select", {});
      available.forEach(c => sel.appendChild(h("option", { value: c.id }, `${c.name} (needs ${c.multiclassPrereq.map(a => a.toUpperCase()).join("/")} 13+)`)));
      const addBtn = h("button", { class: "btn" }, "Add Class");
      addBtn.addEventListener("click", () => {
        const newCls = findById(ruleset.classes, sel.value);
        const meetsNew = newCls.multiclassPrereq.some(a => character.abilityScores[a] >= 13);
        const meetsCurrent = !primaryCls || primaryCls.multiclassPrereq.some(a => character.abilityScores[a] >= 13);
        if (!meetsNew || !meetsCurrent) { toast("Ability score prerequisites not met", "error"); return; }
        ctx.onClassesChanged([...entries, { classId: newCls.id, level: 1, subclassId: null }]);
        toast(`${newCls.name} added as a multiclass`);
      });
      row.appendChild(sel); row.appendChild(addBtn);
      mcCard.appendChild(row);
    } else {
      mcCard.appendChild(h("p", {}, "All classes taken \u2014 quite the polymath."));
    }
    if (entries.length > 1) {
      mcCard.appendChild(h("hr", { class: "divider" }));
      entries.forEach(entry => {
        const cls = findById(ruleset.classes, entry.classId);
        const row = h("div", { class: "field-row", style: "align-items:flex-end;" });
        const lvlField = h("div", {});
        lvlField.appendChild(h("label", {}, `${cls.name} Level`));
        const lvlInput = h("input", { type: "number", min: "1", max: "20", value: String(entry.level) });
        lvlInput.addEventListener("change", () => {
          const newLevel = Math.max(1, Math.min(20, parseInt(lvlInput.value, 10) || 1));
          ctx.onClassesChanged(entries.map(e => e.classId === entry.classId ? { ...e, level: newLevel } : e));
        });
        lvlField.appendChild(lvlInput);
        row.appendChild(lvlField);
        mcCard.appendChild(row);
      });
    }
    wrap.appendChild(mcCard);
  }

  return wrap;
}
