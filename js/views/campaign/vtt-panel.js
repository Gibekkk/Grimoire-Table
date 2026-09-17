import { db } from "../../db.js";
import { h, toast, escapeHtml, showContextMenu } from "../../util.js";
import { VttCanvas } from "../../vtt/vtt-canvas.js";
import { mountCharacterSheet } from "../../character-sheet.js";
import { COVER_AC_BONUS, COVER_LABELS, estimateArmorClass } from "../../rules-engine.js";
import { navigate } from "../../router.js";

// Module-level (not per-mount) so a background image, once decoded, stays
// cached for the rest of the browser session — switching maps back and forth
// no longer re-decodes/reloads it. Keyed by the base64 string itself, so a
// re-uploaded background for the same map naturally invalidates the old entry.
const bgImageCache = new Map();

export async function mountVttPanel(container, { campaignId, user, isDm, getAdvMode, onRoll }) {
  const shell = h("div", { class: "vtt-shell" });
  const sidebar = h("div", { class: "vtt-sidebar" });
  const stage = h("div", { class: "vtt-stage" });
  shell.appendChild(sidebar);
  shell.appendChild(stage);
  container.appendChild(shell);

  const toolbar = h("div", { class: "vtt-toolbar" });
  const canvasHost = h("div", { class: "vtt-canvas-host" });
  const popup = h("div", { class: "vtt-token-popup", style: "display:none;" });
  stage.appendChild(toolbar);
  stage.appendChild(canvasHost);
  stage.appendChild(popup);

  let myCharacter = null;
  let allMaps = [];
  let currentMap = null;
  let tokens = [];
  let sidebarOpen = true;
  let unsubTokens = null, unsubMap = null;
  let combat = null;
  const unsubCombat = db.combat.subscribe(campaignId, (c) => { combat = c; });

  const canvas = new VttCanvas(canvasHost, {
    canMoveToken: (token) => isDm || (token.kind === "pc" && token.refId === myCharacter?.id),
    onTokenMoved: (token, x, y) => handleTokenMoved(token, x, y),
    onTokenClicked: (token) => showTokenPopup(token),
    onTokenContextMenu: (token, sx, sy) => isDm && showTokenContextMenu(token, sx, sy)
  });

  // ---------------- Toolbar ----------------
  function buildToolbar() {
    toolbar.innerHTML = "";
    const toggleBtn = h("button", { class: "icon-btn" }, "\u2630");
    toggleBtn.title = "Toggle sidebar";
    toggleBtn.addEventListener("click", () => { sidebarOpen = !sidebarOpen; sidebar.style.display = sidebarOpen ? "flex" : "none"; });
    toolbar.appendChild(toggleBtn);

    [["select", "Select / Pan"], ["ruler", "Ruler"], ["shape-rect", "Rect AoE"], ["shape-circle", "Circle AoE"]].forEach(([tool, label]) => {
      const btn = h("button", { class: `btn sm ${canvas.tool === tool ? "primary" : ""}` }, label);
      btn.addEventListener("click", () => { canvas.setTool(tool); buildToolbar(); });
      toolbar.appendChild(btn);
    });
    const zoomOut = h("button", { class: "icon-btn" }, "\u2212");
    zoomOut.addEventListener("click", () => canvas.zoomBy(0.85));
    const zoomIn = h("button", { class: "icon-btn" }, "+");
    zoomIn.addEventListener("click", () => canvas.zoomBy(1.15));
    const fitBtn = h("button", { class: "btn sm" }, "Fit");
    fitBtn.addEventListener("click", () => canvas._fitToView());
    toolbar.appendChild(zoomOut); toolbar.appendChild(zoomIn); toolbar.appendChild(fitBtn);

    if (isDm) {
      const mapSel = h("select", { style: "max-width:200px; margin:0;" });
      allMaps.forEach(m => mapSel.appendChild(h("option", { value: m.id, selected: currentMap?.id === m.id ? "selected" : null }, m.name)));
      mapSel.addEventListener("change", () => loadMap(mapSel.value));
      toolbar.appendChild(mapSel);
    }
  }

  // ---------------- FAB (DM adds tokens) ----------------
  const fabCharacters = h("button", { class: "vtt-fab" }, "\u{1F464}");
  fabCharacters.title = "Add a character or NPC token";
  const fabComponents = h("button", { class: "vtt-fab vtt-fab-secondary" }, "\u25a2");
  fabComponents.title = "Add a component token";
  if (isDm) { stage.appendChild(fabCharacters); stage.appendChild(fabComponents); }

  fabCharacters.addEventListener("click", async () => {
    const [party, npcs] = await Promise.all([
      new Promise(res => { const u = db.characters.subscribeCampaignParty(campaignId, (p) => { res(p); u(); }); }),
      new Promise(res => { const u = db.characters.subscribeCampaignNpcs(campaignId, (n) => { res(n); u(); }); })
    ]);
    const items = [];
    items.push({ header: "Player Characters" });
    if (party.length === 0) items.push({ label: "No player characters in this campaign yet", action: () => {} });
    party.forEach(c => items.push({ label: c.name, action: () => addToken({ kind: "pc", refId: c.id, name: c.name, imageBase64: c.portraitBase64 || null, x: 2, y: 2, w: 1, h: 1 }) }));
    items.push("---");
    items.push({ header: "NPCs" });
    if (npcs.length === 0) items.push({ label: "No NPCs yet \u2014 create one in the NPCs tab", action: () => {} });
    npcs.forEach(c => items.push({ label: c.name, action: () => addToken({ kind: "npc", refId: c.id, name: c.name, imageBase64: c.portraitBase64 || null, x: 2, y: 2, w: 1, h: 1 }) }));
    const rect = fabCharacters.getBoundingClientRect();
    showContextMenu(rect.left, rect.top - 10, items);
  });

  fabComponents.addEventListener("click", async () => {
    const [library, folders] = await Promise.all([
      new Promise(res => { const u = db.componentLibrary.subscribe(campaignId, (l) => { res(l); u(); }); }),
      new Promise(res => { const u = db.componentFolders.subscribe(campaignId, (f) => { res(f); u(); }); })
    ]);
    const items = [];
    if (library.length === 0) {
      items.push({ label: "No components yet \u2014 create one in Map Workshop", action: () => {} });
    } else {
      const grouped = {};
      library.forEach(c => { const key = c.folderId || "__none__"; grouped[key] = grouped[key] || []; grouped[key].push(c); });
      Object.entries(grouped).forEach(([folderId, comps], i) => {
        if (i > 0) items.push("---");
        items.push({ header: folders.find(f => f.id === folderId)?.name || "No Folder" });
        comps.forEach(c => items.push({ label: c.name, action: () => addToken({ kind: "component", refId: c.id, name: c.name, imageBase64: c.imageBase64 || null, x: 2, y: 2, w: c.defaultW || 1, h: c.defaultH || 1, isCover: c.isCover || false, coverType: c.coverType || "half" }) }));
      });
    }
    const rect = fabComponents.getBoundingClientRect();
    showContextMenu(rect.left, rect.top - 10, items);
  });

  async function addToken(token) {
    if (!currentMap) { toast("Create a map first", "error"); return; }
    await db.tokens.add(campaignId, currentMap.id, token);
  }

  // ---------------- Cover auto-apply ----------------
  async function handleTokenMoved(token, x, y) {
    await db.tokens.update(campaignId, currentMap.id, token.id, { x, y });
    if (token.kind === "pc" || token.kind === "npc") {
      const coverType = canvas.tokenOverlapsCover(token);
      const character = await db.characters.get(token.refId);
      if (!character) return;
      const adjustments = (character.acAdjustments || []).filter(a => a.source !== "auto-cover");
      if (coverType) {
        adjustments.push({ id: "auto-cover", source: "auto-cover", label: `${COVER_LABELS[coverType]} (auto)`, value: COVER_AC_BONUS[coverType] || 0 });
      }
      await db.characters.update(token.refId, { acAdjustments: adjustments });
    }
    if (token.kind === "pc" && combat?.active) {
      const idx = combat.combatants.findIndex(c => c.id === token.refId);
      if (idx !== -1 && idx === combat.currentTurnIndex && !combat.combatants[idx].movementUsed) {
        const combatants = combat.combatants.map((c, i) => i === idx ? { ...c, movementUsed: true } : c);
        db.combat.set(campaignId, { combatants });
      }
    }
  }

  // ---------------- Token popup ----------------
  async function showTokenPopup(token) {
    popup.style.display = "block";
    popup.innerHTML = `<div class="spinner" style="margin:20px auto;"></div>`;
    if (token.kind === "component") {
      popup.innerHTML = `<h4>${escapeHtml(token.name)}</h4>${token.isCover ? `<p>${COVER_LABELS[token.coverType] || "Cover"}</p>` : "<p>Scenery</p>"}<button class="btn sm" id="popup-close">Close</button>`;
    } else {
      const character = await db.characters.get(token.refId);
      if (!character) { popup.style.display = "none"; return; }
      const ac = estimateArmorClass(character, null, false) + (character.acAdjustments || []).reduce((s, a) => s + a.value, 0);
      popup.innerHTML = `
        <h4>${escapeHtml(character.name)} ${token.kind === "npc" ? '<span class="badge rune">NPC</span>' : ""}</h4>
        <p>HP ${character.hp?.current ?? "?"} / ${character.hp?.max ?? "?"} \u2022 AC ${ac}</p>
        <div style="display:flex; gap:8px;">
          <button class="btn sm primary" id="popup-open">Open Sheet</button>
          <button class="btn sm ghost" id="popup-close">Close</button>
        </div>
      `;
      popup.querySelector("#popup-open").addEventListener("click", () => navigate(`/character/${character.id}`));
    }
    popup.querySelector("#popup-close").addEventListener("click", () => { popup.style.display = "none"; });
  }

  // ---------------- DM context menu on tokens ----------------
  function showTokenContextMenu(token, sx, sy) {
    const items = [];
    if (token.kind !== "component") {
      items.push({ label: "Open Character Sheet", action: () => navigate(`/character/${token.refId}`) });
      items.push("---");
      allMaps.filter(m => m.id !== currentMap.id).forEach(m => {
        items.push({ label: `Move to: ${m.name}`, action: async () => {
          await db.tokens.moveToMap(campaignId, currentMap.id, m.id, token);
          if (token.kind === "pc") await db.characters.update(token.refId, { currentMapId: m.id });
          toast(`Moved ${token.name} to ${m.name}`);
        }});
      });
      items.push("---");
    }
    items.push({ label: "Resize\u2026", action: () => resizeToken(token) });
    items.push({ label: "Remove from Map", danger: true, action: () => db.tokens.remove(campaignId, currentMap.id, token.id) });
    showContextMenu(sx, sy, items);
  }

  function resizeToken(token) {
    const input = prompt(`Size in 5ft squares as "width,height" (currently ${token.w || 1},${token.h || 1}):`, `${token.w || 1},${token.h || 1}`);
    if (!input) return;
    const [w, h] = input.split(",").map(v => Math.max(0.25, parseFloat(v.trim()) || 1));
    db.tokens.update(campaignId, currentMap.id, token.id, { w, h });
  }

  // ---------------- Sidebar content ----------------
  let sheetUnsub = null;
  function buildSidebar() {
    sidebar.innerHTML = "";
    if (isDm) {
      sidebar.appendChild(h("h3", {}, "Maps"));
      allMaps.forEach(m => {
        const btn = h("button", { class: `btn sm block ${currentMap?.id === m.id ? "primary" : ""}`, style: "margin-bottom:6px;" }, m.name);
        btn.addEventListener("click", () => loadMap(m.id));
        sidebar.appendChild(btn);
      });
    } else {
      sidebar.appendChild(h("h3", {}, "Your Character"));
      if (!myCharacter) { sidebar.appendChild(h("p", {}, "You don't have a character in this campaign yet.")); return; }
      const host = h("div", {});
      sidebar.appendChild(host);
      mountCharacterSheet(host, myCharacter.id, { viewerUid: user.uid, isDm: false, getAdvMode, onRoll }).then(u => { sheetUnsub = u; });
    }
  }

  // ---------------- Map loading ----------------
  async function loadMap(mapId) {
    unsubTokens?.(); unsubMap?.();
    currentMap = allMaps.find(m => m.id === mapId) || null;
    if (!currentMap) return;
    const bg = currentMap.backgroundBase64;
    if (!bg) {
      canvas.setBackgroundImage(null);
    } else if (bgImageCache.has(bg)) {
      canvas.setBackgroundImage(bgImageCache.get(bg));
    } else {
      const img = new Image();
      img.onload = () => { bgImageCache.set(bg, img); canvas.setBackgroundImage(img); };
      img.src = bg;
    }
    canvas.setGridPx(currentMap.gridPx);
    unsubTokens = db.tokens.subscribe(campaignId, mapId, (t) => { tokens = t; canvas.setTokens(tokens); });
    buildToolbar();
    buildSidebar();
  }

  // ---------------- Boot ----------------
  const unsubMaps = db.maps.subscribeList(campaignId, async (list) => {
    allMaps = list;
    if (isDm) {
      if (!currentMap && list.length) loadMap(list[0].id);
      else buildToolbar();
    }
    if (list.length === 0) {
      canvasHost.innerHTML = "";
      canvasHost.appendChild(h("div", { class: "empty-state" }, isDm ? "<h3>No maps yet</h3><p>Create one in Map Workshop.</p>" : "<h3>No maps yet</h3><p>Your DM hasn't built one yet.</p>"));
    }
  });

  if (!isDm) {
    const unsubParty = db.characters.subscribeCampaignParty(campaignId, (party) => {
      myCharacter = party.find(c => c.ownerUid === user.uid) || null;
      buildSidebar();
      if (myCharacter?.currentMapId) loadMap(myCharacter.currentMapId);
      else if (myCharacter) {
        canvasHost.innerHTML = "";
        canvasHost.appendChild(h("div", { class: "empty-state" }, "<h3>Not on a map yet</h3><p>Ask your DM to place you.</p>"));
      }
    });
    buildToolbar();
    return () => { unsubMaps(); unsubParty(); unsubCombat(); unsubTokens?.(); unsubMap?.(); sheetUnsub?.(); canvas.dispose(); };
  }

  buildToolbar();
  buildSidebar();
  return () => { unsubMaps(); unsubCombat(); unsubTokens?.(); unsubMap?.(); canvas.dispose(); };
}
