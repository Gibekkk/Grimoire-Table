import { h, toast, escapeHtml } from "../util.js";
import { findById } from "../data-loader.js";
import { getClassEntries, totalLevel, proficiencyBonus, subclassSlug, ABILITY_NAMES } from "../rules-engine.js";

function textHtml(text) {
  return escapeHtml(text || "").split("\n").map(p => p.replace(/^([A-Z][A-Za-z' ,\-()/]{1,48}\.)(\s)/, "<strong>$1</strong>$2")).map(p => `<p>${p}</p>`).join("");
}

// Collapsible feature card: title row always visible, rules text on click.
function featureCard(name, desc, { unlocked = true, tag = "", open = false } = {}) {
  const card = h("details", { class: `lore-card feature ${unlocked ? "" : "locked"}` });
  if (open) card.open = true;
  card.appendChild(h("summary", { class: "lore-title" }, `<span>${escapeHtml(name)}</span>${tag}`));
  card.appendChild(h("div", { class: "lore-desc" }, textHtml(desc)));
  return card;
}

function progressionValue(cls, label, level) {
  return cls?.progression?.find(p => p.label === label)?.values?.[Math.max(0, Math.min(19, level - 1))];
}

export function renderFeatsTab(ctx) {
  const { character, ruleset, canEditCore, patch } = ctx;
  const wrap = h("div", {});
  const level = totalLevel(character);
  const bg = findById(ruleset.backgrounds, character.backgroundId);
  const sp = findById(ruleset.species, character.speciesId);
  const entries = getClassEntries(character);

  // ---- Feats ----
  const featCard = h("div", { class: "card" });
  featCard.appendChild(h("h3", {}, "Feats"));
  if (character.isNpc && canEditCore) {
    const bgSelect = h("select", {});
    bgSelect.appendChild(h("option", { value: "" }, "— No background —"));
    ruleset.backgrounds.forEach(b => bgSelect.appendChild(h("option", { value: b.id, selected: character.backgroundId === b.id ? "selected" : null }, b.name)));
    bgSelect.addEventListener("change", () => patch({ backgroundId: bgSelect.value || null }));
    featCard.appendChild(h("label", {}, "Background (sets the origin feat)"));
    featCard.appendChild(bgSelect);
  }
  // Characters from the old builder have no feats[]; their origin feat comes from the background.
  const records = character.feats?.length ? [...character.feats] : (bg?.featId ? [{ featId: bg.featId, source: "background", choices: character.featChoices?.skilled ? { skills: character.featChoices.skilled.skills } : {} }] : []);
  if (character.speciesChoices?.versatile && !records.some(r => r.source === "versatile")) records.push({ featId: character.speciesChoices.versatile, source: "versatile", choices: {} });
  const sourceLabel = (src) => src === "background" ? `Background${bg ? ` (${bg.name})` : ""}` : src === "versatile" ? "Human: Versatile" : (src || "").replace(/^class-(\w+)-(\d+)$/, (_, c, l) => `${findById(ruleset.classes, c)?.name || c} ${l}`);
  if (!records.length) featCard.appendChild(h("p", {}, "No feats yet."));
  records.forEach((rec, idx) => {
    const feat = findById(ruleset.feats, rec.featId) || findById(ruleset.feats, (rec.featId || "").replace(/-(cleric|druid|wizard)$/, ""));
    if (!feat) return;
    const c = rec.choices || {};
    const bits = [];
    if (c.increases) bits.push(Object.entries(c.increases).map(([a, n]) => `${ABILITY_NAMES[a]} +${n}`).join(", "));
    if (c.ability) bits.push(`+1 ${ABILITY_NAMES[c.ability]}`);
    if (c.skills?.length) bits.push(`Skills: ${c.skills.map(s => findById(ruleset.skills, s)?.name || s).join(", ")}`);
    if (c.tools?.length) bits.push(`Tools: ${c.tools.map(t => findById(ruleset.equipment.gear, t)?.name || t).join(", ")}`);
    if (c.list) bits.push(`${c.list[0].toUpperCase() + c.list.slice(1)} list (${ABILITY_NAMES[c.ability] || "?"})`);
    if (c.cantrips?.length) bits.push(`Cantrips: ${c.cantrips.map(id => findById(ruleset.spells, id)?.name || id).join(", ")}`);
    if (c.spell) bits.push(`Spell: ${findById(ruleset.spells, c.spell)?.name || c.spell}`);
    const card = featureCard(feat.name, (bits.length ? bits.join(" • ") + "\n" : "") + feat.description, { tag: `<span class="badge">${escapeHtml(sourceLabel(rec.source))}</span>` });
    if (canEditCore && character.feats?.length && rec.source?.startsWith("class-")) {
      const rm = h("button", { class: "btn sm ghost", style: "margin-top:6px;" }, "Remove feat");
      rm.addEventListener("click", () => {
        if (!confirm(`Remove ${feat.name}? Ability score changes it made are not reverted automatically.`)) return;
        patch({ feats: character.feats.filter((_, i) => i !== idx) });
      });
      card.appendChild(rm);
    }
    featCard.appendChild(card);
  });
  if (canEditCore) {
    const addRow = h("div", { class: "field-row", style: "margin-top:10px;" });
    const sel = h("select", {});
    sel.appendChild(h("option", { value: "" }, "Add a feat manually (DM award, homebrew)…"));
    ruleset.feats.forEach(f => sel.appendChild(h("option", { value: f.id }, `${f.name} — ${f.category.replace("-", " ")}`)));
    const addBtn = h("button", { class: "btn sm", style: "flex:0 0 auto;" }, "Add");
    addBtn.addEventListener("click", () => {
      if (!sel.value) return;
      const base = character.feats?.length ? character.feats : records;
      patch({ feats: [...base, { featId: sel.value, source: `class-manual-${level}`, choices: {} }] });
      toast("Feat added");
    });
    addRow.appendChild(sel); addRow.appendChild(addBtn);
    featCard.appendChild(addRow);
  }
  wrap.appendChild(featCard);

  // ---- Species traits ----
  const spCard = h("div", { class: "card" });
  spCard.appendChild(h("h3", {}, `${sp?.name || "Species"} Traits`));
  if (character.isNpc && canEditCore) {
    const spSelect = h("select", {});
    spSelect.appendChild(h("option", { value: "" }, "— No species set —"));
    ruleset.species.forEach(s => spSelect.appendChild(h("option", { value: s.id, selected: character.speciesId === s.id ? "selected" : null }, s.name)));
    spSelect.addEventListener("change", () => patch({ speciesId: spSelect.value || null }));
    spCard.appendChild(spSelect);
  }
  if (sp) {
    const chosen = (sp.choices || []).map(ch => {
      const v = character.speciesChoices?.[ch.id];
      if (!v) return null;
      if (ch.type === "option") return `${ch.label}: ${ch.options.find(o => o.id === v)?.name || v}`;
      if (ch.type === "ability") return `${ch.label}: ${ABILITY_NAMES[v]}`;
      if (ch.type === "skill") return `${ch.label}: ${findById(ruleset.skills, v)?.name || v}`;
      if (ch.type === "feat") return `${ch.label}: ${findById(ruleset.feats, v)?.name || v}`;
      return null;
    }).filter(Boolean);
    const meta = [`Size ${character.size || sp.size.join("/")}`, `Speed ${sp.speed} ft.`, sp.darkvision ? `Darkvision ${sp.darkvision} ft.` : null, ...chosen].filter(Boolean);
    spCard.appendChild(h("p", { class: "meta" }, escapeHtml(meta.join(" • "))));
    (sp.choices || []).filter(ch => ch.type === "option").forEach(ch => {
      const opt = ch.options.find(o => o.id === character.speciesChoices?.[ch.id]);
      if (opt?.description) spCard.appendChild(featureCard(opt.name, opt.description));
    });
  }
  (sp?.traits || []).forEach(t => {
    const unlocked = level >= (t.unlockLevel || 1);
    spCard.appendChild(featureCard(t.name, t.description || "", { unlocked, tag: unlocked ? "" : `<span class="badge">Lv ${t.unlockLevel}</span>` }));
  });
  wrap.appendChild(spCard);

  // ---- Class features per class (multiclass-aware) ----
  entries.forEach(entry => {
    const cls = findById(ruleset.classes, entry.classId);
    if (!cls) return;
    const clsCard = h("div", { class: "card" });
    const sub = (cls.subclasses || []).find(s => (s.id || subclassSlug(s.name || s)) === subclassSlug(entry.subclassId));
    clsCard.appendChild(h("h3", {}, `${cls.name} ${entry.level}${sub ? ` — ${sub.name}` : ""}`));
    const prog = (cls.progression || []).map(p => `${p.label}: ${p.values[Math.min(19, entry.level - 1)]}`).join(" • ");
    if (prog) clsCard.appendChild(h("p", { class: "meta" }, escapeHtml(prog)));

    // Subclass selection — NPCs can set one regardless of level.
    if (entry.level >= cls.subclassLevel || character.isNpc) {
      clsCard.appendChild(h("label", {}, cls.subclassLabel));
      const sel = h("select", {});
      sel.appendChild(h("option", { value: "" }, "— Not yet chosen —"));
      (cls.subclasses || []).forEach(sc => {
        const id = sc.id || subclassSlug(sc);
        sel.appendChild(h("option", { value: id, selected: subclassSlug(entry.subclassId) === id ? "selected" : null }, sc.name || sc));
      });
      sel.disabled = !canEditCore;
      sel.addEventListener("change", () => {
        const newEntries = getClassEntries(character).map(e => e.classId === entry.classId ? { ...e, subclassId: sel.value || null } : e);
        patch({ classes: newEntries, subclassId: newEntries[0]?.subclassId || null });
      });
      clsCard.appendChild(sel);
    } else {
      clsCard.appendChild(h("p", { class: "meta" }, `${cls.subclassLabel} at level ${cls.subclassLevel}: ${(cls.subclasses || []).map(s => s.name || s).join(", ")}`));
    }

    // Level-1 class choices made in the builder
    const cc = character.classChoices?.[cls.id] || {};
    if (cc.divineOrder) clsCard.appendChild(h("p", {}, `<strong>Divine Order:</strong> ${escapeHtml(cc.divineOrder[0].toUpperCase() + cc.divineOrder.slice(1))}`));
    if (cc.primalOrder) clsCard.appendChild(h("p", {}, `<strong>Primal Order:</strong> ${escapeHtml(cc.primalOrder[0].toUpperCase() + cc.primalOrder.slice(1))}`));

    const subId = subclassSlug(entry.subclassId);
    const features = ruleset.classFeatures.filter(f => f.classId === entry.classId && (!f.subclassId || f.subclassId === subId)).sort((a, b) => a.level - b.level);
    const unlocked = features.filter(f => entry.level >= f.level);
    const upcoming = features.filter(f => entry.level < f.level);
    unlocked.forEach(f => clsCard.appendChild(featureCard(`${f.name}`, f.description, { tag: `<span class="badge">Lv ${f.level}</span>${f.resource ? '<span class="badge rune">Actions tab</span>' : ""}` })));
    if (upcoming.length) {
      const more = h("details", { class: "upcoming" });
      more.appendChild(h("summary", {}, `Upcoming features (${upcoming.length})`));
      upcoming.forEach(f => more.appendChild(featureCard(f.name, f.description, { unlocked: false, tag: `<span class="badge">Lv ${f.level}</span>` })));
      clsCard.appendChild(more);
    }

    // Eldritch Invocations
    if (cls.id === "warlock") {
      const max = progressionValue(cls, "Invocations", entry.level) || 1;
      const chosen = cc.invocations || [];
      clsCard.appendChild(h("hr", { class: "divider" }));
      clsCard.appendChild(h("label", {}, `Eldritch Invocations (${chosen.length} / ${max})`));
      const options = (ruleset.classOptions?.invocations || []);
      const grid = h("div", { class: "grid cols-2" });
      options.forEach(inv => {
        const on = chosen.includes(inv.id);
        const eligible = inv.minLevel <= entry.level;
        if (!on && !eligible) return;
        const card = h("div", { class: `choice-card compact ${on ? "selected" : ""}` });
        card.innerHTML = `<h4>${escapeHtml(inv.name)}</h4><div class="meta">${inv.minLevel > 1 ? `Level ${inv.minLevel}+ • ` : ""}${inv.requires ? escapeHtml(inv.requires) + " • " : ""}${escapeHtml(inv.description.slice(0, 150))}${inv.description.length > 150 ? "…" : ""}</div>`;
        card.title = inv.description;
        if (canEditCore) card.addEventListener("click", () => {
          let next = [...chosen];
          if (on) next = next.filter(x => x !== inv.id);
          else { if (next.length >= max) { toast(`You have ${max} invocations at this level`, "error"); return; } next.push(inv.id); }
          patch({ classChoices: { ...(character.classChoices || {}), [cls.id]: { ...cc, invocations: next } } });
        });
        grid.appendChild(card);
      });
      clsCard.appendChild(grid);
    }

    // Weapon Mastery (count grows with level per the class table)
    const masteryCount = progressionValue(cls, "Weapon Mastery", entry.level) ?? (cls.weaponMastery?.[entry.level - 1] || cls.weaponMasteryCount || 0);
    if (masteryCount > 0) {
      clsCard.appendChild(h("hr", { class: "divider" }));
      const chosen = character.weaponMasteries || [];
      clsCard.appendChild(h("label", {}, `Weapon Mastery (${chosen.length} / ${masteryCount})`));
      const msRow = h("div", { class: "grid cols-4" });
      ruleset.equipment.weapons.forEach(w => {
        const selected = chosen.includes(w.id);
        const card = h("div", { class: `choice-card compact ${selected ? "selected" : ""}` });
        card.innerHTML = `<h4>${w.name}</h4><div class="meta">${w.mastery}</div>`;
        if (canEditCore) {
          card.addEventListener("click", () => {
            const next = new Set(chosen);
            if (next.has(w.id)) next.delete(w.id);
            else { if (next.size >= masteryCount) { toast(`Choose only ${masteryCount}`, "error"); return; } next.add(w.id); }
            patch({ weaponMasteries: [...next] });
          });
        }
        msRow.appendChild(card);
      });
      clsCard.appendChild(msRow);
    }
    wrap.appendChild(clsCard);
  });

  // ---- Leveling & multiclassing ----
  if (canEditCore) {
    const mcCard = h("div", { class: "card" });
    mcCard.appendChild(h("h3", {}, "Leveling & Multiclassing"));
    mcCard.appendChild(h("p", {}, `Total level ${level}, Proficiency Bonus +${proficiencyBonus(level)}. Level Up lets you advance any of your classes or start a new one (needs 13+ in the key abilities of both your current classes and the new one).`));
    const lvlBtn = h("button", { class: "btn primary" }, "Level Up…");
    lvlBtn.disabled = level >= 20;
    lvlBtn.addEventListener("click", () => ctx.openLevelUp(1));
    mcCard.appendChild(lvlBtn);
    if (entries.length) {
      mcCard.appendChild(h("hr", { class: "divider" }));
      mcCard.appendChild(h("p", { class: "meta" }, "Manual level edits (fix mistakes) — lowering a level doesn't undo feats or ability increases."));
      entries.forEach((entry, idx) => {
        const cls = findById(ruleset.classes, entry.classId);
        const row = h("div", { class: "field-row", style: "align-items:flex-end;" });
        const lvlField = h("div", {});
        lvlField.appendChild(h("label", {}, `${cls?.name || entry.classId} Level`));
        const lvlInput = h("input", { type: "number", min: "1", max: "20", value: String(entry.level) });
        lvlInput.addEventListener("change", () => {
          const newLevel = Math.max(1, Math.min(20, parseInt(lvlInput.value, 10) || 1));
          ctx.onClassesChanged(entries.map(e => e.classId === entry.classId ? { ...e, level: newLevel } : e));
        });
        lvlField.appendChild(lvlInput);
        row.appendChild(lvlField);
        if (idx > 0) {
          const rm = h("button", { class: "btn sm ghost" }, "Remove class");
          rm.addEventListener("click", () => {
            if (!confirm(`Remove ${cls?.name} from this character?`)) return;
            ctx.onClassesChanged(entries.filter(e => e.classId !== entry.classId));
          });
          row.appendChild(rm);
        }
        mcCard.appendChild(row);
      });
    }
    wrap.appendChild(mcCard);
  }

  return wrap;
}
