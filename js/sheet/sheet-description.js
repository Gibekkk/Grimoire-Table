import { h, escapeHtml } from "../util.js";
import { findById } from "../data-loader.js";
import { getClassEntries } from "../rules-engine.js";

export function renderDescriptionTab(ctx) {
  const { character, ruleset, canEditCore, patch } = ctx;
  const wrap = h("div", {});

  const bg = findById(ruleset.backgrounds, character.backgroundId);
  const sp = findById(ruleset.species, character.speciesId);

  // Portrait
  const portraitCard = h("div", { class: "card" });
  portraitCard.appendChild(h("h3", {}, "Portrait"));
  const portraitRow = h("div", { style: "display:flex; align-items:center; gap:14px;" });
  const preview = h("div", { class: "portrait-preview lg" });
  preview.innerHTML = character.portraitBase64 ? `<img src="${character.portraitBase64}">` : `<span>${(character.name || "?")[0].toUpperCase()}</span>`;
  portraitRow.appendChild(preview);
  if (canEditCore) {
    const fileInput = h("input", { type: "file", accept: "image/*" });
    fileInput.addEventListener("change", async () => {
      if (!fileInput.files?.[0]) return;
      const { compressImageToBase64, IMAGE_PRESETS } = await import("../image-utils.js");
      const result = await compressImageToBase64(fileInput.files[0], IMAGE_PRESETS.portrait);
      patch({ portraitBase64: result.dataUrl });
    });
    portraitRow.appendChild(fileInput);
  }
  portraitCard.appendChild(portraitRow);
  wrap.appendChild(portraitCard);

  // Appearance
  const appearance = character.appearance || {};
  const apCard = h("div", { class: "card" });
  apCard.appendChild(h("h3", {}, "Appearance & Identity"));
  const fields = [
    ["gender", "Gender", ""], ["age", "Age", "e.g. 27"],
    ["height", "Height", "e.g. 5'8\""], ["weight", "Weight", "e.g. 150 lb."],
    ["eyes", "Eyes", "e.g. Hazel"], ["hair", "Hair", "e.g. Black, braided"],
    ["skin", "Skin", "e.g. Olive"], ["faith", "Faith", "e.g. Pelor"],
    ["faction", "Faction / Affiliation", "e.g. Harpers"]
  ];
  const grid = h("div", { class: "grid cols-2" });
  fields.forEach(([key, label, placeholder]) => {
    const f = h("div", {});
    f.appendChild(h("label", {}, label));
    const input = h("input", { type: "text", placeholder, value: appearance[key] || "" });
    input.disabled = !canEditCore;
    input.addEventListener("change", () => patch({ appearance: { ...character.appearance, [key]: input.value } }));
    f.appendChild(input);
    grid.appendChild(f);
  });
  apCard.appendChild(grid);
  wrap.appendChild(apCard);

  // Alignment + backstory
  const bioCard = h("div", { class: "card" });
  bioCard.appendChild(h("h3", {}, "Alignment & Backstory"));
  const alignLabel = h("label", {}, "Alignment");
  const alignSel = h("select", {});
  ruleset.alignments.forEach(a => alignSel.appendChild(h("option", { value: a, selected: character.alignment === a ? "selected" : null }, a)));
  alignSel.disabled = !canEditCore;
  alignSel.addEventListener("change", () => patch({ alignment: alignSel.value }));
  bioCard.appendChild(alignLabel); bioCard.appendChild(alignSel);

  const bioLabel = h("label", {}, "Backstory");
  const bioArea = h("textarea", {});
  bioArea.value = character.backstory || "";
  bioArea.disabled = !canEditCore;
  bioArea.addEventListener("change", () => patch({ backstory: bioArea.value }));
  bioCard.appendChild(bioLabel); bioCard.appendChild(bioArea);

  // D&D Beyond-style characteristics
  bioCard.appendChild(h("label", {}, "Lifestyle"));
  const life = h("select", {});
  ["", "Wretched", "Squalid", "Poor", "Modest", "Comfortable", "Wealthy", "Aristocratic"].forEach(v => life.appendChild(h("option", { value: v, selected: (character.lifestyle || "") === v ? "selected" : null }, v || "\u2014")));
  life.disabled = !canEditCore;
  life.addEventListener("change", () => patch({ lifestyle: life.value }));
  bioCard.appendChild(life);
  const traitsGrid = h("div", { class: "grid cols-2" });
  [["personalityTraits", "Personality Traits"], ["ideals", "Ideals"], ["bonds", "Bonds"], ["flaws", "Flaws"]].forEach(([key, label]) => {
    const f = h("div", {});
    f.appendChild(h("label", {}, label));
    const ta = h("textarea", { style: "min-height:64px;" });
    ta.value = character[key] || "";
    ta.disabled = !canEditCore;
    ta.addEventListener("change", () => patch({ [key]: ta.value }));
    f.appendChild(ta);
    traitsGrid.appendChild(f);
  });
  bioCard.appendChild(traitsGrid);
  const personalityLabel = h("label", {}, "Other characteristics");
  const personalityArea = h("textarea", {});
  personalityArea.value = character.personality || "";
  personalityArea.disabled = !canEditCore;
  personalityArea.placeholder = "e.g. Gruff but loyal. Believes every debt must be repaid, one way or another.";
  personalityArea.addEventListener("change", () => patch({ personality: personalityArea.value }));
  bioCard.appendChild(personalityLabel); bioCard.appendChild(personalityArea);

  const notesLabel = h("label", {}, "Player notes");
  const notesArea = h("textarea", {});
  notesArea.value = character.notes || "";
  notesArea.disabled = !canEditCore;
  notesArea.addEventListener("change", () => patch({ notes: notesArea.value }));
  bioCard.appendChild(notesLabel); bioCard.appendChild(notesArea);
  wrap.appendChild(bioCard);

  // Full reference text
  const refCard = h("div", { class: "card" });
  refCard.appendChild(h("h3", {}, "Class, Species & Background Reference"));
  getClassEntries(character).forEach(entry => {
    const cls = findById(ruleset.classes, entry.classId);
    if (!cls) return;
    refCard.innerHTML += `<p><strong>${cls.name} (Level ${entry.level})</strong> \u2014 d${cls.hitDie} Hit Die, saves in ${cls.savingThrows.map(s => s.toUpperCase()).join("/")}. ${cls.subclassLabel}: ${(cls.subclasses || []).find(sc => (sc.id || sc) === entry.subclassId || sc.name === entry.subclassId)?.name || entry.subclassId || "not yet chosen"}. Options: ${(cls.subclasses || []).map(sc => sc.name || sc).join(", ")}.</p>`;
  });
  if (sp) refCard.innerHTML += `<p><strong>${sp.name}</strong> \u2014 Size ${sp.size.join("/")}, Speed ${sp.speed} ft.</p>`;
  if (bg) refCard.innerHTML += `<p><strong>${bg.name} Background</strong> \u2014 Tool: ${escapeHtml(bg.tool || "")}. Skills: ${bg.skills.map(s => findById(ruleset.skills, s)?.name).join(", ")}. Feat: ${escapeHtml(bg.feat || "")}.</p>`;
  wrap.appendChild(refCard);

  return wrap;
}
