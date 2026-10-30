import { db } from "../../db.js";
import { h, toast, escapeHtml, showContextMenu } from "../../util.js";
import { VttCanvas, loadImageCached } from "../../vtt/vtt-canvas.js";
import { mountCharacterSheet } from "../../character-sheet.js";
import { COVER_AC_BONUS, COVER_LABELS, estimateArmorClass } from "../../rules-engine.js";
import { navigate } from "../../router.js";
import { loadRuleset } from "../../data-loader.js";
import { createNpcFromMonster, pickMonster, tokenSquaresForSize, nextMonsterName, monsterImageFor, once } from "../../monsters.js";

// Decoded map backgrounds and token images live in vtt-canvas.js's shared
// session cache (loadImageCached), so switching maps never re-decodes them.

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
  // Empty/loading states are an overlay — never wipe canvasHost, it owns the <canvas>
  const stageMessage = h("div", { class: "vtt-stage-message", style: "display:none;" });
  const syncBadge = h("span", { class: "vtt-sync-badge", title: "Sync status" });
  stage.appendChild(toolbar);
  stage.appendChild(canvasHost);
  stage.appendChild(stageMessage);
  stage.appendChild(popup);
  function showStageMessage(html) {
    stageMessage.innerHTML = html ? `<div class="empty-state">${html}</div>` : "";
    stageMessage.style.display = html ? "flex" : "none";
  }
  const unsubSync = db.sync.subscribe(({ online, pending, lastError }) => {
    syncBadge.className = `vtt-sync-badge ${!online ? "offline" : pending ? "pending" : lastError ? "error" : "ok"}`;
    syncBadge.textContent = !online ? (pending ? `Offline \u2022 ${pending} queued` : "Offline") : pending ? `Syncing ${pending}\u2026` : lastError ? "Sync error" : "Synced";
    syncBadge.title = !online ? "You're offline. Changes are saved locally and will sync when you reconnect." : lastError ? String(lastError.message || lastError) : "All changes saved";
  });

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
    canMoveShape: (shape) => isDm || shape.ownerUid === user.uid,
    onTokenMoved: (token, x, y) => handleTokenMoved(token, x, y),
    onTokenClicked: (token) => showTokenPopup(token),
    onTokenContextMenu: (token, sx, sy) => isDm && showTokenContextMenu(token, sx, sy),
    isDm: isDm,
    currentUid: user.uid,
    onFogChanged: (dataUrl) => handleFogChanged(dataUrl),
    onPersistentShapeAdded: (shape) => handleShapeAdded(shape),
    onPersistentShapeRemoved: (shape) => handleShapeRemoved(shape),
    onPersistentShapeMoved: (shape) => handleShapeMoved(shape)
  });

  // ---------------- Toolbar ----------------
  const fogSliderWrap = h("div", { class: "fog-slider-wrap", style: isDm ? "display:flex;" : "display:none;" });
  const fogSliderLabel = h("span", { class: "fog-slider-label" }, "Brush:");
  const fogSlider = h("input", { type: "range", min: canvas.getFogBrushMin(), max: canvas.getFogBrushMax(), value: canvas.getFogBrushSize(), class: "fog-slider" });
  fogSlider.addEventListener("input", () => {
    if (!isDm) return;
    canvas.setFogBrushSize(parseInt(fogSlider.value));
    fogSliderLabel.textContent = `Brush: ${Math.round(canvas.getFogBrushSize() * 5)}ft`;
  });
  fogSliderWrap.appendChild(fogSliderLabel);
  fogSliderWrap.appendChild(fogSlider);

  // Fullscreen state
  let vttFullscreen = false;

  function buildToolbar() {
    toolbar.innerHTML = "";
    const toggleBtn = h("button", { class: "icon-btn" }, "\u2630");
    toggleBtn.title = "Toggle sidebar";
    toggleBtn.addEventListener("click", () => { sidebarOpen = !sidebarOpen; sidebar.style.display = sidebarOpen ? "flex" : "none"; });
    toolbar.appendChild(toggleBtn);

    const allTools = [["select", "Select"], ["ruler", "Ruler"], ["shape-rect", "Rect AoE"], ["shape-circle", "Circle AoE"], ["shape-cone", "Cone AoE"]];
    if (isDm) {
      allTools.push(["draw-fog", "Draw Fog"], ["erase-fog", "Erase Fog"]);
    }
    allTools.forEach(([tool, label]) => {
      const title = tool === "select" ? "Left-click: select / drag tokens and shapes \u2022 Right-drag: pan the map" : label;
      const btn = h("button", { class: `btn sm ${canvas.tool === tool ? "primary" : ""}`, title }, label);
      btn.addEventListener("click", () => { canvas.setTool(tool); buildToolbar(); });
      toolbar.appendChild(btn);
    });

    toolbar.appendChild(fogSliderWrap);

    // Separator
    toolbar.appendChild(h("span", { style: "display:inline-block;width:1px;height:20px;background:var(--line);margin:0 4px;" }));

    // Fullscreen toggle
    const fsBtn = h("button", { class: "icon-btn", title: "Toggle fullscreen (Esc)" }, "⛶");
    fsBtn.addEventListener("click", toggleVttFullscreen);
    toolbar.appendChild(fsBtn);

    const zoomOut = h("button", { class: "icon-btn" }, "\u2212");
    zoomOut.addEventListener("click", () => canvas.zoomBy(0.85));
    const zoomIn = h("button", { class: "icon-btn" }, "+");
    zoomIn.addEventListener("click", () => canvas.zoomBy(1.15));
    const fitBtn = h("button", { class: "btn sm" }, "Fit");
    fitBtn.addEventListener("click", () => { canvas._fitToView(); canvas._hasSavedView = true; });
    toolbar.appendChild(zoomOut); toolbar.appendChild(zoomIn); toolbar.appendChild(fitBtn);

    if (isDm) {
      // Fog management buttons
      const clearFogBtn = h("button", { class: "btn sm danger", title: "Clear all fog" }, "✕ Fog");
      clearFogBtn.addEventListener("click", () => {
        if (!currentMap) return;
        if (!confirm("Clear all fog on this map?")) return;
        canvas.clearFog();
        handleFogChanged(null);
        toast("All fog cleared");
      });
      toolbar.appendChild(clearFogBtn);

      const mapSel = h("select", { style: "max-width:200px; margin:0;" });
      allMaps.forEach(m => mapSel.appendChild(h("option", { value: m.id, selected: currentMap?.id === m.id ? "selected" : null }, m.name)));
      mapSel.addEventListener("change", () => loadMap(mapSel.value));
      toolbar.appendChild(mapSel);
    }

    // Update sliders visibility based on active tool
    if (isDm) {
      const isFogTool = canvas.tool === "draw-fog" || canvas.tool === "erase-fog";
      fogSliderWrap.style.display = isFogTool ? "flex" : "none";
      if (isFogTool) {
        fogSlider.value = canvas.getFogBrushSize();
        fogSliderLabel.textContent = `Brush: ${Math.round(canvas.getFogBrushSize() * 5)}ft`;
      }
    } else {
      // Non-DM: never show fog controls
      fogSliderWrap.style.display = "none";
    }
    toolbar.appendChild(h("span", { style: "flex:1;" }));
    toolbar.appendChild(syncBadge);
  }

  // ---------------- FAB (DM adds tokens) ----------------
  const fabCharacters = h("button", { class: "vtt-fab" }, "\u{1F464}");
  fabCharacters.title = "Add a character or NPC token";
  const fabComponents = h("button", { class: "vtt-fab vtt-fab-secondary" }, "\u25a2");
  fabComponents.title = "Add a component token";
  const fabMonsters = h("button", { class: "vtt-fab vtt-fab-monster" }, "\u{1F409}");
  fabMonsters.title = "Add a monster from the Monster Manual";
  if (isDm) { stage.appendChild(fabCharacters); stage.appendChild(fabComponents); stage.appendChild(fabMonsters); }

  // Grid position that centers a token of the given size in the current view
  function viewCenterSpot(w, h) {
    const c = canvas.screenToWorld(canvasHost.clientWidth / 2, canvasHost.clientHeight / 2);
    const g = canvas.worldToGrid(c.x, c.y);
    return { x: Math.max(0, Math.round(g.x - w / 2)), y: Math.max(0, Math.round(g.y - h / 2)) };
  }

  // Token footprint for an NPC: its own stored size, else its catalog monster's size
  async function npcTokenSquares(npc) {
    let size = npc.size;
    if (!size && npc.monsterId) {
      const ruleset = await loadRuleset();
      size = ruleset.monsters?.find(m => m.id === npc.monsterId)?.size;
    }
    return tokenSquaresForSize(size);
  }

  fabMonsters.addEventListener("click", async () => {
    if (!currentMap) { toast("Create a map first", "error"); return; }
    const ruleset = await loadRuleset();
    const monster = await pickMonster(ruleset.monsters || [], { campaignId });
    if (!monster) return;
    const [name, portraitBase64] = await Promise.all([nextMonsterName(campaignId, monster.name), monsterImageFor(campaignId, monster.id)]);
    const npcId = await createNpcFromMonster(monster, { name, user, campaignId, portraitBase64 });
    const sq = tokenSquaresForSize(monster.size);
    await addToken({ kind: "npc", refId: npcId, name, imageBase64: portraitBase64, ...viewCenterSpot(sq, sq), w: sq, h: sq });
    toast(`${name} added to the map (also listed under NPCs)`);
  });

  fabCharacters.addEventListener("click", async () => {
    const [party, npcs] = await Promise.all([
      once(cb => db.characters.subscribeCampaignParty(campaignId, cb)),
      once(cb => db.characters.subscribeCampaignNpcs(campaignId, cb))
    ]);
    const items = [];
    items.push({ header: "Player Characters" });
    if (party.length === 0) items.push({ label: "No player characters in this campaign yet", action: () => {} });
    party.forEach(c => items.push({ label: c.name, action: () => addToken({ kind: "pc", refId: c.id, name: c.name, imageBase64: c.portraitBase64 || null, x: 2, y: 2, w: 1, h: 1 }) }));
    items.push("---");
    items.push({ header: "NPCs" });
    if (npcs.length === 0) items.push({ label: "No NPCs yet \u2014 create one in the NPCs tab", action: () => {} });
    npcs.forEach(c => items.push({ label: c.name, action: async () => {
      const sq = await npcTokenSquares(c);
      addToken({ kind: "npc", refId: c.id, name: c.name, imageBase64: c.portraitBase64 || null, ...viewCenterSpot(sq, sq), w: sq, h: sq });
    } }));
    const rect = fabCharacters.getBoundingClientRect();
    showContextMenu(rect.left, rect.top - 10, items);
  });

  fabComponents.addEventListener("click", async () => {
    const [library, folders] = await Promise.all([
      once(cb => db.componentLibrary.subscribe(campaignId, cb)),
      once(cb => db.componentFolders.subscribe(campaignId, cb))
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
    const mapId = currentMap.id;
    await db.tokens.add(campaignId, mapId, token);
    // A player's VTT follows their character's currentMapId
    if (token.kind === "pc" && token.refId) await db.characters.update(token.refId, { currentMapId: mapId });
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
    if (!token || !token.kind) return; // guard against null from shape clicks
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

  // ---------------- Fog of war handlers ----------------
  // Fog is one bitmap mask per map (maps/{mapId}/fogs/mask). Older maps stored
  // fog as an array of circles/strokes on the map doc (`fogs`); those are drawn
  // into the mask until the DM's first edit saves a mask and clears them.
  let legacyFogs = [];
  let fogMaskDoc;            // undefined until the first snapshot arrives
  let lastFogKey = null;
  let unsubFogs = null, unsubFogMask = null;

  function applyFog() {
    if (fogMaskDoc === undefined) return;
    const dataUrl = fogMaskDoc?.dataUrl || null;
    const legacy = dataUrl ? [] : legacyFogs;
    const key = (dataUrl || "") + "|" + (legacy.length ? JSON.stringify(legacy) : "");
    if (key === lastFogKey) return; // unrelated map-doc updates mustn't reset the fog
    lastFogKey = key;
    canvas.setFogMask(dataUrl, legacy);
  }

  async function handleFogChanged(dataUrl) {
    if (!currentMap || !isDm) return; // Non-DM can't modify fog
    const mapId = currentMap.id;
    lastFogKey = (dataUrl || "") + "|";
    await db.fogMask.set(campaignId, mapId, dataUrl);
    if (legacyFogs.length) {
      legacyFogs = [];
      await db.maps.updateFogs(campaignId, mapId, []);
    }
  }

  // ---------------- Persistent AoE shapes handlers ----------------
  // One doc per shape (db.shapes). Older maps kept every shape in one array on the
  // map doc — whole-array writes from two people at once lost one of the edits.
  // Those legacy shapes are shown merged and moved into docs on first touch.
  let currentShapes = [];
  let docShapes = [];
  let legacyShapes = [];
  function refreshShapes() {
    const ids = new Set(docShapes.map(sh => sh.id));
    currentShapes = [...docShapes, ...legacyShapes.filter(sh => !ids.has(sh.id))];
    canvas.setPersistentShapes(currentShapes);
  }
  async function migrateLegacyShapes(mapId) {
    if (!isDm || !legacyShapes.length) return;
    const toMove = legacyShapes;
    legacyShapes = [];
    await Promise.all(toMove.map(sh => db.shapes.set(campaignId, mapId, sh)));
    await db.maps.updatePersistentShapes(campaignId, mapId, []);
  }

  async function handleShapeAdded(shape) {
    if (!currentMap) return;
    await db.shapes.set(campaignId, currentMap.id, shape);
  }

  async function handleShapeRemoved(shape) {
    if (!currentMap) return;
    const mapId = currentMap.id;
    if (legacyShapes.some(sh => sh.id === shape.id)) {
      legacyShapes = legacyShapes.filter(sh => sh.id !== shape.id);
      await db.maps.updatePersistentShapes(campaignId, mapId, legacyShapes);
    }
    await db.shapes.remove(campaignId, mapId, shape.id);
  }

  async function handleShapeMoved(shape) {
    if (!currentMap) return;
    const { _previewX, _previewY, ...clean } = shape;
    await db.shapes.set(campaignId, currentMap.id, clean);
    if (legacyShapes.some(sh => sh.id === shape.id)) {
      legacyShapes = legacyShapes.filter(sh => sh.id !== shape.id);
      await db.maps.updatePersistentShapes(campaignId, currentMap.id, legacyShapes);
    }
  }

  // ---------------- VTT Fullscreen ----------------
  function toggleVttFullscreen() {
    vttFullscreen = !vttFullscreen;
    if (vttFullscreen) {
      shell.classList.add("vtt-shell--fullscreen");
      stage.style.flex = "1";
      stage.style.minHeight = "0";
    } else {
      shell.classList.remove("vtt-shell--fullscreen");
      stage.style.flex = "";
      stage.style.minHeight = "";
    }
    setTimeout(() => {
      canvas._resize();
      canvas._fitToView();
    }, 50);
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && vttFullscreen) {
      toggleVttFullscreen();
    }
    // Delete selected shape
    if ((e.key === "Delete" || e.key === "Backspace") && canvas.selectedShape && !e.target.closest?.("input, textarea, select, [contenteditable]")) {
      const shape = canvas.selectedShape;
      // Only allow deletion if user owns it or is DM
      if (isDm || shape.ownerUid === user.uid) {
        canvas.removePersistentShape(shape);
        canvas.selectedShape = null;
      }
    }
  });

  // ---------------- Sidebar content ----------------
  let sheetUnsub = null;
  let sheetCharId = null;
  function buildSidebar() {
    // The player's docked sheet stays mounted (it live-updates itself); only
    // remount when the character itself changes.
    if (!isDm && myCharacter && sheetCharId === myCharacter.id && sidebar.childElementCount) return;
    sheetUnsub?.(); sheetUnsub = null; sheetCharId = null;
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
      sheetCharId = myCharacter.id;
      const mountedFor = myCharacter.id;
      mountCharacterSheet(host, myCharacter.id, { viewerUid: user.uid, isDm: false, getAdvMode, onRoll }).then(u => {
        if (sheetCharId === mountedFor) sheetUnsub = u; else u?.();
      });
    }
  }

  // ---------------- Map loading ----------------
  // Fog first: the canvas covers the map for players until this map's fog mask has
  // been decoded (instant when it was seen before this session), then the
  // background, tokens and shapes stream in underneath it.
  let unsubShapes = null;
  let loadedMapId = null;
  let shownBg = null;
  function applyMapDoc(map) {
    if (!map) return;
    currentMap = map;
    canvas.setMapSize(map.widthPx, map.heightPx);
    canvas.setGridPx(map.gridPx);
    const bg = map.backgroundBase64 || null;
    if (bg === shownBg) return;
    shownBg = bg;
    if (!bg) { canvas.setBackgroundImage(null); return; }
    loadImageCached(bg).then(img => {
      if (shownBg !== bg || loadedMapId !== map.id) return; // superseded
      if (img) canvas.setBackgroundImage(img);
      else toast("Failed to load map background", "error");
    });
  }

  function loadMap(mapId) {
    if (!mapId) return;
    if (mapId === loadedMapId && currentMap) return; // already showing it
    unsubTokens?.(); unsubMap?.(); unsubFogs?.(); unsubFogMask?.(); unsubShapes?.();
    const map = allMaps.find(m => m.id === mapId) || (currentMap?.id === mapId ? currentMap : null);
    loadedMapId = mapId;
    showStageMessage(null);
    legacyFogs = []; fogMaskDoc = undefined; lastFogKey = null;
    docShapes = []; legacyShapes = []; currentShapes = [];
    tokens = [];
    canvas.setTokens([]);
    canvas.setPersistentShapes([]);
    canvas.setViewKey(`${campaignId}:${mapId}`);
    shownBg = undefined;
    if (map) applyMapDoc(map);
    unsubFogMask = db.fogMask.subscribe(campaignId, mapId, (doc) => {
      fogMaskDoc = doc;
      applyFog();
    });
    unsubTokens = db.tokens.subscribe(campaignId, mapId, (t) => { tokens = t; canvas.setTokens(tokens); });
    unsubShapes = db.shapes.subscribe(campaignId, mapId, (list) => { docShapes = list; refreshShapes(); });
    unsubFogs = db.maps.subscribe(campaignId, mapId, (m) => {
      if (!m) return;
      applyMapDoc(m);
      legacyFogs = m.fogs || [];
      legacyShapes = m.persistentShapes || [];
      refreshShapes();
      applyFog();
      migrateLegacyShapes(mapId);
    });
    buildToolbar();
    buildSidebar();
  }

  // ---------------- Boot ----------------
  const unsubMaps = db.maps.subscribeList(campaignId, async (list) => {
    allMaps = list;
    if (isDm) {
      if (!loadedMapId && list.length) loadMap(list[0].id);
      else if (loadedMapId && !list.some(m => m.id === loadedMapId)) { loadedMapId = null; currentMap = null; if (list.length) loadMap(list[0].id); }
      else buildToolbar();
      if (!list.length) showStageMessage("<h3>No maps yet</h3><p>Create one in Map Workshop.</p>");
    } else if (!list.length) {
      showStageMessage("<h3>No maps yet</h3><p>Your DM hasn't built one yet.</p>");
    }
  });

  if (!isDm) {
    // Party snapshots fire on any party member's change (HP, inventory, notes...).
    // Only a change of *this player's* map should reload the VTT.
    let lastCharId = null;
    const unsubParty = db.characters.subscribeCampaignParty(campaignId, (party) => {
      myCharacter = party.find(c => c.ownerUid === user.uid) || null;
      if (myCharacter?.id !== lastCharId) { lastCharId = myCharacter?.id || null; buildSidebar(); }
      if (myCharacter?.currentMapId) {
        if (myCharacter.currentMapId !== loadedMapId) loadMap(myCharacter.currentMapId);
      } else {
        if (loadedMapId) {
          unsubTokens?.(); unsubFogs?.(); unsubFogMask?.(); unsubShapes?.();
          loadedMapId = null; currentMap = null;
          canvas.setTokens([]); canvas.setPersistentShapes([]);
        }
        showStageMessage(myCharacter ? "<h3>Not on a map yet</h3><p>Ask your DM to place you.</p>" : "<h3>No character here yet</h3><p>Join this campaign with a character first.</p>");
      }
    });
    buildToolbar();
    return () => { unsubMaps(); unsubParty(); unsubCombat(); unsubSync(); unsubTokens?.(); unsubMap?.(); unsubFogs?.(); unsubFogMask?.(); unsubShapes?.(); sheetUnsub?.(); canvas.dispose(); };
  }

  buildToolbar();
  buildSidebar();
  return () => { unsubMaps(); unsubCombat(); unsubSync(); unsubTokens?.(); unsubMap?.(); unsubFogs?.(); unsubFogMask?.(); unsubShapes?.(); canvas.dispose(); };
}
