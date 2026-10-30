// Level-up dialog: pick which class gains the level (multiclassing allowed when the
// prerequisites are met), take average or rolled HP, and resolve that level's choices
// (subclass, Ability Score Improvement / feat, Fighting Style). One level per dialog;
// gaining several levels at once chains dialogs.
import { h, toast, escapeHtml } from "../util.js";
import { findById } from "../data-loader.js";
import {
  ABILITIES, ABILITY_NAMES, getClassEntries, totalLevel, subclassSlug, meetsMulticlassPrereq,
  effectiveAbilityScore, entrySpellcasting, spellLimits, characterFeatIds, rollDie, XP_THRESHOLDS
} from "../rules-engine.js";

function featEligible(feat, character, ruleset, level) {
  const p = feat.prerequisite;
  if (!p) return true;
  if (p.level && level < p.level) return false;
  if (p.abilitiesAny && !p.abilitiesAny.some(a => effectiveAbilityScore(character, a) >= (p.abilityMin || 13))) return false;
  if (p.spellcasting && !getClassEntries(character).some(e => entrySpellcasting(e, ruleset.classes))) return false;
  if (p.armor && p.armor !== "shield" && !(character.armorTraining || []).includes(p.armor)) return false;
  if (p.armor === "shield" && !(character.armorTraining || []).includes("shield")) return false;
  if (p.fightingStyle && !getClassEntries(character).some(e => ["fighter", "paladin", "ranger"].includes(e.classId) && (e.classId === "fighter" || e.level >= 2))) return false;
  return true;
}

