import { db } from "../../db.js";
import { h, escapeHtml, timeAgo } from "../../util.js";

export function mountDmNotesPanel(container, { campaignId }) {
  const card = h("div", { class: "card dm-only-flag" });
  card.appendChild(h("h3", {}, "DM Notes"));
  card.appendChild(h("p", {}, "Only visible to you as the Dungeon Master."));

  const addRow = h("div", {});
  const titleInput = h("input", { type: "text", placeholder: "Note title" });
  const bodyInput = h("textarea", { placeholder: "Session notes, secrets, plot hooks\u2026" });
  const addBtn = h("button", { class: "btn primary sm" }, "Add Note");
  addBtn.addEventListener("click", async () => {
    if (!titleInput.value.trim()) return;
    await db.notes.add(campaignId, { title: titleInput.value.trim(), body: bodyInput.value.trim() });
    titleInput.value = ""; bodyInput.value = "";
  });
  addRow.appendChild(titleInput); addRow.appendChild(bodyInput); addRow.appendChild(addBtn);
  card.appendChild(addRow);
  card.appendChild(h("hr", { class: "divider" }));

  const list = h("div", {});
  card.appendChild(list);
  container.appendChild(card);

  const unsub = db.notes.subscribe(campaignId, (notes) => {
    list.innerHTML = "";
    if (notes.length === 0) { list.appendChild(h("p", {}, "No notes yet.")); return; }
    [...notes].reverse().forEach(note => {
      const item = h("div", { class: "card", style: "background:var(--ink-raised); margin-bottom:10px;" });
      item.innerHTML = `
        <div style="display:flex; justify-content:space-between;">
          <strong style="color:var(--gold-bright);">${escapeHtml(note.title)}</strong>
          <span class="time" style="color:var(--text-dim); font-size:0.75rem;">${timeAgo(note.createdAt)}</span>
        </div>
        <p style="white-space:pre-wrap; margin-bottom:8px;">${escapeHtml(note.body)}</p>
      `;
      const delBtn = h("button", { class: "btn sm ghost" }, "Delete");
      delBtn.addEventListener("click", () => db.notes.remove(campaignId, note.id));
      item.appendChild(delBtn);
      list.appendChild(item);
    });
  });

  return unsub;
}
