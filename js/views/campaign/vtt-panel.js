import { db } from "../../db.js";
import { h, toast, showContextMenu } from "../../util.js";
import { VttCanvas, loadImageCached } from "../../vtt/vtt-canvas.js";
import { mountCharacterSheet } from "../../character-sheet.js";
import { COVER_AC_BONUS, COVER_LABELS } from "../../rules-engine.js";
import { navigate } from "../../router.js";
import { loadRuleset } from "../../data-loader.js";
import { pickMonster, tokenSquaresForSize, monsterImageFor, once } from "../../monsters.js";
import { createCreatureTools } from "../../vtt/creature-panel.js";
import { SIZES, CONDITION_ABBR, SPEED_ZERO, hasSpeedZero, monsterTokenStats } from "../../vtt/creatures.js";

// Decoded map backgrounds and token images live in vtt-canvas.js's shared
// session cache (loadImageCached), so switching maps never re-decodes them.
//
// Token kinds: "pc" / "npc" point at a character doc (refId); "monster" tokens
// carry their own state (`stats`, `loot`) and exist only on the map — removing
// one removes the monster. Any token can be `hidden` (DM-only). A grappled
// creature has `grappledBy` (grappler token id) + `grappleOffset` and moves with it.

const TOOLS = [
  { id: "select", icon: "⬉", label: "Select", key: "v", title: "Select (V) — left-drag tokens and shapes, right-drag to pan, click a creature for its panel" },
  { id: "ruler", icon: "\u{1F4CF}", label: "Ruler", key: "r", title: "Ruler (R) — drag to measure; right-click clears" },
  { id: "shape-rect", icon: "▭", label: "Square", key: "s", title: "Square / line AoE (S)" },
  { id: "shape-circle", icon: "◯", label: "Circle", key: "c", title: "Circle / sphere AoE (C) — drag across the diameter" },
  { id: "shape-cone", icon: "◁", label: "Cone", key: "t", title: "Cone AoE (T) — drag from the point of origin" }
];
const FOG_TOOLS = [
  { id: "draw-fog", icon: "☁", label: "Fog", key: "g", title: "Paint fog (G)" },
  { id: "erase-fog", icon: "☀", label: "Reveal", key: "e", title: "Erase fog to reveal (E)" }
];

