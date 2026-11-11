import { db } from "../../db.js";
import { h, toast, escapeHtml, showContextMenu } from "../../util.js";
import { VttCanvas, loadImageCached } from "../../vtt/vtt-canvas.js";
import { mountCharacterSheet } from "../../character-sheet.js";
import { COVER_AC_BONUS, COVER_LABELS } from "../../rules-engine.js";
import { navigate } from "../../router.js";
import { loadRuleset } from "../../data-loader.js";
import { pickMonster, tokenSquaresForSize, monsterImageFor, monsterDefaultArt, once } from "../../monsters.js";
import { createCreatureTools } from "../../vtt/creature-panel.js";
import { SIZES, CONDITION_ABBR, SPEED_ZERO, isImmobile, effectDef, hasEffect, monsterTokenStats } from "../../vtt/creatures.js";
import { nextTurnPatch } from "./combat-panel.js";
import { createMapLayoutSession, renderMapForm } from "../../vtt/map-editor.js";
import { openDialog, confirmDialog } from "../../dialogs.js";

// Decoded map backgrounds and token images live in vtt-canvas.js's shared
// session cache (loadImageCached), so switching maps never re-decodes them.
//
// Token kinds: "pc" / "npc" point at a character doc (refId); "monster" tokens
// carry their own state (`stats`, `loot`) and exist only on the map — removing
// one removes the monster. Any token can be `hidden` (DM-only). A grappled
// creature has `grappledBy` (grappler token id) + `grappleOffset` and moves with it.