export function openLevelUp(ctx, levelsToGain = 1, opts = {}) {
  const { ruleset } = ctx;
  if (levelsToGain <= 0) return;
  const character = ctx.character;
  const entries = getClassEntries(character);
  if (totalLevel(character) >= 20) { toast("Already level 20", "error"); return; }

  const state = {
    classId: opts.classId || entries[0]?.classId || ruleset.classes[0].id,
    hpMode: "average", hpRoll: null,
    subclassId: null,
    asiMode: "asi", asiPlus2: null, asiPlus1a: null, asiPlus1b: null, asiSplit: "two",
    featId: null, featAbility: null,
    fightingStyle: null
  };

  const overlay = h("div", { class: "modal-overlay" });
  const box = h("div", { class: "modal-box level-up" });
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

  function info() {
    const cls = findById(ruleset.classes, state.classId);
    const existing = entries.find(e => e.classId === state.classId);
    const newClassLevel = (existing?.level || 0) + 1;
    const newTotal = totalLevel(character) + 1;
    const sub = existing?.subclassId || state.subclassId;
    const needsSubclass = newClassLevel === cls.subclassLevel && !existing?.subclassId;
    const isAsi = (cls.asiLevels || [4, 8, 12, 16]).includes(newClassLevel);
    const isEpic = newClassLevel === 19;
    const needsFightingStyle = ["paladin", "ranger"].includes(cls.id) && newClassLevel === 2;
    const feats = ruleset.classFeatures.filter(f => f.classId === cls.id && f.level === newClassLevel && (!f.subclassId || f.subclassId === subclassSlug(sub)));
    return { cls, existing, newClassLevel, newTotal, needsSubclass, isAsi, isEpic, needsFightingStyle, feats };
  }

  function render() {
    const i = info();
    const { cls } = i;
    box.innerHTML = "";
    const head = h("div", { class: "level-up-head" });
    head.appendChild(h("h3", { style: "margin:0;" }, `Level Up → ${i.newTotal}`));
    const x = h("button", { class: "icon-btn", title: "Close" }, "✕");
    x.addEventListener("click", close);
    head.appendChild(x);
    box.appendChild(head);
    const body = h("div", { class: "level-up-body" });
    box.appendChild(body);

    // Class to advance
    body.appendChild(h("label", {}, "Class gaining the level"));
    const clsSel = h("select", {});
    ruleset.classes.forEach(c => {
      const has = entries.find(e => e.classId === c.id);
      const ok = has || (meetsMulticlassPrereq(character, c) && entries.every(e => meetsMulticlassPrereq(character, findById(ruleset.classes, e.classId))));
      const label = has ? `${c.name} ${has.level} → ${has.level + 1}` : `${c.name} 1 (multiclass${ok ? "" : ` — needs ${c.multiclassPrereqText} 13+`})`;
      const opt = h("option", { value: c.id }, label);
      if (!ok) opt.disabled = true;
      if (c.id === state.classId) opt.selected = true;
      clsSel.appendChild(opt);
    });
    clsSel.addEventListener("change", () => { state.classId = clsSel.value; state.subclassId = null; render(); });
    body.appendChild(clsSel);

    // HP
    const avg = Math.floor(cls.hitDie / 2) + 1;
    body.appendChild(h("label", {}, `Hit Points (d${cls.hitDie} + Con)`));
    const hpRow = h("div", { class: "field-row wrap" });
    const avgBtn = h("button", { type: "button", class: `btn sm ${state.hpMode === "average" ? "primary" : ""}` }, `Take average (${avg})`);
    const rollBtn = h("button", { type: "button", class: `btn sm ${state.hpMode === "roll" ? "primary" : ""}` }, state.hpRoll ? `Rolled ${state.hpRoll}` : `Roll d${cls.hitDie}`);
    avgBtn.addEventListener("click", () => { state.hpMode = "average"; render(); });
    rollBtn.addEventListener("click", () => { state.hpMode = "roll"; if (!state.hpRoll) state.hpRoll = rollDie(cls.hitDie); render(); });
    hpRow.appendChild(avgBtn); hpRow.appendChild(rollBtn);
    body.appendChild(hpRow);

    if (i.needsSubclass) {
      body.appendChild(h("label", {}, cls.subclassLabel));
      const g = h("div", { class: "grid cols-2" });
      cls.subclasses.forEach(sc => {
        const c = h("button", { type: "button", class: `choice-card compact ${state.subclassId === sc.id ? "selected" : ""}` });
        c.innerHTML = `<h4>${escapeHtml(sc.name)}</h4><div class="meta">${escapeHtml((sc.description || "").slice(0, 140))}</div>`;
        c.addEventListener("click", () => { state.subclassId = sc.id; render(); });
        g.appendChild(c);
      });
      body.appendChild(g);
    }

    if (i.needsFightingStyle) {
      body.appendChild(h("label", {}, "Fighting Style"));
      const sel = h("select", {});
      sel.appendChild(h("option", { value: "" }, "— choose —"));
      ruleset.feats.filter(f => f.category === "fighting-style" && !characterFeatIds(character, ruleset).includes(f.id))
        .forEach(f => sel.appendChild(h("option", { value: f.id, selected: state.fightingStyle === f.id ? "selected" : null }, f.name)));
      sel.addEventListener("change", () => { state.fightingStyle = sel.value || null; render(); });
      body.appendChild(sel);
    }

    if (i.isAsi || i.isEpic) {
      body.appendChild(h("label", {}, i.isEpic ? "Epic Boon (or another feat)" : "Ability Score Improvement or Feat"));
      const modeRow = h("div", { class: "field-row wrap" });
      [["asi", "Ability Score Improvement"], ["feat", "Feat"]].forEach(([m, label]) => {
        if (i.isEpic && m === "asi") return;
        const b = h("button", { type: "button", class: `btn sm ${state.asiMode === m ? "primary" : ""}` }, label);
        b.addEventListener("click", () => { state.asiMode = m; render(); });
        modeRow.appendChild(b);
      });
      if (i.isEpic) state.asiMode = "feat";
      body.appendChild(modeRow);
      if (state.asiMode === "asi") {
        const split = h("div", { class: "field-row wrap" });
        [["two", "+2 to one"], ["oneone", "+1 to two"]].forEach(([m, label]) => {
          const b = h("button", { type: "button", class: `btn sm ghost ${state.asiSplit === m ? "primary" : ""}` }, label);
          b.addEventListener("click", () => { state.asiSplit = m; render(); });
          split.appendChild(b);
        });
        body.appendChild(split);
        const abilSel = (key) => {
          const sel = h("select", {});
          sel.appendChild(h("option", { value: "" }, "— ability —"));
          ABILITIES.forEach(a => {
            const score = character.abilityScores[a];
            const o = h("option", { value: a }, `${ABILITY_NAMES[a]} (${score})`);
            if (score >= 20) o.disabled = true;
            sel.appendChild(o);
          });
          sel.value = state[key] || "";
          sel.addEventListener("change", () => { state[key] = sel.value || null; });
          return sel;
        };
        const row = h("div", { class: "field-row" });
        if (state.asiSplit === "two") row.appendChild(abilSel("asiPlus2"));
        else { row.appendChild(abilSel("asiPlus1a")); row.appendChild(abilSel("asiPlus1b")); }
        body.appendChild(row);
      } else {
        const taken = new Set(characterFeatIds(character, ruleset));
        const pool = ruleset.feats.filter(f => (i.isEpic ? ["epic-boon", "general", "origin"] : ["general", "origin"]).includes(f.category)
          && f.id !== "ability-score-improvement" && (f.repeatable || !taken.has(f.id)) && featEligible(f, character, ruleset, i.newTotal));
        const sel = h("select", {});
        sel.appendChild(h("option", { value: "" }, "— choose a feat —"));
        const groups = { "epic-boon": "Epic Boons", general: "General Feats", origin: "Origin Feats" };
        Object.entries(groups).forEach(([cat, label]) => {
          const list = pool.filter(f => f.category === cat);
          if (!list.length) return;
          const og = h("optgroup", { label });
          list.forEach(f => og.appendChild(h("option", { value: f.id, selected: state.featId === f.id ? "selected" : null }, f.name)));
          sel.appendChild(og);
        });
        sel.addEventListener("change", () => { state.featId = sel.value || null; state.featAbility = null; render(); });
        body.appendChild(sel);
        const feat = findById(ruleset.feats, state.featId);
        if (feat) {
          if (feat.asi?.abilities?.length) {
            const aSel = h("select", {});
            aSel.appendChild(h("option", { value: "" }, "— +1 to ability —"));
            feat.asi.abilities.forEach(a => aSel.appendChild(h("option", { value: a, selected: state.featAbility === a ? "selected" : null }, `${ABILITY_NAMES[a]} (${character.abilityScores[a]})`)));
            aSel.addEventListener("change", () => { state.featAbility = aSel.value || null; });
            body.appendChild(aSel);
          }
          body.appendChild(h("div", { class: "level-up-feat-text" }, escapeHtml(feat.description).replace(/\n/g, "<br>")));
        }
      }
    }

    if (i.feats.length) {
      body.appendChild(h("label", {}, `New at ${cls.name} level ${i.newClassLevel}`));
      const list = h("div", {});
      i.feats.forEach(f => {
        const d = h("details", { class: "creator-detail" });
        d.appendChild(h("summary", {}, f.name));
        d.appendChild(h("div", { class: "creator-detail-body" }, escapeHtml(f.description).replace(/\n/g, "<br>")));
        list.appendChild(d);
      });
      body.appendChild(list);
    }
    const fakeEntry = { classId: cls.id, level: i.newClassLevel, subclassId: i.existing?.subclassId || state.subclassId };
    const lim = spellLimits(fakeEntry, ruleset.classes);
    if (lim.spellcasting) body.appendChild(h("p", { class: "meta" }, `${cls.name} spellcasting at level ${i.newClassLevel}: ${lim.cantrips ? `${lim.cantrips} cantrips, ` : ""}${lim.prepared} prepared spells. Update them on the Spells tab.`));

    const actions = h("div", { class: "field-row", style: "margin-top:16px;" });
    const cancel = h("button", { class: "btn" }, "Cancel");
    cancel.addEventListener("click", close);
    const ok = h("button", { class: "btn primary" }, "Level Up");
    ok.addEventListener("click", () => apply(i));
    actions.appendChild(cancel); actions.appendChild(ok);
    box.appendChild(actions);
  }

  function apply(i) {
    const { cls } = i;
    if (i.needsSubclass && !state.subclassId) { toast(`Choose a ${cls.subclassLabel}.`, "error"); return; }
    if (i.needsFightingStyle && !state.fightingStyle) { toast("Choose a Fighting Style.", "error"); return; }
    const scores = { ...character.abilityScores };
    const feats = [...(character.feats || [])];
    if (i.isAsi || i.isEpic) {
      if (state.asiMode === "asi") {
        if (state.asiSplit === "two") {
          if (!state.asiPlus2) { toast("Choose an ability to increase.", "error"); return; }
          scores[state.asiPlus2] = Math.min(20, scores[state.asiPlus2] + 2);
          feats.push({ featId: "ability-score-improvement", source: `class-${cls.id}-${i.newClassLevel}`, choices: { increases: { [state.asiPlus2]: 2 } } });
        } else {
          if (!state.asiPlus1a || !state.asiPlus1b || state.asiPlus1a === state.asiPlus1b) { toast("Choose two different abilities.", "error"); return; }
          scores[state.asiPlus1a] = Math.min(20, scores[state.asiPlus1a] + 1);
          scores[state.asiPlus1b] = Math.min(20, scores[state.asiPlus1b] + 1);
          feats.push({ featId: "ability-score-improvement", source: `class-${cls.id}-${i.newClassLevel}`, choices: { increases: { [state.asiPlus1a]: 1, [state.asiPlus1b]: 1 } } });
        }
      } else {
        const feat = findById(ruleset.feats, state.featId);
        if (!feat) { toast("Choose a feat.", "error"); return; }
        if (feat.asi?.abilities?.length && !state.featAbility) { toast("Choose which ability the feat increases.", "error"); return; }
        if (state.featAbility) scores[state.featAbility] = Math.min(feat.asi.max || 20, scores[state.featAbility] + 1);
        feats.push({ featId: feat.id, source: `class-${cls.id}-${i.newClassLevel}`, choices: state.featAbility ? { ability: state.featAbility } : {} });
        if (feat.id === "resilient" && state.featAbility) {
          ctx.patch({ savingThrowProficiencies: [...new Set([...(character.savingThrowProficiencies || []), state.featAbility])] });
        }
      }
    }
    if (state.fightingStyle) feats.push({ featId: state.fightingStyle, source: `class-${cls.id}-${i.newClassLevel}`, choices: {} });

    let newEntries;
    if (i.existing) newEntries = entries.map(e => e.classId === cls.id ? { ...e, level: e.level + 1, subclassId: e.subclassId || state.subclassId || null } : e);
    else {
      newEntries = [...entries, { classId: cls.id, level: 1, subclassId: null }];
      // Multiclassing grants a subset of the new class's proficiencies
      const mp = cls.multiclassProficiencies || {};
      ctx.patch({
        armorTraining: [...new Set([...(character.armorTraining || []), ...(mp.armor || [])])],
        weaponTraining: [...new Set([...(character.weaponTraining || []), ...(mp.weapons || [])])]
      });
    }
    const patchData = { abilityScores: scores, feats };
    if (newEntries[0]?.subclassId) patchData.subclassId = newEntries[0].subclassId;
    const finalPatch = { ...patchData };
    ctx.applyLevelChange(newEntries, finalPatch);
    if (state.hpMode === "roll" && state.hpRoll) {
      const avg = Math.floor(cls.hitDie / 2) + 1;
      const delta = state.hpRoll - avg;
      finalPatch.hp = { ...finalPatch.hp, max: Math.max(1, finalPatch.hp.max + delta), current: Math.max(0, finalPatch.hp.current + delta) };
    }
    // XP floor for milestone leveling
    finalPatch.xp = Math.max(character.xp || 0, XP_THRESHOLDS[Math.min(19, i.newTotal - 1)]);
    ctx.patch(finalPatch);
    toast(`${character.name} is now level ${i.newTotal}${i.existing ? "" : ` (${cls.name} 1)`}!`);
    close();
    if (levelsToGain > 1) setTimeout(() => openLevelUp(ctx, levelsToGain - 1, { classId: state.classId }), 50);
  }

  render();
}
