import { db } from "../../db.js";
import { h, toast, escapeHtml, showContextMenu } from "../../util.js";
import { VttCanvas } from "../../vtt/vtt-canvas.js";
import { mountCharacterSheet } from "../../character-sheet.js";
import { COVER_AC_BONUS, COVER_LABELS, estimateArmorClass, CREATURE_SIZES, sizeToGridSquares, tokenDistanceFt, INTERACT_RANGE_FT } from "../../rules-engine.js";
import { openMerchantShop, openLootWindow } from "./merchant-shop.js";
import { navigate } from "../../router.js";
import { loadRuleset } from "../../data-loader.js";
import { mountRoomInventoryPanel } from "./room-inventory-panel.js";

// Module-level (not per-mount) so a background image, once decoded, stays
// cached for the rest of the browser session — switching maps back and forth
// no longer re-decodes/reloads it. Keyed by the base64 string itself, so a
// re-uploaded background for the same map naturally invalidates the old entry.
const bgImageCache = new Map();

export async function mountVttPanel(container, { campaignId, user, isDm, getAdvMode, onRoll }) {
  const ruleset = await loadRuleset();
  const shell = h("div", { class: "vtt-shell" });
  const sidebar = h("div", { class: "vtt-sidebar" });
  const stage = h("div", { class: "vtt-stage" });
  shell.appendChild(sidebar);
  shell.appendChild(stage);
  container.appendChild(shell);

  const toolbar = h("div", { class: "vtt-toolbar" });
  const canvasHost = h("div", { class: "vtt-canvas-host" });
  const popup = h("div", { class: "vtt-token-popup", style: "display:none;" });
  const roomInvPanel = h("div", { class: "vtt-token-popup vtt-room-inv", style: "display:none;" });
  stage.appendChild(toolbar);
  stage.appendChild(canvasHost);
  stage.appendChild(popup);
  stage.appendChild(roomInvPanel);

  let myCharacter = null;
  let allMaps = [];
  let currentMap = null;
  let tokens = [];
  let sidebarOpen = true;
  let roomInvOpen = false;
  let roomInvUnsub = null;
  let unsubTokens = null, unsubMap = null;
  let combat = null;
  let catalog = [];
  let partyList = [];
  const unsubCombat = db.combat.subscribe(campaignId, (c) => { combat = c; });
  const unsubCatalog = db.campaignItems.subscribe(campaignId, (c) => { catalog = c; });
  const unsubPartyList = db.characters.subscribeCampaignParty(campaignId, (p) => { partyList = p; });

  // A player's own token moves freely; loot can be nudged, but only while the
  // character is close enough to reach it.
  function myToken() { return tokens.find(t => t.kind === "pc" && t.refId === myCharacter?.id); }
  function withinReach(token) {
    const mine = myToken();
    if (!mine) return false;
    return tokenDistanceFt(mine, token) <= INTERACT_RANGE_FT + 0.01;
  }

  function refreshRoomInventoryPanel() {
    roomInvUnsub?.();
    roomInvUnsub = null;
    if (!roomInvOpen || !currentMap) return;
    roomInvUnsub = mountRoomInventoryPanel(roomInvPanel, { campaignId, mapId: currentMap.id, ruleset, myCharacter, isDm });
  }

  const canvas = new VttCanvas(canvasHost, {
    canMoveToken: (token) => {
      if (isDm) return true;
      if (token.kind === "pc" && token.refId === myCharacter?.id) return true;
      if (token.kind === "loot") return withinReach(token);
      return false;
    },
    onTokenMoved: (token, x, y) => handleTokenMoved(token, x, y),
    onTokenClicked: (token) => showTokenPopup(token),
    onTokenContextMenu: (token, sx, sy) => isDm && showTokenContextMenu(token, sx, sy),
    onFogStrokeEnd: (revealedCells) => { if (currentMap) db.maps.update(campaignId, currentMap.id, { revealedCells }); },
    onShapePlaced: (shape) => { if (currentMap) db.maps.addShape(campaignId, currentMap.id, shape); }
  });
  canvas.setFogViewerIsDm(isDm);

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
    const fsBtn = h("button", { class: "btn sm" }, shell.classList.contains("fullscreen") ? "Exit Full Screen" : "Full Screen");
    fsBtn.addEventListener("click", () => {
      shell.classList.toggle("fullscreen");
      buildToolbar();
      // Canvas sizes off its container, so let layout settle before refitting.
      requestAnimationFrame(() => canvas._fitToView());
    });
    toolbar.appendChild(zoomOut); toolbar.appendChild(zoomIn); toolbar.appendChild(fitBtn); toolbar.appendChild(fsBtn);

    if (isDm) {
      const fogBtn = h("button", { class: `btn sm ${canvas.tool === "fog" ? "primary" : ""}` }, "Fog");
      fogBtn.title = "Left-click paints fog, right-click clears it";
      fogBtn.addEventListener("click", () => { canvas.setTool("fog"); buildToolbar(); });
      toolbar.appendChild(fogBtn);

      const mapSel = h("select", { style: "max-width:200px; margin:0;" });
      allMaps.forEach(m => mapSel.appendChild(h("option", { value: m.id, selected: currentMap?.id === m.id ? "selected" : null }, m.name)));
      mapSel.addEventListener("change", () => loadMap(mapSel.value));
      toolbar.appendChild(mapSel);

      const clearAoeBtn = h("button", { class: "btn sm ghost" }, "Clear AoE");
      clearAoeBtn.addEventListener("click", () => { if (currentMap) db.maps.clearShapes(campaignId, currentMap.id); });
      toolbar.appendChild(clearAoeBtn);
    }

    // In-world clock: DM sets it, everyone reads it.
    const clockMins = currentMap?.clockMinutes ?? 8 * 60;
    const hh = String(Math.floor((clockMins % 1440) / 60)).padStart(2, "0");
    const mm = String(clockMins % 60).padStart(2, "0");
    const clockWrap = h("div", { class: "vtt-clock" });
    clockWrap.appendChild(h("span", { class: "clock-face" }, `\u{1F551} ${hh}:${mm}`));
    if (isDm) {
      const nudge = (delta) => {
        const next = (((clockMins + delta) % 1440) + 1440) % 1440;
        db.maps.update(campaignId, currentMap.id, { clockMinutes: next });
      };
      [["-1h", -60], ["-10m", -10], ["+10m", 10], ["+1h", 60]].forEach(([lbl, d]) => {
        const b = h("button", { class: "icon-btn", style: "width:auto; padding:0 6px; font-size:0.66rem;" }, lbl);
        b.addEventListener("click", () => nudge(d));
        clockWrap.appendChild(b);
      });
      const setBtn = h("button", { class: "icon-btn", style: "width:auto; padding:0 6px; font-size:0.66rem;" }, "Set");
      setBtn.addEventListener("click", () => {
        const v = prompt("Set time (HH:MM, 24h):", `${hh}:${mm}`);
        if (!v) return;
        const m = v.match(/^(\d{1,2}):(\d{2})$/);
        if (!m) { toast("Use HH:MM", "error"); return; }
        const mins = (parseInt(m[1], 10) % 24) * 60 + (parseInt(m[2], 10) % 60);
        db.maps.update(campaignId, currentMap.id, { clockMinutes: mins });
      });
      clockWrap.appendChild(setBtn);
    }
    if (currentMap) toolbar.appendChild(clockWrap);

    const roomInvBtn = h("button", { class: `btn sm ${roomInvOpen ? "primary" : ""}` }, "Room Loot");
    roomInvBtn.addEventListener("click", () => {
      roomInvOpen = !roomInvOpen;
      roomInvPanel.style.display = roomInvOpen ? "block" : "none";
      refreshRoomInventoryPanel();
      buildToolbar();
    });
    toolbar.appendChild(roomInvBtn);
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

  const fabWorld = h("button", { class: "vtt-fab vtt-fab-tertiary" }, "\u2726");
  fabWorld.title = "Add a merchant or drop loot";
  if (isDm) stage.appendChild(fabWorld);
  fabWorld.addEventListener("click", () => {
    const items = [
      { header: "Merchant" },
      { label: "New merchant stall", action: async () => {
        const name = prompt("Merchant name:", "Merchant");
        if (!name) return;
        await addToken({ kind: "merchant", refId: null, name, imageBase64: null, x: 2, y: 2, w: 1, h: 1, shopItems: [] });
      }},
      "---",
      { header: "Drop loot (from Item Workshop)" }
    ];
    if (catalog.length === 0) items.push({ label: "No campaign items yet", action: () => {} });
    catalog.forEach(def => items.push({
      label: def.name,
      action: async () => {
        // The orb is the marker; the actual item lives in this map's room
        // inventory, so the existing loot/take plumbing handles the transfer.
        const { campaignItemToInventoryItem } = await import("./item-workshop-panel.js");
        await db.roomInventory.add(campaignId, currentMap.id, campaignItemToInventoryItem(def));
        await addToken({ kind: "loot", refId: def.id, name: def.name, imageBase64: def.imageBase64 || null, x: 3, y: 3, w: 1, h: 1 });
      }
    }));
    const rect = fabWorld.getBoundingClientRect();
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
    // Without this a player's own VTT never learns which map they're on.
    if (token.kind === "pc") await db.characters.update(token.refId, { currentMapId: currentMap.id });
  }

  // ---------------- Cover auto-apply ----------------
  async function handleTokenMoved(token, x, y) {
    if (!isDm && token.kind === "loot") {
      const mine = myToken();
      const landed = { ...token, x, y };
      if (!mine || tokenDistanceFt(mine, landed) > INTERACT_RANGE_FT + 0.01) {
        toast(`You can only shift loot within ${INTERACT_RANGE_FT} ft of yourself`, "error");
        canvas.setTokens(tokens); // snap the visual back to the stored position
        return;
      }
    }
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
    if (token.kind === "merchant") {
      openMerchantShop({ campaignId, mapId: currentMap.id, token, isDm, buyerCharacter: myCharacter, catalog });
      return;
    }
    if (token.kind === "loot" || token.kind === "body") {
      openLootWindow({
        campaignId, mapId: currentMap.id, token, isDm,
        looterCharacter: myCharacter, party: partyList,
        canReach: isDm || withinReach(token)
      });
      return;
    }
    popup.style.display = "block";
    popup.innerHTML = `<div class="spinner" style="margin:20px auto;"></div>`;
    if (token.kind === "component") {
      popup.innerHTML = `<h4>${escapeHtml(token.name)}</h4>${token.isCover ? `<p>${COVER_LABELS[token.coverType] || "Cover"}</p>` : "<p>Scenery</p>"}<button class="btn sm" id="popup-close">Close</button>`;
    } else {
      const character = await db.characters.get(token.refId);
      if (!character) { popup.style.display = "none"; return; }
      const ac = estimateArmorClass(character, null, false) + (character.acAdjustments || []).reduce((s, a) => s + a.value, 0);
      const rv = { name: false, image: true, ac: false, hp: false, ...(token.reveal || {}) };
      const mine = character.ownerUid === user.uid;
      const seeAll = isDm || mine;
      const displayName = seeAll || rv.name ? character.name : "Unknown";
      const hpLine = seeAll || rv.hp ? `HP ${character.hp?.current ?? "?"} / ${character.hp?.max ?? "?"}` : "HP hidden";
      const acLine = seeAll || rv.ac ? `AC ${ac}` : "AC hidden";
      popup.innerHTML = `
        <h4>${escapeHtml(displayName)} ${token.kind === "npc" ? '<span class="badge rune">NPC</span>' : ""}</h4>
        <p>${hpLine} \u2022 ${acLine}</p>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          ${seeAll ? '<button class="btn sm primary" id="popup-open">Open Sheet</button>' : ""}
          <button class="btn sm ghost" id="popup-close">Close</button>
        </div>
      `;
      popup.querySelector("#popup-open")?.addEventListener("click", () => navigate(`/character/${character.id}`));
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
    // Creature size presets straight from the PHB size table.
    items.push({ header: "Size" });
    CREATURE_SIZES.forEach(s => {
      const sq = s.gridSquares;
      const active = (token.w || 1) === sq;
      items.push({
        label: `${active ? "\u2713 " : ""}${s.name} (${s.space})`,
        action: () => db.tokens.update(campaignId, currentMap.id, token.id, { w: sq, h: sq, sizeId: s.id })
      });
    });
    items.push("---");
    items.push({ label: "Border colour\u2026", action: () => {
      const c = prompt("Border colour (any CSS colour, blank to reset):", token.borderColor || "");
      if (c === null) return;
      db.tokens.update(campaignId, currentMap.id, token.id, { borderColor: c.trim() || null });
    }});

    if (token.kind === "pc" || token.kind === "npc") {
      const rv = { name: false, image: true, ac: false, hp: false, ...(token.reveal || {}) };
      items.push("---");
      items.push({ header: "Reveal to players" });
      [["image", "Image"], ["name", "Name"], ["ac", "Armour Class"], ["hp", "Hit Points"]].forEach(([key, label]) => {
        items.push({
          label: `${rv[key] ? "\u2713 " : "\u2717 "}${label}`,
          action: () => db.tokens.update(campaignId, currentMap.id, token.id, { reveal: { ...rv, [key]: !rv[key] } })
        });
      });
      items.push("---");
      items.push({
        label: "Mark as dead (lootable body)",
        action: () => db.tokens.update(campaignId, currentMap.id, token.id, { kind: "body", priorKind: token.kind })
      });
    }
    if (token.kind === "body") {
      items.push({
        label: "Revive \u2014 restore token",
        action: () => db.tokens.update(campaignId, currentMap.id, token.id, { kind: token.priorKind || "npc" })
      });
    }
    if (token.kind === "loot") {
      items.push("---");
      items.push({ label: "Open loot", action: () => showTokenPopup(token) });
    }

    items.push("---");
    items.push({ label: "Remove from Map", danger: true, action: () => db.tokens.remove(campaignId, currentMap.id, token.id) });
    showContextMenu(sx, sy, items);
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
    canvas.setRevealedCells(currentMap.revealedCells || []);
    canvas.setAoeShapes(currentMap.aoeShapes || []);
    unsubTokens = db.tokens.subscribe(campaignId, mapId, (t) => { tokens = t; canvas.setTokens(tokens); });
    refreshRoomInventoryPanel();
    buildToolbar();
    buildSidebar();
  }

  // ---------------- Boot ----------------
  const unsubMaps = db.maps.subscribeList(campaignId, async (list) => {
    allMaps = list;
    // Live-sync fog/AoE for whoever is viewing this map, without re-decoding
    // the background image (which would flicker).
    if (currentMap) {
      const updated = list.find(m => m.id === currentMap.id);
      if (updated) {
        currentMap = updated;
        canvas.setRevealedCells(updated.revealedCells || []);
        canvas.setAoeShapes(updated.aoeShapes || []);
      }
    }
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
      refreshRoomInventoryPanel();
      if (myCharacter?.currentMapId) loadMap(myCharacter.currentMapId);
      else if (myCharacter) {
        canvasHost.innerHTML = "";
        canvasHost.appendChild(h("div", { class: "empty-state" }, "<h3>Not on a map yet</h3><p>Ask your DM to place you.</p>"));
      }
    });
    buildToolbar();
    return () => { unsubMaps(); unsubParty(); unsubCombat(); unsubCatalog(); unsubPartyList(); unsubTokens?.(); unsubMap?.(); sheetUnsub?.(); roomInvUnsub?.(); canvas.dispose(); };
  }

  buildToolbar();
  buildSidebar();
  return () => { unsubMaps(); unsubCombat(); unsubCatalog(); unsubPartyList(); unsubTokens?.(); unsubMap?.(); roomInvUnsub?.(); canvas.dispose(); };
}