const CONDITION_COLORS = { Grappled: "#b8742a", Prone: "#5a5f80", Invisible: "#3f6fb8" };
const EFFECT_COLORS = { buff: "#2f8f6f", debuff: "#7f4fb8", hazard: "#c2571a", neutral: "#50536e" };

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
  let tokensLoaded = false;
  let mapEdit = null; // { session, panel, form } while the map editor is open
  let sidebarOpen = true;
  let unsubTokens = null, unsubMap = null;
  let combat = null;
  const charById = new Map();
  let party = [], npcs = [];

  // Tokens saved before bundled art existed have no image: show the default for their monster
  function artOf(t) {
    if (t.imageBase64) return t.imageBase64;
    const monsterId = t.kind === "monster" ? t.monsterId : t.kind === "npc" ? charById.get(t.refId)?.monsterId : null;
    return monsterDefaultArt(monstersById.get(monsterId));
  }

  const tools = createCreatureTools({
    campaignId, user, isDm,
    mapId: () => currentMap?.id,
    tokens: () => tokens,
    charOf: (t) => charById.get(t.refId),
    monsterOf: (t) => monstersById.get(t.monsterId),
    ruleset: () => ruleset,
    combat: () => combat,
    artOf,
    ready: () => tokensLoaded
  });

  const canvas = new VttCanvas(canvasHost, {
    canMoveToken: (token) => canMove(token),
    canMoveShape: (shape) => isDm || shape.ownerUid === user.uid,
    onTokenMoved: (token, x, y, followers) => handleTokenMoved(token, x, y, followers),
    onTokenClicked: (token) => showTokenPopup(token),
    onTokenBlocked: (token) => explainBlocked(token),
    onGrappledMoved: (token, dx, dy) => tools.moveGrappled(token, dx, dy),
    moveBlockedWhy: (token, x, y) => tools.moveBlockedWhy(token, x, y),
    onMoveRefused: (why) => toast(why, "error"),
    onTokenContextMenu: (token, sx, sy, here) => isDm && showTokenContextMenu(token, sx, sy, here),
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
    const conds = st.conditions.filter(c => CONDITION_ABBR[c]).map(c => ({ label: CONDITION_ABBR[c], color: CONDITION_COLORS[c] || "#9a3838" }));
    if (st.exhaustion) conds.push({ label: "Ex", color: "#8a6d1f" });
    st.effects.forEach(e => { const def = effectDef(e); if (def) conds.push({ label: def.abbr, color: EFFECT_COLORS[def.tone] }); });
    const g = t.grappledBy ? tokens.find(o => o.id === t.grappledBy) : null;
    const follow = g && st.conditions.includes("Grappled") ? { id: g.id, ...tools.followOffset(t, g) } : null;
    const { w, h: tall } = tools.footprint(t);
    const cur = combat?.active ? combat.combatants?.[combat.currentTurnIndex] : null;
    const showHp = isDm || t.kind === "pc";
    return { ...t, w, h: tall, imageBase64: artOf(t), _st: {
      conds, follow, dead: st.dead, invisible: st.conditions.includes("Invisible") && !hasEffect(st.effects, "faerie-fire"),
      outline: hasEffect(st.effects, "faerie-fire"),
      hpFrac: showHp && st.hp.max ? st.hp.current / st.hp.max : null,
      turn: !!cur && cur.id === (t.kind === "monster" ? t.id : t.refId)
    } };
  }
  // While the map editor is open its unsaved grid and size show at once
  function withLayoutPreview(t) {
    const p = mapEdit?.session.previewToken(t);
    return p ? { ...t, ...p } : t;
  }
  let refreshQueued = false;
  function refreshTokens() {
    if (refreshQueued) return;
    refreshQueued = true;
    // A timer, not an animation frame: those pause in background tabs, and the DM's
    // client has to keep grapples and turn effects running while it isn't in front.
    setTimeout(() => {
      refreshQueued = false;
      canvas.setTokens(tokens.filter(t => isDm || !t.hidden).map(decorate).map(withLayoutPreview));
      renderPopup();
      renderTurnBar();
      tools.reconcile();
      tools.processTurn();
    }, 16);
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
    const st = tools.stateOf(token);
    // Grappled: it can't move itself, but its grappler can swing it around
    if (token._st?.follow) {
      const g = tokens.find(t => t.id === token._st.follow.id);
      return !!g && tools.canMoveHeld(g);
    }
    if (!(isDm || (token.kind === "pc" && token.refId === myCharacter?.id))) return false;
    if (!isDm && st && (st.dead || isImmobile(st.conditions, st.effects))) return false;
    return true;
  }

  function explainBlocked(token) {
    const st = tools.stateOf(token);
    if (token._st?.follow) {
      const g = tokens.find(t => t.id === token._st.follow.id);
      toast(`${st?.name || token.name} is Grappled by ${g?.name || "another creature"} \u2014 it moves when they move, and only they can drag it around.`, "error");
    } else if (st && isImmobile(st.conditions, st.effects)) {
      const why = st.conditions.find(c => SPEED_ZERO.includes(c)) || st.effects.map(effectDef).find(d => d?.speedZero)?.name;
      toast(`${st.name} can't move \u2014 Speed 0 (${why})`, "error");
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
  // Snap to grid is on unless this person turned it off (hold Alt to place freely either way)
  try { canvas.setSnap(localStorage.getItem("gt_vtt_snap") !== "0"); } catch { /* noop */ }
  const snapBtn = toolButton({ icon: "#", label: "Snap", title: "Snap tokens and shapes to the grid (N). Hold Alt while dragging to place freely." }, () => setSnap(!canvas.snap));
  function setSnap(on) {
    canvas.setSnap(on);
    try { localStorage.setItem("gt_vtt_snap", on ? "1" : "0"); } catch { /* noop */ }
    syncToolbar();
    toast(on ? "Snap to grid on" : "Snap to grid off \u2014 tokens can sit between squares");
  }
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
    mapEditBtn.classList.toggle("active", !!mapEdit);
    snapBtn.classList.toggle("active", canvas.snap);
    fsBtn.classList.toggle("active", vttFullscreen);
    fsBtn.querySelector(".lbl").textContent = vttFullscreen ? "Exit" : "Full";
  }

  const mapEditBtn = toolButton({ icon: "\u270E", label: "Edit Map", title: "Name, picture, size and a live grid for this map" }, () => toggleMapEditor());
  const fsBtn = toolButton({ icon: "⛶", label: "Full", title: "Fullscreen (F) — Esc to leave" }, () => toggleVttFullscreen());

  // Whose turn it is, with End Turn, so combat can be run from the map (and in fullscreen)
  const turnBar = h("div", { class: "vtt-turn-bar", style: "display:none;" });
  function renderTurnBar() {
    const cur = combat?.active ? combat.combatants?.[combat.currentTurnIndex] : null;
    turnBar.style.display = cur ? "inline-flex" : "none";
    if (!cur) return;
    turnBar.innerHTML = "";
    turnBar.appendChild(h("span", { class: "vtt-turn-text", title: "Current turn" }, `Round ${combat.round}: <b>${escapeHtml(cur.name)}</b>`));
    if (isDm || cur.ownerUid === user.uid) {
      const end = h("button", { class: "vtt-tool", type: "button", title: "End this turn" }, '<span class="lbl">End Turn</span>');
      end.addEventListener("click", () => db.combat.set(campaignId, nextTurnPatch(combat)));
      turnBar.appendChild(end);
    }
  }

  function buildToolbar() {
    toolbar.innerHTML = "";
    toolButtons.clear();
    const sideBtn = toolButton({ icon: "☰", label: "", title: "Toggle sidebar" }, () => { sidebarOpen = !sidebarOpen; sidebar.style.display = sidebarOpen ? "flex" : "none"; requestAnimationFrame(() => canvas._resize()); }, "icon-only");
    toolbar.appendChild(sideBtn);

    const group = (items) => { const g = h("div", { class: "vtt-tool-group" }); items.forEach(i => g.appendChild(i)); toolbar.appendChild(g); return g; };
    const toolsGroup = group(TOOLS.map(t => { const b = toolButton(t, () => setTool(t.id)); toolButtons.set(t.id, b); return b; }));
    toolsGroup.appendChild(snapBtn);
    if (isDm) {
      const fogGroup = group(FOG_TOOLS.map(t => { const b = toolButton(t, () => setTool(t.id)); toolButtons.set(t.id, b); return b; }));
      fogGroup.appendChild(fogSliderWrap);
      fogGroup.appendChild(toolButton({ icon: "✕", label: "Clear", title: "Remove all fog from this map" }, async () => {
        if (!currentMap) return;
        if (!await confirmDialog("Players will see the whole map.", { title: "Clear all fog on this map?", okLabel: "Clear fog", danger: true })) return;
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
      group([mapEditBtn]);
      const mapSel = h("select", { class: "vtt-map-select", title: "Switch map" });
      allMaps.forEach(m => mapSel.appendChild(h("option", { value: m.id, selected: currentMap?.id === m.id ? "selected" : null }, m.name)));
      mapSel.addEventListener("change", () => loadMap(mapSel.value));
      toolbar.appendChild(mapSel);
    }
    toolbar.appendChild(turnBar);
    renderTurnBar();
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
    const img = await monsterImageFor(campaignId, monster);
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
    await db.tokens.update(campaignId, mapId, token.id, token.z ? { x, y, z: token.z } : { x, y });
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
    items.push({ label: "Custom…", action: async () => {
      const r = await openDialog({ title: `Size of ${token.name}`, message: "In 5 ft squares.", okLabel: "Resize", fields: [
        { name: "w", label: "Width", type: "number", value: token.w || 1, min: 0.25, step: 0.25 },
        { name: "h", label: "Height", type: "number", value: token.h || 1, min: 0.25, step: 0.25 }
      ] });
      if (!r) return;
      const w = Math.max(0.25, parseFloat(r.w) || 1), hh = Math.max(0.25, parseFloat(r.h) || w);
      db.tokens.update(campaignId, currentMap.id, token.id, { w, h: hh });
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
  async function removeToken(token) { return removeTokens([token]); }

  // Removes tokens, asking first when monsters are among them (they exist only on the map)
  async function removeTokens(list) {
    if (!list.length || !currentMap) return;
    const monsters = list.filter(t => t.kind === "monster");
    if (monsters.length) {
      const what = list.length === 1 ? list[0].name : `${list.length} tokens`;
      const ok = await confirmDialog(`Monsters exist only on the map, so ${monsters.length === 1 ? `${monsters[0].name} will be gone` : `${monsters.length} monsters will be gone`}.`, { title: `Remove ${what}?`, okLabel: "Remove", danger: true });
      if (!ok) return;
    }
    const mapId = currentMap.id;
    const ids = new Set(list.map(t => t.id));
    if (ids.has(openTokenId)) closePopup();
    canvas.setSelection([...canvas.selectedIds].filter(id => !ids.has(id)));
    await Promise.all(list.map(t => db.tokens.remove(campaignId, mapId, t.id)));
    // Monsters leave the initiative order too
    if (combat?.active && combat.combatants?.some(c => ids.has(c.id))) {
      const cur = combat.combatants[combat.currentTurnIndex]?.id;
      const combatants = combat.combatants.filter(c => !ids.has(c.id));
      db.combat.set(campaignId, combatants.length ? { combatants, currentTurnIndex: Math.max(0, combatants.findIndex(c => c.id === cur)) } : { active: false, combatants: [] });
    }
    if (list.length > 1) toast(`Removed ${list.length} tokens`);
  }

  // Stacking: front/back put a token above or below everything else of its kind
  function restack(list, layer) {
    const z = Date.now();
    list.forEach(t => db.tokens.update(campaignId, currentMap.id, t.id, { layer, z }));
  }

  // ---------------- DM context menu on tokens ----------------
  function showTokenContextMenu(token, sx, sy, here = []) {
    const raw = tokens.find(t => t.id === token.id) || token;
    // Right-clicking one of several selected tokens acts on all of them
    const selection = canvas.selectedTokens.map(t => tokens.find(x => x.id === t.id)).filter(Boolean);
    if (selection.length > 1 && selection.some(t => t.id === raw.id)) { showGroupMenu(selection, sx, sy); return; }
    const items = [];
    if (here.length > 1) {
      items.push({ header: "Tokens here (top first)" });
      here.forEach(t => items.push({ label: `${t.id === raw.id ? "\u25b8 " : ""}${t.name}`, action: () => { canvas.setSelection([t.id]); if (t.kind === "component") return; showTokenPopup(tokens.find(x => x.id === t.id) || t); } }));
      items.push("---");
    }
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
    items.push({ label: "Bring to front", action: () => restack([raw], 1) });
    items.push({ label: "Send to back", action: () => restack([raw], -1) });
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

  // ---------------- Map editor ----------------
  function toggleMapEditor() {
    if (mapEdit) { closeMapEditor(); return; }
    if (!currentMap) { toast("Create a map first", "error"); return; }
    const panel = h("div", { class: "vtt-map-panel" });
    canvasHost.appendChild(panel);
    const session = createMapLayoutSession({
      campaignId, map: currentMap, tokens: () => tokens, shapes: () => docShapes,
      onChange: (l) => { canvas.setMapSize(l.widthPx, l.heightPx); canvas.setGridPx(l.gridPx); refreshTokens(); refreshShapes(); }
    });
    mapEdit = { session, panel, form: renderMapForm(panel, { campaignId, map: currentMap, session, onDone: closeMapEditor }) };
    syncToolbar();
  }
  function closeMapEditor() {
    if (!mapEdit) return;
    const { session, panel, form } = mapEdit;
    form.saveName();
    session.flush();
    panel.remove();
    mapEdit = null;
    syncToolbar();
    refreshTokens(); refreshShapes();
  }

  function showGroupMenu(list, sx, sy) {
    const creatures = list.filter(t => t.kind !== "component");
    const allHidden = list.every(t => t.hidden);
    const items = [{ header: `${list.length} selected` }];
    if (creatures.length) items.push({ label: "Add to initiative", action: () => tools.addToInitiative(creatures) });
    items.push({ label: allHidden ? "\u{1F441} Show to players" : "\u{1F576} Hide from players", action: () => {
      list.forEach(t => db.tokens.update(campaignId, currentMap.id, t.id, { hidden: !allHidden }));
      toast(allHidden ? `${list.length} tokens shown to players` : `${list.length} tokens hidden from players`);
    } });
    items.push({ label: "Bring to front", action: () => restack(list, 1) });
    items.push({ label: "Send to back", action: () => restack(list, -1) });
    items.push("---");
    items.push({ label: `Remove ${list.length} from Map`, danger: true, action: () => removeTokens(list) });
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
    canvas.setPersistentShapes(mapEdit ? currentShapes.map(sh => ids.has(sh.id) ? { ...sh, ...mapEdit.session.previewShape(sh) } : sh) : currentShapes);
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
  // The shell is pinned over the page with CSS (so page-level menus, dialogs,
  // toasts and dice still stack above it); the browser's own fullscreen is asked
  // for on the whole document, never on the shell, for the same reason.
  function toggleVttFullscreen(force) {
    const next = typeof force === "boolean" ? force : !vttFullscreen;
    if (next === vttFullscreen) return;
    vttFullscreen = next;
    shell.classList.toggle("vtt-shell--fullscreen", vttFullscreen);
    document.body.classList.toggle("vtt-fullscreen-open", vttFullscreen);
    try {
      if (vttFullscreen && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
      else if (!vttFullscreen && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    } catch { /* not allowed here — the CSS fullscreen still works */ }
    syncToolbar();
    requestAnimationFrame(() => { canvas._resize(); });
  }
  const onFullscreenChange = () => { if (!document.fullscreenElement && vttFullscreen) toggleVttFullscreen(false); };
  document.addEventListener("fullscreenchange", onFullscreenChange);

  const onKey = (e) => {
    if (!shell.isConnected) return;
    const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
    const modalOpen = document.querySelector(".modal-overlay, .ctx-menu");
    if (e.key === "Escape") {
      if (modalOpen) return; // the dialog/menu closes itself first
      if (openTokenId) { closePopup(); return; }
      if (mapEdit) { closeMapEditor(); return; }
      if (canvas.selectedIds.size || canvas.selectedShape) { canvas.setSelection([]); canvas.selectedShape = null; canvas._markDirty(); return; }
      if (vttFullscreen) toggleVttFullscreen(false);
      return;
    }
    if (typing || modalOpen || e.ctrlKey || e.metaKey || e.altKey) return;
    // Delete the selected shape, or (DM) the selected tokens
    if (e.key === "Delete" || e.key === "Backspace") {
      const shape = canvas.selectedShape;
      if (shape && (isDm || shape.ownerUid === user.uid)) {
        canvas.removePersistentShape(shape);
        canvas.selectedShape = null;
      } else if (isDm && canvas.selectedIds.size) {
        removeTokens(canvas.selectedTokens.map(t => tokens.find(x => x.id === t.id)).filter(Boolean));
      }
      e.preventDefault();
      return;
    }
    // Rotate the selected square or cone: [ and ] by 15°, with Shift by 45°
    if (e.key === "[" || e.key === "]" || e.key === "{" || e.key === "}") {
      const step = (e.shiftKey ? 45 : 15) * Math.PI / 180;
      if (canvas.rotateSelectedShape(e.key === "[" || e.key === "{" ? -step : step)) e.preventDefault();
      return;
    }
    const k = e.key.toLowerCase();
    const tool = [...TOOLS, ...(isDm ? FOG_TOOLS : [])].find(t => t.key === k);
    if (tool) { setTool(tool.id); e.preventDefault(); return; }
    if (k === "f") { toggleVttFullscreen(); e.preventDefault(); }
    else if (k === "n") { setSnap(!canvas.snap); e.preventDefault(); }
    else if (k === "+" || k === "=") canvas.zoomBy(1.15);
    else if (k === "-") canvas.zoomBy(0.85);
    else if (k === "0") { canvas._fitToView(); canvas._hasSavedView = true; }
  };
  document.addEventListener("keydown", onKey);

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
      sidebar.appendChild(h("div", { class: "vtt-help" }, `
        <h4>Quick help</h4>
        <p><b>Click</b> a creature: HP, conditions, defenses, rolls, loot.</p>
        <p><b>Right-click</b> a token: hide, size, grapple, initiative.</p>
        <p><b>Select</b>: drag on empty map for a box, Shift+click to add; drag any selected token to move them all. Click a stack again for the token below.</p>
        <p><b>Keys</b>: V select, R ruler, S/C/T AoE, G fog, E reveal, N snap, [ ] rotate AoE, Del remove, F fullscreen, 0 fit.</p>`));
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
    // The open editor owns grid and size: a snapshot of an earlier save mustn't pull them back
    if (!mapEdit) {
      canvas.setMapSize(map.widthPx, map.heightPx);
      canvas.setGridPx(map.gridPx);
    }
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
    closeMapEditor();
    unsubTokens?.(); unsubMap?.(); unsubFogs?.(); unsubFogMask?.(); unsubShapes?.();
    const map = allMaps.find(m => m.id === mapId) || (currentMap?.id === mapId ? currentMap : null);
    loadedMapId = mapId;
    closePopup();
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
    tokensLoaded = false;
    unsubTokens = db.tokens.subscribe(campaignId, mapId, (t) => { tokens = t; tokensLoaded = true; refreshTokens(); });
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
  let mapNames = "";
  const unsubMaps = db.maps.subscribeList(campaignId, async (list) => {
    allMaps = list;
    if (isDm) {
      const names = list.map(m => `${m.id}:${m.name}`).join("|");
      if (names !== mapNames) { mapNames = names; if (loadedMapId) buildSidebar(); }
      if (!loadedMapId && list.length) loadMap(list[0].id);
      else if (loadedMapId && !list.some(m => m.id === loadedMapId)) { loadedMapId = null; currentMap = null; if (list.length) loadMap(list[0].id); }
      else buildToolbar();
      if (!list.length) showStageMessage("<h3>No maps yet</h3><p>Create one in Map Workshop.</p>");
    } else if (!list.length) {
      showStageMessage("<h3>No maps yet</h3><p>Your DM hasn't built one yet.</p>");
    }
  });

  // Party snapshots fire on any party member's change (HP, inventory, notes...).
  // For players, only a change of *their own* map reloads the VTT.
  let lastCharId = null;
  const unsubParty = db.characters.subscribeCampaignParty(campaignId, (list) => {
    party = list;
    indexCharacters();
    if (isDm) return;
    myCharacter = party.find(c => c.ownerUid === user.uid) || null;
    if (myCharacter?.id !== lastCharId) { lastCharId = myCharacter?.id || null; buildSidebar(); }
    if (myCharacter?.currentMapId) {
      if (myCharacter.currentMapId !== loadedMapId) loadMap(myCharacter.currentMapId);
    } else {
      if (loadedMapId) {
        unsubTokens?.(); unsubFogs?.(); unsubFogMask?.(); unsubShapes?.();
        loadedMapId = null; currentMap = null; tokens = [];
        canvas.setTokens([]); canvas.setPersistentShapes([]);
        closePopup();
      }
      showStageMessage(myCharacter ? "<h3>Not on a map yet</h3><p>Ask your DM to place you.</p>" : "<h3>No character here yet</h3><p>Join this campaign with a character first.</p>");
    }
  });

  buildToolbar();
  buildSidebar();
  return () => {
    closeMapEditor();
    unsubMaps(); unsubParty(); unsubNpcs(); unsubCombat(); unsubSync();
    unsubTokens?.(); unsubMap?.(); unsubFogs?.(); unsubFogMask?.(); unsubShapes?.(); sheetUnsub?.();
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    document.body.classList.remove("vtt-fullscreen-open");
    if (vttFullscreen && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    canvas.dispose();
  };
}