export async function mountVttPanel(container, { campaignId, user, isDm, getAdvMode, onRoll }) {
  const shell = h("div", { class: "vtt-shell" });
  const sidebar = h("div", { class: "vtt-sidebar" });
  const stage = h("div", { class: "vtt-stage" });
  shell.appendChild(sidebar);
  shell.appendChild(stage);
  container.appendChild(shell);

  const toolbar = h("div", { class: "vtt-toolbar" });
  const canvasHost = h("div", { class: "vtt-canvas-host" });
  // The creature panel sits over the canvas (below the toolbar) so it is visible in fullscreen too
  const popup = h("div", { class: "vtt-token-popup", style: "display:none;" });
  // Empty/loading states are an overlay — never wipe canvasHost, it owns the <canvas>
  const stageMessage = h("div", { class: "vtt-stage-message", style: "display:none;" });
  const syncBadge = h("span", { class: "vtt-sync-badge", title: "Sync status" });
  stage.appendChild(toolbar);
  stage.appendChild(canvasHost);
  stage.appendChild(stageMessage);
  function showStageMessage(html) {
    stageMessage.innerHTML = html ? `<div class="empty-state">${html}</div>` : "";
    stageMessage.style.display = html ? "flex" : "none";
  }
  const unsubSync = db.sync.subscribe(({ online, pending, lastError }) => {
    syncBadge.className = `vtt-sync-badge ${!online ? "offline" : pending ? "pending" : lastError ? "error" : "ok"}`;
    syncBadge.textContent = !online ? (pending ? `Offline • ${pending} queued` : "Offline") : pending ? `Syncing ${pending}…` : lastError ? "Sync error" : "Synced";
    syncBadge.title = !online ? "You're offline. Changes are saved locally and will sync when you reconnect." : lastError ? String(lastError.message || lastError) : "All changes saved";
  });

  const ruleset = await loadRuleset();
  const monstersById = new Map((ruleset.monsters || []).map(m => [m.id, m]));

  let myCharacter = null;
  let allMaps = [];
  let currentMap = null;
  let tokens = [];
  let sidebarOpen = true;
  let unsubTokens = null, unsubMap = null;
  let combat = null;
  const charById = new Map();
  let party = [], npcs = [];

  const tools = createCreatureTools({
    campaignId, user, isDm,
    mapId: () => currentMap?.id,
    tokens: () => tokens,
    charOf: (t) => charById.get(t.refId),
    monsterOf: (t) => monstersById.get(t.monsterId),
    ruleset: () => ruleset,
    combat: () => combat
  });

  const canvas = new VttCanvas(canvasHost, {
    canMoveToken: (token) => canMove(token),
    canMoveShape: (shape) => isDm || shape.ownerUid === user.uid,
    onTokenMoved: (token, x, y, followers) => handleTokenMoved(token, x, y, followers),
    onTokenClicked: (token) => showTokenPopup(token),
    onTokenBlocked: (token) => explainBlocked(token),
    onTokenContextMenu: (token, sx, sy) => isDm && showTokenContextMenu(token, sx, sy),
    isDm: isDm,
    currentUid: user.uid,
    onFogChanged: (dataUrl) => handleFogChanged(dataUrl),
    onPersistentShapeAdded: (shape) => handleShapeAdded(shape),
    onPersistentShapeRemoved: (shape) => handleShapeRemoved(shape),
    onPersistentShapeMoved: (shape) => handleShapeMoved(shape)
  });
  canvasHost.appendChild(popup);

  // ---------------- Token decoration (what the canvas draws on each creature) ----------------
  function decorate(t) {
    if (t.kind === "component") return t;
    const st = tools.stateOf(t);
    if (!st) return t;
    const conds = st.conditions.map(c => CONDITION_ABBR[c]).filter(Boolean);
    if (st.exhaustion) conds.push("Ex");
    const g = t.grappledBy ? tokens.find(o => o.id === t.grappledBy) : null;
    const follow = g && st.conditions.includes("Grappled") ? { id: g.id, dx: t.grappleOffset?.dx ?? (t.x - g.x), dy: t.grappleOffset?.dy ?? (t.y - g.y) } : null;
    const cur = combat?.active ? combat.combatants?.[combat.currentTurnIndex] : null;
    const showHp = isDm || t.kind === "pc";
    return { ...t, _st: {
      conds, follow, dead: st.dead, invisible: st.conditions.includes("Invisible"),
      hpFrac: showHp && st.hp.max ? st.hp.current / st.hp.max : null,
      turn: !!cur && cur.id === (t.kind === "monster" ? t.id : t.refId)
    } };
  }
  let refreshQueued = false;
  function refreshTokens() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => {
      refreshQueued = false;
      canvas.setTokens(tokens.filter(t => isDm || !t.hidden).map(decorate));
      renderPopup();
      tools.reconcile();
    });
  }

  const unsubCombat = db.combat.subscribe(campaignId, (c) => { combat = c; refreshTokens(); });
  function indexCharacters() {
    charById.clear();
    [...party, ...npcs].forEach(c => charById.set(c.id, c));
    refreshTokens();
  }
  const unsubNpcs = db.characters.subscribeCampaignNpcs(campaignId, (list) => { npcs = list; indexCharacters(); });

  // ---------------- Movement rules ----------------
  function canMove(token) {
    if (!(isDm || (token.kind === "pc" && token.refId === myCharacter?.id))) return false;
    if (token._st?.follow) return false;              // grappled: moves only with its grappler
    if (!isDm) {
      const st = tools.stateOf(token);
      if (st && (st.dead || hasSpeedZero(st.conditions))) return false;
    }
    return true;
  }

  function explainBlocked(token) {
    const st = tools.stateOf(token);
    if (token._st?.follow) {
      const g = tokens.find(t => t.id === token._st.follow.id);
      toast(`${st?.name || token.name} is Grappled by ${g?.name || "another creature"} — it moves when they move. Release the grapple to move it.`, "error");
    } else if (st && hasSpeedZero(st.conditions)) {
      toast(`${st.name} can't move — Speed 0 (${st.conditions.find(c => SPEED_ZERO.includes(c))})`, "error");
    } else if (st?.dead) {
      toast(`${st.name} is dead`, "error");
    } else if (!isDm) {
      toast("You can only move your own character", "error");
    }
  }

  // ---------------- Toolbar ----------------
  const fogSliderWrap = h("div", { class: "fog-slider-wrap", style: "display:none;" });
  const fogSliderLabel = h("span", { class: "fog-slider-label" }, "Brush:");
  const fogSlider = h("input", { type: "range", min: canvas.getFogBrushMin(), max: canvas.getFogBrushMax(), value: canvas.getFogBrushSize(), class: "fog-slider" });
  fogSlider.addEventListener("input", () => {
    if (!isDm) return;
    canvas.setFogBrushSize(parseInt(fogSlider.value));
    fogSliderLabel.textContent = `Brush: ${Math.round(canvas.getFogBrushSize() * 5)}ft`;
  });
  fogSliderWrap.appendChild(fogSliderLabel);
  fogSliderWrap.appendChild(fogSlider);

  let vttFullscreen = false;
  const toolButtons = new Map();

  function toolButton({ icon, label, title }, onClick, extraClass = "") {
    const b = h("button", { class: `vtt-tool ${extraClass}`, title, type: "button" }, `<span class="ico">${icon}</span><span class="lbl">${label}</span>`);
    b.addEventListener("click", onClick);
    return b;
  }

  function setTool(id) {
    canvas.setTool(id);
    syncToolbar();
  }

  function syncToolbar() {
    toolButtons.forEach((b, id) => b.classList.toggle("active", canvas.tool === id));
    const isFogTool = isDm && (canvas.tool === "draw-fog" || canvas.tool === "erase-fog");
    fogSliderWrap.style.display = isFogTool ? "flex" : "none";
    if (isFogTool) {
      fogSlider.value = canvas.getFogBrushSize();
      fogSliderLabel.textContent = `Brush: ${Math.round(canvas.getFogBrushSize() * 5)}ft`;
    }
    fsBtn.classList.toggle("active", vttFullscreen);
    fsBtn.querySelector(".lbl").textContent = vttFullscreen ? "Exit" : "Full";
  }

  const fsBtn = toolButton({ icon: "⛶", label: "Full", title: "Fullscreen (F) — Esc to leave" }, () => toggleVttFullscreen());

  function buildToolbar() {
    toolbar.innerHTML = "";
    toolButtons.clear();
    const sideBtn = toolButton({ icon: "☰", label: "", title: "Toggle sidebar" }, () => { sidebarOpen = !sidebarOpen; sidebar.style.display = sidebarOpen ? "flex" : "none"; requestAnimationFrame(() => canvas._resize()); }, "icon-only");
    toolbar.appendChild(sideBtn);

    const group = (items) => { const g = h("div", { class: "vtt-tool-group" }); items.forEach(i => g.appendChild(i)); toolbar.appendChild(g); return g; };
    group(TOOLS.map(t => { const b = toolButton(t, () => setTool(t.id)); toolButtons.set(t.id, b); return b; }));
    if (isDm) {
      const fogGroup = group(FOG_TOOLS.map(t => { const b = toolButton(t, () => setTool(t.id)); toolButtons.set(t.id, b); return b; }));
      fogGroup.appendChild(fogSliderWrap);
      fogGroup.appendChild(toolButton({ icon: "✕", label: "Clear", title: "Remove all fog from this map" }, () => {
        if (!currentMap) return;
        if (!confirm("Clear all fog on this map?")) return;
        canvas.clearFog();
        handleFogChanged(null);
        toast("All fog cleared");
      }, "danger"));
    }
    group([
      toolButton({ icon: "−", label: "", title: "Zoom out (−)" }, () => canvas.zoomBy(0.85), "icon-only"),
      toolButton({ icon: "+", label: "", title: "Zoom in (+)" }, () => canvas.zoomBy(1.15), "icon-only"),
      toolButton({ icon: "⤢", label: "Fit", title: "Fit the map to the view (0)" }, () => { canvas._fitToView(); canvas._hasSavedView = true; }),
      fsBtn
    ]);
    if (isDm) {
      group([toolButton({ icon: "⚔", label: "Encounter", title: "Put every visible creature on this map into the initiative order (monsters roll automatically)" }, () => {
        const creatures = tokens.filter(t => t.kind !== "component");
        const list = creatures.filter(t => !t.hidden);
        const hiddenCount = creatures.length - list.length;
        if (hiddenCount) toast(`${hiddenCount} hidden creature${hiddenCount === 1 ? "" : "s"} left out \u2014 show them, or use Initiative in their panel, to add them`);
        if (!list.length) { toast("No visible creatures on this map", "error"); return; }
        tools.addToInitiative(list);
      })]);
      const mapSel = h("select", { class: "vtt-map-select", title: "Switch map" });
      allMaps.forEach(m => mapSel.appendChild(h("option", { value: m.id, selected: currentMap?.id === m.id ? "selected" : null }, m.name)));
      mapSel.addEventListener("change", () => loadMap(mapSel.value));
      toolbar.appendChild(mapSel);
    }
    toolbar.appendChild(h("span", { style: "flex:1;" }));
    toolbar.appendChild(syncBadge);
    syncToolbar();
  }

  // ---------------- FAB (DM adds tokens) ----------------
  const fabCharacters = h("button", { class: "vtt-fab" }, "\u{1F464}");
  fabCharacters.title = "Add a character or NPC token";
  const fabComponents = h("button", { class: "vtt-fab vtt-fab-secondary" }, "▢");
  fabComponents.title = "Add a component token";
  const fabMonsters = h("button", { class: "vtt-fab vtt-fab-monster" }, "\u{1F409}");
  fabMonsters.title = "Add monsters from the Monster Manual (they live on the map only)";
  if (isDm) { canvasHost.appendChild(fabCharacters); canvasHost.appendChild(fabComponents); canvasHost.appendChild(fabMonsters); }

  // Grid position that centers a token of the given size in the current view
  function viewCenterSpot(w, h) {
    const c = canvas.screenToWorld(canvasHost.clientWidth / 2, canvasHost.clientHeight / 2);
    const g = canvas.worldToGrid(c.x, c.y);
    return { x: Math.max(0, Math.round(g.x - w / 2)), y: Math.max(0, Math.round(g.y - h / 2)) };
  }

  // Token footprint for an NPC: its own stored size, else its catalog monster's size
  function npcTokenSquares(npc) {
    return tokenSquaresForSize(npc.size || monstersById.get(npc.monsterId)?.size);
  }

  // "Goblin Warrior", "Goblin Warrior 2", ... unique among this map's tokens
  function nextTokenNames(base, count) {
    const taken = new Set(tokens.map(t => (t.name || "").trim().toLowerCase()));
    const out = [];
    let n = 1;
    while (out.length < count) {
      const name = n === 1 ? base : `${base} ${n}`;
      if (!taken.has(name.toLowerCase())) { out.push(name); taken.add(name.toLowerCase()); }
      n++;
    }
    return out;
  }

  fabMonsters.addEventListener("click", async () => {
    if (!currentMap) { toast("Create a map first", "error"); return; }
    const pick = await pickMonster(ruleset.monsters || [], { campaignId, placement: true });
    if (!pick) return;
    const { monster, count, hidden } = pick;
    const img = await monsterImageFor(campaignId, monster.id);
    const sq = tokenSquaresForSize(monster.size);
    const start = viewCenterSpot(sq * Math.min(count, 4), sq * Math.ceil(count / 4));
    const names = nextTokenNames(monster.name, count);
    // Not awaited one by one: on a slow connection each write waits for the server
    await Promise.all(names.map((name, i) => addToken({
      kind: "monster", monsterId: monster.id, name, imageBase64: img || null,
      x: start.x + (i % 4) * sq, y: start.y + Math.floor(i / 4) * sq, w: sq, h: sq,
      hidden: !!hidden, stats: monsterTokenStats(monster)
    })));
    toast(`${count > 1 ? `${count} × ${monster.name}` : names[0]} placed${hidden ? " (hidden from players)" : ""}`);
  });

  fabCharacters.addEventListener("click", async () => {
    const [partyList, npcList] = await Promise.all([
      once(cb => db.characters.subscribeCampaignParty(campaignId, cb)),
      once(cb => db.characters.subscribeCampaignNpcs(campaignId, cb))
    ]);
    const shownNpcs = npcList.filter(c => !c.hiddenFromRoster);
    const items = [];
    items.push({ header: "Player Characters" });
    if (partyList.length === 0) items.push({ label: "No player characters in this campaign yet", action: () => {} });
    partyList.forEach(c => items.push({ label: c.name, action: () => addToken({ kind: "pc", refId: c.id, name: c.name, imageBase64: c.portraitBase64 || null, ...viewCenterSpot(1, 1), w: 1, h: 1 }) }));
    items.push("---");
    items.push({ header: "NPCs" });
    if (shownNpcs.length === 0) items.push({ label: npcList.length ? "All NPCs are hidden — unhide them in the NPCs tab" : "No NPCs yet — create one in the NPCs tab", action: () => {} });
    shownNpcs.forEach(c => items.push({ label: c.name, action: () => {
      const sq = npcTokenSquares(c);
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
      items.push({ label: "No components yet — create one in Map Workshop", action: () => {} });
    } else {
      const grouped = {};
      library.forEach(c => { const key = c.folderId || "__none__"; grouped[key] = grouped[key] || []; grouped[key].push(c); });
      Object.entries(grouped).forEach(([folderId, comps], i) => {
        if (i > 0) items.push("---");
        items.push({ header: folders.find(f => f.id === folderId)?.name || "No Folder" });
        comps.forEach(c => items.push({ label: c.name, action: () => addToken({ kind: "component", refId: c.id, name: c.name, imageBase64: c.imageBase64 || null, ...viewCenterSpot(c.defaultW || 1, c.defaultH || 1), w: c.defaultW || 1, h: c.defaultH || 1, isCover: c.isCover || false, coverType: c.coverType || "half" }) }));
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

  // ---------------- Moves (cover, grapple followers, movement used) ----------------
  async function handleTokenMoved(token, x, y, followers = []) {
    const mapId = currentMap.id;
    await db.tokens.update(campaignId, mapId, token.id, { x, y });
    // The DM writes followers directly; for a player dragging a grappled monster the
    // DM's client catches up (players may only write their own token).
    if (isDm) await Promise.all(followers.map(f => db.tokens.update(campaignId, mapId, f.token.id, { x: f.x, y: f.y })));
    if (token.kind === "pc" || token.kind === "npc") {
      const coverType = canvas.tokenOverlapsCover(token);
      const character = charById.get(token.refId) || await db.characters.get(token.refId);
      if (!character) return;
      const adjustments = (character.acAdjustments || []).filter(a => a.source !== "auto-cover");
      if (coverType) {
        adjustments.push({ id: "auto-cover", source: "auto-cover", label: `${COVER_LABELS[coverType]} (auto)`, value: COVER_AC_BONUS[coverType] || 0 });
      }
      const had = (character.acAdjustments || []).find(a => a.source === "auto-cover");
      if ((had?.label || null) !== (adjustments.find(a => a.source === "auto-cover")?.label || null)) await db.characters.update(token.refId, { acAdjustments: adjustments });
    }
    if (token.kind === "pc" && combat?.active) {
      const idx = combat.combatants.findIndex(c => c.id === token.refId);
      if (idx !== -1 && idx === combat.currentTurnIndex && !combat.combatants[idx].movementUsed) {
        const combatants = combat.combatants.map((c, i) => i === idx ? { ...c, movementUsed: true } : c);
        db.combat.set(campaignId, { combatants });
      }
    }
  }

  // ---------------- Creature panel ----------------
  let openTokenId = null;
  let popupStale = false;
  function showTokenPopup(token) {
    if (!token?.kind) return;
    openTokenId = token.id;
    renderPopup(true);
  }
  function closePopup() {
    openTokenId = null;
    popup.style.display = "none";
    popup.innerHTML = "";
  }
  function renderPopup(force = false) {
    if (!openTokenId) return;
    const t = tokens.find(x => x.id === openTokenId);
    if (!t || (!isDm && t.hidden)) { closePopup(); return; }
    // Don't rebuild under the cursor while someone is typing in the panel
    const active = document.activeElement;
    if (!force && popup.contains(active) && active.matches("input, select, textarea")) { popupStale = true; return; }
    popupStale = false;
    const scroll = popup.scrollTop;
    popup.style.display = "block";
    tools.render(popup, t, {
      onClose: closePopup,
      onSize: (tok, anchor) => { const r = anchor.getBoundingClientRect(); sizeMenu(tok, r.left, r.bottom); },
      onToggleHidden: toggleHidden,
      onRemove: removeToken,
      onOpenSheet: (tok) => navigate(`/character/${tok.refId}`)
    });
    popup.scrollTop = scroll;
  }
  popup.addEventListener("focusout", () => setTimeout(() => { if (popupStale && !popup.contains(document.activeElement)) renderPopup(); }, 0));

  function sizeMenu(token, x, y) {
    const items = [{ header: "Token size (PHB creature sizes)" }];
    SIZES.filter(s => s.id !== "small").forEach(s => items.push({
      label: `${(token.w || 1) === s.squares && (token.h || 1) === s.squares ? "✓ " : ""}${s.id === "medium" ? "Small / Medium" : s.label} — ${s.space}`,
      action: () => setTokenSize(token, s.squares)
    }));
    items.push("---");
    items.push({ label: "Custom…", action: () => {
      const input = prompt(`Size in 5 ft squares as "width,height" (currently ${token.w || 1},${token.h || 1}):`, `${token.w || 1},${token.h || 1}`);
      if (!input) return;
      const [w, hh] = input.split(",").map(v => Math.max(0.25, parseFloat(v.trim()) || 1));
      db.tokens.update(campaignId, currentMap.id, token.id, { w, h: hh ?? w });
    } });
    showContextMenu(x, y, items);
  }
  function setTokenSize(token, squares) {
    db.tokens.update(campaignId, currentMap.id, token.id, { w: squares, h: squares });
  }
  function toggleHidden(token) {
    db.tokens.update(campaignId, currentMap.id, token.id, { hidden: !token.hidden });
    toast(token.hidden ? `${token.name} is now visible to players` : `${token.name} is hidden from players`);
  }
  async function removeToken(token) {
    if (token.kind === "monster" && !confirm(`Remove ${token.name}? Monsters exist only on the map, so it will be gone.`)) return;
    if (openTokenId === token.id) closePopup();
    await db.tokens.remove(campaignId, currentMap.id, token.id);
    // Leave the initiative order too
    const id = token.kind === "monster" ? token.id : null;
    if (id && combat?.active && combat.combatants?.some(c => c.id === id)) {
      const cur = combat.combatants[combat.currentTurnIndex]?.id;
      const combatants = combat.combatants.filter(c => c.id !== id);
      db.combat.set(campaignId, { combatants, currentTurnIndex: Math.max(0, combatants.findIndex(c => c.id === cur)) });
    }
  }

  // ---------------- DM context menu on tokens ----------------
  function showTokenContextMenu(token, sx, sy) {
    const raw = tokens.find(t => t.id === token.id) || token;
    const items = [];
    if (raw.kind !== "component") {
      items.push({ label: "Creature panel…", action: () => showTokenPopup(raw) });
      if (raw.kind !== "monster") items.push({ label: "Open Character Sheet", action: () => navigate(`/character/${raw.refId}`) });
      items.push({ label: "Add to initiative", action: () => tools.addToInitiative([raw]) });
      items.push(raw.grappledBy
        ? { label: "Release grapple", action: () => tools.releaseGrapple(raw) }
        : { label: "Grapple…", action: () => tools.chooseGrappler(raw, sx, sy) });
      items.push("---");
    }
    items.push({ label: raw.hidden ? "\u{1F441} Show to players" : "\u{1F576} Hide from players", action: () => toggleHidden(raw) });
    items.push({ label: "Size…", action: () => setTimeout(() => sizeMenu(raw, sx, sy), 0) });
    if (raw.kind !== "component") {
      const others = allMaps.filter(m => m.id !== currentMap.id);
      if (others.length) items.push("---");
      others.forEach(m => {
        items.push({ label: `Move to: ${m.name}`, action: async () => {
          await db.tokens.moveToMap(campaignId, currentMap.id, m.id, { ...raw, grappledBy: null, grappleOffset: null });
          if (raw.kind === "pc") await db.characters.update(raw.refId, { currentMapId: m.id });
          toast(`Moved ${raw.name} to ${m.name}`);
        }});
      });
    }
    items.push("---");
    items.push({ label: "Remove from Map", danger: true, action: () => removeToken(raw) });
    showContextMenu(sx, sy, items);
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
      le