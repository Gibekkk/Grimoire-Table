import { h, escapeHtml } from "../util.js";
import { findById } from "../data-loader.js";
import { getClassEntries } from "../rules-engine.js";

export function renderDescriptionTab(ctx) {
  const { character, ruleset, canEditCore, patch } = ctx;
  const wrap = h("div", {});

  const bg = findById(ruleset.backgrounds, character.backgroundId);
  const sp = findById(ruleset.species, character.speciesId);

  // Appearance
  const appearance = character.appearance || {};
  const apCard = h("div", { class: "card" });
  apCard.appendChild(h("h3", {}, "Appearance & Identity"));
  const fields = [
    ["height", "Height", "e.g. 5'8\""], ["weight", "Weight", "e.g. 150 lb."],
    ["eyes", "Eyes", "e.g. Hazel"], ["hair", "Hair", "e.g. Black, braided"],
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
    refCard.innerHTML += `<p><strong>${cls.name} (Level ${entry.level})</strong> \u2014 d${cls.hitDie} Hit Die, saves in ${cls.savingThrows.map(s => s.toUpperCase()).join("/")}. ${cls.subclassLabel}: ${entry.subclassId || "not yet chosen"}. Options: ${cls.subclasses.join(", ")}.</p>`;
  });
  if (sp) refCard.innerHTML += `<p><strong>${sp.name}</strong> \u2014 Size ${sp.size.join("/")}, Speed ${sp.speed} ft.</p>`;
  if (bg) refCard.innerHTML += `<p><strong>${bg.name} Background</strong> \u2014 Tool: ${bg.tool}. Skills: ${bg.skills.map(s => findById(ruleset.skills, s)?.name).join(", ")}.</p>`;
  wrap.appendChild(refCard);

  return wrap;
}
