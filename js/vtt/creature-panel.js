// Creature panel for the VTT: one place to run a creature in combat — HP
// (damage types respect resistances), conditions with their automatic effects,
// defenses, grapples, size, visibility, initiative, monster rolls and loot.
// Works for PC/NPC tokens (state lives on the character doc) and for monster
// tokens (state lives on the token's `stats`).
import { db } from "../db.js";
import { h, toast, escapeHtml, showContextMenu } from "../util.js";
import { ABILITIES, abilityModifier, formatModifier, estimateArmorClass } from "../rules-engine.js";
import { computeRoll, formatBreakdown } from "../dice/roll-logic.js";
import {
  SIZES, CONDITIONS, CONDITION_TEXT, DAMAGE_TYPES, SPEED_ZERO, impliedConditions, withCondition, isIncapacitated, hasSpeedZero,
  attackMode, saveRule, defenseNotes, adjustDamage, takeDamage, concentrationDc, footprintGap, distanceFt, snapAdjacent,
  monsterSaveBonus, attackDamageParts, rollFormula, generateLoot, rollHoard, rollMagicItem, rollIndividualCoins, sizeIdForSquares, innateResistances
} from "./creatures.js";

const CHAR_FIELDS = { resist: "damageResistances", immune: "damageImmunities", vulnerable: "damageVulnerabilities", condImmune: "conditionImmunities" };
const ui = { amount: "", dmgType: "", open: {}, privateRolls: false };
try { ui.privateRolls = sessionStorage.getItem("gt_vtt_private_rolls") === "1"; } catch { /* noop */ }

// ctx: { campaignId, user, isDm, mapId(), tokens(), charOf(token), monsterOf(token), ruleset(), combat(), anchorEl }
export function createCreatureTools(ctx) {
  const isCreature = (t) => t && (t.kind === "pc" || t.kind === "npc" || t.kind === "monster");

  function stateOf(token) {
    if (!isCreature(token)) return null;
    if (token.kind === "monster") {
      const s = token.stats || {};
      return {
        kind: "monster", name: token.name, hp: s.hp || { current: 0, max: 0, temp: 0 }, ac: s.ac ?? 10,
        conditions: s.conditions || [], exhaustion: s.exhaustion || 0, concentration: s.concentration || null,
        resist: s.resist || [], immune: s.immune || [], vulnerable: s.vulnerable || [], condImmune: s.condImmune || [],
        speed: s.speed || "", init: s.init ?? 0, cr: s.cr, dead: (s.hp?.current ?? 1) <= 0
      };
    }
    const c = ctx.charOf(token);
    if (!c) return null;
    const ac = estimateArmorClass(c, null, false) + (c.acAdjustments || []).reduce((sum, a) => sum + (a.value || 0), 0);
    const failures = c.deathSaves?.failures || 0;
    const innate = innateResistances(c, ctx.ruleset());
    return {
      kind: token.kind, name: c.name, hp: c.hp || { current: 0, max: 0, temp: 0 }, ac,
      conditions: c.conditions || [], exhaustion: c.exhaustion || 0, concentration: c.concentration || null,
      resist: [...new Set([...innate, ...(c.damageResistances || [])])], innateResist: innate, immune: c.damageImmunities || [], vulnerable: c.damageVulnerabilities || [], condImmune: c.conditionImmunities || [],
      deathSaves: c.deathSaves || { successes: 0, failures: 0 }, ownerUid: c.ownerUid,
      dead: token.kind === "npc" ? (c.hp?.current ?? 1) <= 0 : failures >= 3 || (c.exhaustion || 0) >= 6
    };
  }

  function canEdit(token) {
    if (ctx.isDm) return true;
    return token.kind === "pc" && ctx.charOf(token)?.ownerUid === ctx.user.uid;
  }

  async function patchState(token, patch) {
    if (token.kind === "monster") {
      const stats = { ...(token.stats || {}), ...patch };
      token.stats = stats; // keep the open panel in step before the snapshot lands
      await db.tokens.update(ctx.campaignId, ctx.mapId(), token.id, { stats });
      return;
    }
    const out = {};
    Object.entries(patch).forEach(([k, v]) => { out[CHAR_FIELDS[k] || (k === "ac" ? "armorClassOverride" : k)] = v; });
    await db.characters.update(token.refId, out);
  }

  // ---------------- Grapples ----------------
  const tokenById = (id) => ctx.tokens().find(t => t.id === id);
  const grappledBy = (target) => target.grappledBy ? tokenById(target.grappledBy) : null;
  const grappling = (grappler) => ctx.tokens().filter(t => t.grappledBy === grappler.id);

  async function startGrapple(target, grappler) {
    const st = stateOf(target);
    if (st.condImmune.includes("Grappled")) { toast(`${st.name} can't be Grappled (immune)`, "error"); return; }
    const spot = footprintGap(target, grappler) <= 0 ? { x: target.x, y: target.y } : snapAdjacent(target, grappler);
    await db.tokens.update(ctx.campaignId, ctx.mapId(), target.id, {
      x: spot.x, y: spot.y, grappledBy: grappler.id, grappleOffset: { dx: spot.x - grappler.x, dy: spot.y - grappler.y }
    });
    if (!st.conditions.includes("Grappled")) await patchState(target, { conditions: withCondition(st.conditions, "Grappled", true) });
    toast(`${st.name} is Grappled by ${grappler.name} — it moves with ${grappler.name} and can't move on its own`);
  }

  async function releaseGrapple(target, { quiet = false } = {}) {
    await db.tokens.update(ctx.campaignId, ctx.mapId(), target.id, { grappledBy: null, grappleOffset: null });
    const st = stateOf(target);
    if (st?.conditions.includes("Grappled")) await patchState(target, { conditions: withCondition(st.conditions, "Grappled", false) });
    if (!quiet) toast(`${st?.name || target.name} is no longer Grappled`);
  }

  // Menu of creatures that could be the grappler, closest first
  function chooseGrappler(target, x, y) {
    const others = ctx.tokens().filter(t => t.id !== target.id && isCreature(t)).map(t => ({ t, gap: footprintGap(target, t) })).sort((a, b) => a.gap - b.gap);
    if (!others.length) { toast("No other creature on this map to grapple with", "error"); return; }
    const items = [{ header: `Who grapples ${target.name}?` }];
    others.slice(0, 14).forEach(({ t, gap }) => items.push({
      label: `${t.name} • ${distanceFt(target, t)} ft${gap > 0 ? " (pulled adjacent)" : ""}`,
      action: () => startGrapple(target, t)
    }));
    showContextMenu(x, y, items);
  }

  // DM-side upkeep after any token/character change: grapples end when the grappler
  // is gone, incapacitated or dead, or the Grappled condition was removed elsewhere;
  // followers are kept at their offset from the grappler (also covers players moving
  // a PC that drags a monster, which their own client isn't allowed to write).
  const reconciling = new Set();
  function reconcile() {
    if (!ctx.isDm) return;
    ctx.tokens().forEach(t => {
      if (!t.grappledBy || reconciling.has(t.id)) return;
      const g = tokenById(t.grappledBy);
      const st = stateOf(t);
      if (!st) return;
      const gs = g ? stateOf(g) : null;
      const broken = !g || !st.conditions.includes("Grappled") || (gs && (gs.dead || isIncapacitated(gs.conditions)));
      reconciling.add(t.id);
      const done = () => setTimeout(() => reconciling.delete(t.id), 400);
      if (broken) {
        const why = !g ? "the grappler left the map" : !st.conditions.includes("Grappled") ? null : gs?.dead ? `${g.name} is down` : `${g.name} is Incapacitated`;
        releaseGrapple(t, { quiet: !why }).then(() => { if (why) toast(`Grapple on ${st.name} ends — ${why}`); }).finally(done);
        return;
      }
      const off = t.grappleOffset || { dx: t.x - g.x, dy: t.y - g.y };
      const want = { x: g.x + off.dx, y: g.y + off.dy };
      if (Math.abs(want.x - t.x) > 0.01 || Math.abs(want.y - t.y) > 0.01) {
        db.tokens.update(ctx.campaignId, ctx.mapId(), t.id, { x: want.x, y: want.y }).finally(done);
      } else done();
    });
  }

  // ---------------- HP ----------------
  async function damage(token, raw, type) {
    const st = stateOf(token);
    if (!st || !(raw > 0)) return;
    const { amount, note } = adjustDamage(raw, type, st, st.conditions);
    const res = takeDamage(st.hp, amount);
    const patch = { hp: res.hp };
    let msg = `${st.name} takes ${amount}${type ? ` ${type}` : ""} damage${note ? ` (${note})` : ""}`;
    if (token.kind === "pc") {
      if (st.hp.current === 0 && res.rest > 0) {
        const ds = { ...st.deathSaves };
        ds.failures = Math.min(3, ds.failures + (res.rest >= st.hp.max ? 3 : 1));
        patch.deathSaves = ds;
        msg += ds.failures >= 3 ? " — and dies." : " — a failed death save.";
      } else if (res.massive) {
        patch.deathSaves = { successes: 0, failures: 3 };
        msg += " — killed outright by massive damage.";
      } else if (res.dropped) {
        patch.deathSaves = { successes: 0, failures: 0 };
        patch.conditions = withCondition(st.conditions, "Unconscious", true);
        msg += " — drops to 0 HP, Unconscious.";
      }
    } else if (res.dropped) {
      msg += ` — ${st.name} dies.`;
    }
    if (st.concentration && amount > 0) {
      if (res.hp.current === 0) patch.concentration = null;
      else msg += ` Concentration (${st.concentration}): CON save DC ${concentrationDc(amount)}.`;
    }
    if (token.kind === "monster" && res.dropped && ctx.isDm && !token.loot) {
      const monster = ctx.monsterOf(token);
      if (monster) {
        const loot = generateLoot(monster);
        token.loot = loot;
        db.tokens.update(ctx.campaignId, ctx.mapId(), token.id, { loot });
        msg += " Loot is ready in its panel.";
      }
    }
    await patchState(token, patch);
    if (res.hp.current === 0) for (const t of grappling(token)) await releaseGrapple(t, { quiet: true });
    toast(msg, res.hp.current === 0 ? "error" : undefined);
  }

  async function heal(token, amount) {
    const st = stateOf(token);
    if (!st || !(amount > 0)) return;
    const hp = { ...st.hp, current: Math.min(st.hp.max, st.hp.current + amount) };
    const patch = { hp };
    if (token.kind === "pc" && st.hp.current === 0) {
      patch.deathSaves = { successes: 0, failures: 0 };
      patch.conditions = withCondition(st.conditions, "Unconscious", false);
    }
    await patchState(token, patch);
    toast(`${st.name} regains ${hp.current - st.hp.current} HP`);
  }

  async function setTemp(token, amount) {
    const st = stateOf(token);
    if (!st || amount < 0) return;
    // Temporary HP doesn't stack: keep the higher value
    if (amount <= (st.hp.temp || 0)) { toast(`${st.name} keeps its ${st.hp.temp} temporary HP (they don't stack)`); return; }
    await patchState(token, { hp: { ...st.hp, temp: amount } });
  }

  async function toggleCondition(token, name, anchor) {
    const st = stateOf(token);
    const on = !st.conditions.includes(name);
    if (on && st.condImmune.includes(name)) { toast(`${st.name} is immune to ${name}`, "error"); return; }
    if (name === "Grappled") {
      if (on) { const r = anchor?.getBoundingClientRect(); chooseGrappler(token, r?.left ?? 200, r?.bottom ?? 200); }
      else await releaseGrapple(token);
      return;
    }
    const patch = { conditions: withCondition(st.conditions, name, on) };
    if (on && st.concentration && isIncapacitated(patch.conditions)) { patch.concentration = null; toast(`${st.name} loses Concentration (Incapacitated)`); }
    await patchState(token, patch);
    if (on && isIncapacitated(patch.conditions)) for (const t of grappling(token)) { await releaseGrapple(t, { quiet: true }); toast(`${t.name} is freed — ${st.name} is Incapacitated`); }
  }

  // ---------------- Rolls ----------------
  function logRoll(token, label, spec) {
    const result = computeRoll(spec);
    const name = stateOf(token)?.name || token.name;
    if (ctx.isDm && (ui.privateRolls || token.hidden)) {
      toast(`\u{1F512} ${name} — ${label}: ${result.total} (${formatBreakdown(result)}${result.mode !== "normal" ? `, ${result.mode}` : ""})`);
      return result;
    }
    db.log.add(ctx.campaignId, { type: "roll", uid: ctx.user.uid, displayName: name, label, result });
    return result;
  }

  function rollDamage(token, action, crit = false) {
    attackDamageParts(action).forEach(p => {
      const m = p.formula.match(/^(\d*)d(\d+)([+-]\d+)?$/i);
      if (!m) return;
      const count = (parseInt(m[1], 10) || 1) * (crit ? 2 : 1);
      logRoll(token, `${action.name} — ${p.type || ""} damage${crit ? " (crit)" : ""}`, { sides: parseInt(m[2], 10), count, modifier: parseInt(m[3] || "0", 10), mode: "normal" });
    });
  }

  // ---------------- Initiative ----------------
  async function addToInitiative(list) {
    const combat = ctx.combat();
    const existing = combat?.active ? combat.combatants || [] : [];
    const have = new Set(existing.map(c => c.id));
    const added = [];
    for (const token of list) {
      const st = stateOf(token);
      if (!st || st.dead) continue;
      const id = token.kind === "monster" ? token.id : token.refId;
      if (have.has(id)) continue;
      have.add(id);
      const initMod = token.kind === "monster" ? st.init : null;
      const c = { id, type: token.kind, name: st.name, portraitBase64: token.imageBase64 || null, ownerUid: st.ownerUid || null, initiative: null, initMod,
        actionUsed: false, bonusActionUsed: false, reactionUsed: false, movementUsed: false };
      if (token.kind === "monster") {
        const mode = st.conditions.includes("Invisible") ? "advantage" : "normal";
        c.initiative = computeRoll({ sides: 20, count: 1, modifier: (initMod || 0) - 2 * st.exhaustion, mode }).total;
      }
      added.push(c);
    }
    if (!added.length) { toast("Already in the initiative order"); return; }
    if (combat?.active) await db.combat.set(ctx.campaignId, { combatants: [...existing, ...added] });
    else await db.combat.set(ctx.campaignId, { active: true, round: 1, currentTurnIndex: 0, combatants: added, pendingRollRequest: null });
    toast(`${added.length === 1 ? added[0].name : `${added.length} creatures`} added to initiative${combat?.active ? "" : " — combat started (see the Combat tab)"}`);
  }

  // ---------------- Loot ----------------
  async function sendLootToParty(token) {
    const loot = token.loot;
    if (!loot || loot.sent) return;
    for (const it of loot.items) {
      await db.partyInventory.add(ctx.campaignId, { type: "gear", name: it.name, quantity: it.quantity || 1, isCustom: !it.magic, weightLb: 0, valueGp: 0,
        ...(it.magic ? { magic: it.magic } : {}), contributedByName: `Loot: ${token.name}`, contributedByUid: ctx.user.uid });
    }
    const coins = loot.coins || {};
    if (Object.values(coins).some(v => v > 0)) {
      const campaign = await db.campaigns.get(ctx.campaignId);
      const cur = { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0, ...(campaign?.partyCurrency || {}) };
      Object.entries(coins).forEach(([k, v]) => { cur[k] = (cur[k] || 0) + v; });
      await db.campaigns.update(ctx.campaignId, { partyCurrency: cur });
    }
    await db.tokens.update(ctx.campaignId, ctx.mapId(), token.id, { loot: { ...loot, sent: true } });
    toast(`Loot from ${token.name} sent to the party (Loot tab)`);
  }

  function magicLootEntry(item) {
    return { name: item.name, quantity: 1, rarity: item.rarity, magic: { id: item.id, rarity: item.rarity, attunement: !!item.attunement, attunementBy: item.attunementBy || null, description: item.description,
      maxCharges: /^\d+$/.test(item.charges || "") ? parseInt(item.charges, 10) : null, acBonus: item.acBonus || null, saveBonus: item.saveBonus || null, healDice: item.healDice || null } };
  }

  async function rollHoardLoot(token) {
    const monster = ctx.monsterOf(token);
    const loot = { ...(token.loot || generateLoot(monster || {})) };
    const hoard = rollHoard(token.stats?.cr);
    const items = [...loot.items];
    for (let i = 0; i < hoard.items; i++) {
      const it = rollMagicItem(ctx.ruleset()?.magicItems || [], token.stats?.cr, loot.hoardThemes);
      if (it) items.push({ ...magicLootEntry(it), source: "hoard" });
    }
    const coins = { ...loot.coins, gp: (loot.coins?.gp || 0) + hoard.gp };
    await db.tokens.update(ctx.campaignId, ctx.mapId(), token.id, { loot: { ...loot, items, coins, hoardRolled: true } });
    toast(`Hoard rolled: ${hoard.gp.toLocaleString()} GP and ${hoard.items} magic item${hoard.items === 1 ? "" : "s"}`);
  }

  async function addRandomMagicItem(token) {
    const loot = token.loot || { coins: {}, items: [], hoardThemes: [] };
    const it = rollMagicItem(ctx.ruleset()?.magicItems || [], token.stats?.cr, loot.hoardThemes || []);
    if (!it) return;
    await db.tokens.update(ctx.campaignId, ctx.mapId(), token.id, { loot: { ...loot, items: [...loot.items, { ...magicLootEntry(it), source: "rolled" }] } });
  }

  // ---------------- Panel ----------------
  function render(el, token, { onClose, onSize, onToggleHidden, onRemove, onOpenSheet }) {
    const st = stateOf(token);
    el.innerHTML = "";
    if (!st) {
      el.appendChild(h("div", { class: "cp-head" }, `<h4>${escapeHtml(token.name || "Token")}</h4>`));
      const close = h("button", { class: "icon-btn cp-close", title: "Close" }, "✕");
      close.addEventListener("click", onClose);
      el.querySelector(".cp-head").appendChild(close);
      if (token.kind === "component") el.appendChild(h("p", { class: "meta" }, token.isCover ? `${token.coverType === "three-quarters" ? "Three-Quarters" : "Half"} cover` : "Scenery"));
      else el.appendChild(h("p", { class: "meta" }, "Loading…"));
      if (ctx.isDm) el.appendChild(footer(token, st, { onSize, onToggleHidden, onRemove }));
      return;
    }
    const editable = canEdit(token);
    const monster = token.kind === "monster" ? ctx.monsterOf(token) : null;
    const g = grappledBy(token);
    const held = grappling(token);

    // Header
    const head = h("div", { class: "cp-head" });
    head.innerHTML = `
      <div class="portrait-preview sm">${token.imageBase64 ? `<img src="${token.imageBase64}">` : `<span>${escapeHtml((st.name || "?")[0].toUpperCase())}</span>`}</div>
      <div class="cp-title">
        <h4>${escapeHtml(st.name)}</h4>
        <div class="cp-badges">
          <span class="badge ${token.kind === "pc" ? "" : "rune"}">${token.kind === "pc" ? "PC" : token.kind === "npc" ? "NPC" : "Monster"}</span>
          ${token.hidden ? '<span class="badge">Hidden</span>' : ""}
          ${st.dead ? '<span class="badge dead">Dead</span>' : ""}
        </div>
      </div>`;
    const close = h("button", { class: "icon-btn cp-close", title: "Close (Esc)" }, "✕");
    close.addEventListener("click", onClose);
    head.appendChild(close);
    el.appendChild(head);

    if (monster) el.appendChild(h("div", { class: "cp-sub" }, escapeHtml(`${monster.size} ${monster.creatureType} • CR ${monster.cr} (${monster.xp} XP)`)));

    // Public view for other players: no numbers, just how it looks
    if (!editable) {
      const pct = st.hp.max ? st.hp.current / st.hp.max : 1;
      const look = st.dead ? "Dead" : st.hp.current <= 0 ? "Down" : pct <= 0.5 ? "Bloodied" : pct < 1 ? "Wounded" : "Unhurt";
      el.appendChild(h("p", { class: "cp-look" }, look));
      el.appendChild(conditionChips(token, st, false));
      if (g) el.appendChild(h("p", { class: "meta" }, `Grappled by ${escapeHtml(g.name)}`));
      return;
    }

    // Stats row
    const speedZero = hasSpeedZero([...st.conditions, ...impliedConditions(st.conditions)]);
    const speedText = speedZero ? `0 ft (${st.conditions.find(c => SPEED_ZERO.includes(c))})` : (st.speed || "") + (st.exhaustion && st.speed ? ` −${st.exhaustion * 5} ft` : "");
    const stats = h("div", { class: "cp-stats" });
    stats.innerHTML = `<div><span class="lbl">AC</span><b>${st.ac}</b></div>${st.speed || speedZero ? `<div><span class="lbl">Speed</span><b class="${speedZero ? "bad" : ""}">${escapeHtml(speedText)}</b></div>` : ""}${token.kind === "monster" ? `<div><span class="lbl">Init</span><b>${formatModifier(st.init)}</b></div>` : ""}`;
    if (token.kind === "monster" && ctx.isDm) {
      const acB = stats.querySelector("div b");
      acB.title = "Click to change AC"; acB.style.cursor = "pointer";
      acB.addEventListener("click", () => { const v = prompt(`AC for ${st.name}:`, st.ac); if (v != null && v !== "" && !isNaN(+v)) patchState(token, { ac: parseInt(v, 10) }); });
    }
    el.appendChild(stats);

    // HP manager
    const pct = st.hp.max ? Math.max(0, Math.min(1, st.hp.current / st.hp.max)) : 0;
    const hpBox = h("div", { class: "cp-hp" });
    hpBox.innerHTML = `
      <div class="cp-hp-nums"><span class="val">${st.hp.current}</span><span class="slash">/</span><span class="max" title="${token.kind === "monster" ? "Click to change max HP" : ""}">${st.hp.max}</span>${st.hp.temp ? `<span class="temp">+${st.hp.temp} temp</span>` : ""}</div>
      <div class="hp-bar"><div class="hp-bar-fill ${pct <= 0.25 ? "low" : pct <= 0.5 ? "mid" : ""}" style="width:${pct * 100}%"></div></div>`;
    if (token.kind === "monster" && ctx.isDm) {
      const maxEl = hpBox.querySelector(".max");
      maxEl.style.cursor = "pointer";
      maxEl.addEventListener("click", () => {
        const f = token.stats?.hpFormula;
        const v = prompt(`Max HP for ${st.name}${f ? ` (type "roll" to roll ${f})` : ""}:`, st.hp.max);
        if (v == null || v === "") return;
        const max = /^roll$/i.test(v.trim()) && f ? Math.max(1, rollFormula(f)) : parseInt(v, 10);
        if (max > 0) patchState(token, { hp: { ...st.hp, max, current: st.hp.current >= st.hp.max ? max : Math.min(st.hp.current, max) } });
      });
    }
    const amt = h("input", { type: "number", min: "0", placeholder: "Amt", class: "hp-amount", value: ui.amount });
    amt.addEventListener("input", () => { ui.amount = amt.value; });
    const typeSel = h("select", { class: "cp-dmg-type", title: "Damage type — resistances, immunities and vulnerabilities apply automatically" });
    typeSel.appendChild(h("option", { value: "" }, "Type…"));
    DAMAGE_TYPES.forEach(t => typeSel.appendChild(h("option", { value: t, selected: ui.dmgType === t ? "selected" : null }, t[0].toUpperCase() + t.slice(1))));
    typeSel.addEventListener("change", () => { ui.dmgType = typeSel.value; });
    const val = () => { const n = parseInt(amt.value, 10); ui.amount = ""; return n; };
    const btnDmg = h("button", { class: "btn sm danger" }, "Damage");
    btnDmg.addEventListener("click", () => damage(token, val(), typeSel.value));
    const btnHeal = h("button", { class: "btn sm hp-heal" }, "Heal");
    btnHeal.addEventListener("click", () => heal(token, val()));
    const btnTemp = h("button", { class: "btn sm" }, "Temp");
    btnTemp.addEventListener("click", () => setTemp(token, val()));
    amt.addEventListener("keydown", (e) => { if (e.key === "Enter") btnDmg.click(); });
    const row1 = h("div", { class: "cp-hp-row" }); row1.appendChild(amt); row1.appendChild(typeSel);
    const row2 = h("div", { class: "cp-hp-row" }); [btnDmg, btnHeal, btnTemp].forEach(b => row2.appendChild(b));
    hpBox.appendChild(row1); hpBox.appendChild(row2);
    el.appendChild(hpBox);

    if (token.kind === "pc" && st.hp.current === 0 && !st.dead) {
      el.appendChild(h("div", { class: "cp-note bad" }, `Dying — death saves: ${st.deathSaves.successes} ✓ / ${st.deathSaves.failures} ✗ (roll them on the sheet)`));
    }

    // Loot
    if (st.dead && ctx.isDm && (token.kind === "monster" || token.kind === "npc")) el.appendChild(lootBox(token));

    // Grapple status
    if (g) {
      const row = h("div", { class: "cp-note" });
      row.innerHTML = `<b>Grappled by ${escapeHtml(g.name)}</b> — Speed 0; moves with ${escapeHtml(g.name)}. Disadvantage on attacks except against ${escapeHtml(g.name)}. Escape: action, Athletics or Acrobatics vs. the escape DC.`;
      if (editable) { const b = h("button", { class: "btn sm ghost" }, "Escape / Release"); b.addEventListener("click", () => releaseGrapple(token)); row.appendChild(b); }
      el.appendChild(row);
    }
    if (held.length) {
      const row = h("div", { class: "cp-note" });
      const extra = held.some(t => !dragFree(token, t));
      row.innerHTML = `<b>Grappling ${held.map(t => escapeHtml(t.name)).join(", ")}</b>${extra ? " — each foot moved costs 1 extra foot while dragging." : ""}`;
      if (ctx.isDm) held.forEach(t => { const b = h("button", { class: "btn sm ghost" }, `Release ${t.name}`); b.addEventListener("click", () => releaseGrapple(t)); row.appendChild(b); });
      el.appendChild(row);
    }

    // Conditions
    el.appendChild(section("Conditions", conditionChips(token, st, true), conditionEditor(token, st), "cond"));
    const notes = defenseNotes([...st.conditions, ...impliedConditions(st.conditions)]);
    const am = attackMode(st.conditions, st.exhaustion);
    const effects = [];
    if (am.mode !== "normal" || am.penalty) effects.push(`Its attacks: ${am.mode !== "normal" ? am.mode : "normal"}${am.penalty ? `, ${am.penalty} (Exhaustion)` : ""}${am.reasons.length ? ` (${am.reasons.join(", ")})` : ""}`);
    notes.forEach(n => effects.push(n));
    if (isIncapacitated(st.conditions)) effects.push("No actions, Bonus Actions or Reactions");
    if (effects.length) el.appendChild(h("ul", { class: "cp-effects" }, effects.map(e => `<li>${escapeHtml(e)}</li>`).join("")));

    // Defenses
    el.appendChild(section("Defenses", defenseChips(st), defenseEditor(token, st), "def"));

    // Monster rolls
    if (monster && ctx.isDm) el.appendChild(monsterRolls(token, st, monster));

    if (ctx.isDm) {
      const priv = h("label", { class: "cp-private" });
      const cb = h("input", { type: "checkbox", checked: ui.privateRolls ? "checked" : null });
      cb.addEventListener("change", () => { ui.privateRolls = cb.checked; try { sessionStorage.setItem("gt_vtt_private_rolls", cb.checked ? "1" : "0"); } catch { /* noop */ } });
      priv.appendChild(cb);
      priv.appendChild(document.createTextNode(" Private rolls (only you see them; always on for hidden tokens)"));
      el.appendChild(priv);
    }
    el.appendChild(footer(token, st, { onSize, onToggleHidden, onRemove, onOpenSheet }));
  }

  // Tiny or two+ sizes smaller can be dragged for free
  function dragFree(grappler, target) {
    const order = SIZES.map(s => s.squares);
    const gi = order.indexOf(grappler.w || 1), ti = order.indexOf(target.w || 1);
    return (target.w || 1) <= 0.5 || (gi >= 0 && ti >= 0 && gi - ti >= 2);
  }

  function section(title, summary, editor, key) {
    const wrap = h("div", { class: "cp-section" });
    const top = h("div", { class: "cp-section-head" });
    top.appendChild(h("span", { class: "lbl" }, title));
    wrap.appendChild(top);
    wrap.appendChild(summary);
    if (editor) {
      const d = h("details", { class: "cp-edit" });
      if (ui.open[key]) d.open = true;
      d.addEventListener("toggle", () => { ui.open[key] = d.open; });
      d.appendChild(h("summary", {}, `Edit ${title.toLowerCase()}`));
      d.appendChild(editor);
      wrap.appendChild(d);
    }
    return wrap;
  }

  function conditionChips(token, st, interactive) {
    const box = h("div", { class: "condition-chips" });
    const implied = impliedConditions(st.conditions);
    if (!st.conditions.length && !implied.length && !st.exhaustion && !st.concentration) box.appendChild(h("span", { class: "meta" }, "None"));
    st.conditions.forEach(c => {
      const chip = h("button", { class: "condition-chip", title: CONDITION_TEXT[c] + (interactive && canEdit(token) ? "\n(click to remove)" : "") }, `${c}${interactive && canEdit(token) ? " ✕" : ""}`);
      if (interactive && canEdit(token)) chip.addEventListener("click", () => toggleCondition(token, c, chip));
      box.appendChild(chip);
    });
    implied.forEach(c => box.appendChild(h("span", { class: "condition-chip implied", title: `${CONDITION_TEXT[c]}\n(from another condition)` }, c)));
    if (st.exhaustion) box.appendChild(h("span", { class: "condition-chip exh", title: "−2 per level to d20 tests, −5 ft Speed per level" }, `Exhaustion ${st.exhaustion}`));
    if (st.concentration) {
      const c = h("button", { class: "condition-chip conc", title: "Click to end Concentration" }, `Concentrating: ${st.concentration}${interactive && canEdit(token) ? " ✕" : ""}`);
      if (interactive && canEdit(token)) c.addEventListener("click", () => patchState(token, { concentration: null }));
      box.appendChild(c);
    }
    return box;
  }

  function conditionEditor(token, st) {
    if (!canEdit(token)) return null;
    const box = h("div", {});
    const grid = h("div", { class: "cp-toggle-grid" });
    CONDITIONS.forEach(c => {
      const on = st.conditions.includes(c);
      const immune = st.condImmune.includes(c);
      const b = h("button", { class: `btn sm ${on ? "primary" : ""} ${immune ? "immune" : ""}`, title: immune ? `Immune to ${c}` : CONDITION_TEXT[c] }, c);
      b.addEventListener("click", () => toggleCondition(token, c, b));
      grid.appendChild(b);
    });
    box.appendChild(grid);
    const exh = h("div", { class: "cp-exh" });
    exh.appendChild(h("span", { class: "lbl" }, "Exhaustion"));
    for (let i = 0; i <= 6; i++) {
      const b = h("button", { class: `btn sm ${st.exhaustion === i ? "primary" : ""}`, title: i === 6 ? "Level 6: death" : `−${i * 2} d20 tests, −${i * 5} ft` }, String(i));
      b.disabled = i > 0 && st.condImmune.includes("Exhaustion");
      b.addEventListener("click", () => { patchState(token, { exhaustion: i }); if (i === 6) toast(`${st.name} dies of Exhaustion.`, "error"); });
      exh.appendChild(b);
    }
    box.appendChild(exh);
    const conc = h("button", { class: "btn sm ghost", style: "margin-top:6px;" }, st.concentration ? "End Concentration" : "Start Concentration…");
    conc.addEventListener("click", () => {
      if (st.concentration) { patchState(token, { concentration: null }); return; }
      if (isIncapacitated(st.conditions)) { toast("Can't concentrate while Incapacitated", "error"); return; }
      const name = prompt("Concentrating on which spell?");
      if (name) patchState(token, { concentration: name.trim() });
    });
    box.appendChild(conc);
    return box;
  }

  function defenseChips(st) {
    const box = h("div", { class: "cp-def" });
    const line = (label, list, cls) => list.length ? `<div><span class="lbl">${label}</span> ${list.map(x => `<span class="def-chip ${cls}">${escapeHtml(x)}</span>`).join("")}</div>` : "";
    const html = line("Resist", st.resist, "res") + line("Immune", st.immune, "imm") + line("Vulnerable", st.vulnerable, "vul") + line("Condition immune", st.condImmune, "cimm");
    box.innerHTML = html || '<span class="meta">None</span>';
    return box;
  }

  function defenseEditor(token, st) {
    if (!canEdit(token)) return null;
    const box = h("div", {});
    [["resist", "Resistances"], ["immune", "Immunities"], ["vulnerable", "Vulnerabilities"]].forEach(([key, label]) => {
      box.appendChild(h("div", { class: "lbl", style: "margin-top:6px;" }, label));
      const grid = h("div", { class: "cp-toggle-grid dmg" });
      DAMAGE_TYPES.forEach(t => {
        const on = st[key].includes(t);
        const innate = key === "resist" && (st.innateResist || []).includes(t);
        const b = h("button", { class: `btn sm ${on ? "primary" : ""}`, title: innate ? "From species \u2014 always on" : "" }, t[0].toUpperCase() + t.slice(1));
        b.disabled = innate;
        // Only the hand-set part is stored; species resistances are added back by stateOf
        const own = key === "resist" ? st[key].filter(x => !(st.innateResist || []).includes(x)) : st[key];
        b.addEventListener("click", () => patchState(token, { [key]: on ? own.filter(x => x !== t) : [...own, t] }));
        grid.appendChild(b);
      });
      box.appendChild(grid);
    });
    box.appendChild(h("div", { class: "lbl", style: "margin-top:6px;" }, "Condition immunities"));
    const grid = h("div", { class: "cp-toggle-grid" });
    [...CONDITIONS, "Exhaustion"].forEach(c => {
      const on = st.condImmune.includes(c);
      const b = h("button", { class: `btn sm ${on ? "primary" : ""}` }, c);
      b.addEventListener("click", async () => {
        const next = on ? st.condImmune.filter(x => x !== c) : [...st.condImmune, c];
        const patch = { condImmune: next };
        // Becoming immune ends the condition
        if (!on && st.conditions.includes(c)) patch.conditions = st.conditions.filter(x => x !== c);
        if (!on && c === "Exhaustion") patch.exhaustion = 0;
        await patchState(token, patch);
        if (!on && c === "Grappled" && token.grappledBy) releaseGrapple(token, { quiet: true });
      });
      grid.appendChild(b);
    });
    box.appendChild(grid);
    return box;
  }

  function monsterRolls(token, st, monster) {
    const wrap = h("div", { class: "cp-section" });
    wrap.appendChild(h("div", { class: "cp-section-head" }, '<span class="lbl">Rolls</span>'));
    // Saving throws with automatic fails / disadvantage
    const saves = h("div", { class: "cp-saves" });
    ABILITIES.forEach(a => {
      const bonus = monsterSaveBonus(monster, a);
      const rule = saveRule(a, st.conditions, st.exhaustion);
      const b = h("button", { class: `btn sm ${rule.autoFail ? "danger" : ""}`, title: rule.autoFail ? `Automatically fails (${rule.reason})` : rule.reason ? `Disadvantage (${rule.reason})` : `${a.toUpperCase()} save` }, `${a.toUpperCase()} ${rule.autoFail ? "✖" : formatModifier(bonus)}`);
      b.addEventListener("click", () => {
        if (rule.autoFail) { toast(`${st.name} automatically fails the ${a.toUpperCase()} save (${rule.reason})`, "error"); return; }
        logRoll(token, `${a.toUpperCase()} save`, { sides: 20, count: 1, modifier: bonus + rule.penalty, mode: rule.mode });
      });
      saves.appendChild(b);
    });
    wrap.appendChild(saves);
    // Attacks
    const g = grappledBy(token);
    const attacks = (monster.actions || []).filter(a => a.attackBonus != null);
    if (isIncapacitated(st.conditions)) wrap.appendChild(h("div", { class: "cp-note bad" }, "Incapacitated — it can't take actions."));
    attacks.forEach(a => {
      const row = h("div", { class: "cp-attack" });
      const am = attackMode(st.conditions, st.exhaustion);
      const parts = attackDamageParts(a);
      row.appendChild(h("div", { class: "cp-attack-name", title: a.description || "" }, `<b>${escapeHtml(a.name)}</b><small>${escapeHtml(parts.map(p => `${p.formula} ${p.type}`).join(" + "))}</small>`));
      const hit = h("button", { class: `btn sm ${am.mode === "disadvantage" ? "dis" : am.mode === "advantage" ? "adv" : "primary"}`, title: `${am.mode !== "normal" ? am.mode : "Normal"}${am.reasons.length ? ` (${am.reasons.join(", ")})` : ""}${g ? `\nGrappled: Disadvantage unless attacking ${g.name} (right-click)` : ""}\nRight-click for Advantage / Disadvantage` }, `${formatModifier(a.attackBonus + am.penalty)}${am.mode === "advantage" ? " ▲" : am.mode === "disadvantage" ? " ▼" : ""}`);
      const doHit = (mode) => {
        const r = logRoll(token, `${a.name} attack`, { sides: 20, count: 1, modifier: a.attackBonus + am.penalty, mode });
        if (r.isCritHigh) toast(`Critical hit! Use Crit damage for ${a.name}.`);
      };
      hit.addEventListener("click", () => doHit(am.mode));
      hit.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const items = [{ label: "Normal", action: () => doHit("normal") }, { label: "Advantage", action: () => doHit("advantage") }, { label: "Disadvantage", action: () => doHit("disadvantage") }];
        if (g) items.unshift({ label: `Against ${g.name} (grappler)`, action: () => doHit(attackMode(st.conditions, st.exhaustion, { vsGrappler: true }).mode) });
        showContextMenu(e.clientX, e.clientY, items);
      });
      const dmg = h("button", { class: "btn sm", title: "Roll damage" }, "Dmg");
      dmg.addEventListener("click", () => rollDamage(token, a));
      const crit = h("button", { class: "btn sm ghost", title: "Critical hit: double the damage dice" }, "Crit");
      crit.addEventListener("click", () => rollDamage(token, a, true));
      [hit, dmg, crit].forEach(b => row.appendChild(b));
      wrap.appendChild(row);
    });
    // Full stat block text
    const d = h("details", { class: "cp-edit" });
    if (ui.open.statblock) d.open = true;
    d.addEventListener("toggle", () => { ui.open.statblock = d.open; });
    d.appendChild(h("summary", {}, "Stat block"));
    const body = h("div", { class: "cp-statblock" });
    const sc = monster.abilityScores || {};
    const blocks = [
      `<div class="cp-abil">${ABILITIES.map(a => `<span><b>${a.toUpperCase()}</b> ${sc[a] ?? 10} (${formatModifier(abilityModifier(sc[a] ?? 10))})</span>`).join("")}</div>`,
      ...[["Skills", monster.skills], ["Senses", monster.senses], ["Languages", monster.languages], ["Gear", monster.gear]].filter(([, v]) => v).map(([k, v]) => `<p><b>${k}</b> ${escapeHtml(v)}</p>`)
    ];
    const list = (title, arr) => arr?.length ? `<h5>${title}</h5>` + arr.map(t => `<p><b>${escapeHtml(t.name)}.</b> ${escapeHtml(t.description || "")}</p>`).join("") : "";
    body.innerHTML = blocks.join("") + list("Traits", monster.traits) + list("Actions", monster.actions) + list("Bonus Actions", monster.bonusActions) + list("Reactions", monster.reactions) + list(`Legendary Actions${monster.legendaryUses ? ` (${escapeHtml(String(monster.legendaryUses))})` : ""}`, monster.legendaryActions);
    d.appendChild(body);
    wrap.appendChild(d);
    return wrap;
  }

  function lootBox(token) {
    const box = h("div", { class: "cp-loot" });
    box.appendChild(h("div", { class: "cp-section-head" }, '<span class="lbl">\u{1F4B0} Loot (only you see this)</span>'));
    if (token.kind === "npc") {
      const list = h("div", { class: "meta" }, "Loading inventory…");
      box.appendChild(list);
      const unsub = db.inventory.subscribe(token.refId, (items) => {
        setTimeout(() => unsub?.(), 0);
        const c = ctx.charOf(token)?.currency || {};
        const coins = Object.entries(c).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k.toUpperCase()}`).join(", ");
        list.innerHTML = (items.length ? items.map(i => `• ${escapeHtml(i.name)}${i.quantity > 1 ? ` ×${i.quantity}` : ""}`).join("<br>") : "No items.") + (coins ? `<br>• ${coins}` : "") + "<br><small>Open the NPC's sheet to hand items over.</small>";
      });
      return box;
    }
    const loot = token.loot;
    if (!loot) {
      const b = h("button", { class: "btn sm primary" }, "Roll loot");
      b.addEventListener("click", () => { const m = ctx.monsterOf(token); db.tokens.update(ctx.campaignId, ctx.mapId(), token.id, { loot: generateLoot(m || {}) }); });
      box.appendChild(b);
      return box;
    }
    const coins = Object.entries(loot.coins || {}).filter(([, v]) => v > 0).map(([k, v]) => `${v.toLocaleString()} ${k.toUpperCase()}`);
    const lines = [];
    if (coins.length) lines.push(`<li><b>Coins:</b> ${coins.join(", ")}</li>`);
    loot.items.forEach(it => lines.push(`<li>${it.magic ? `<span class="badge rarity-${(it.rarity || "").toLowerCase().replace(/\s+/g, "-")}">${escapeHtml(it.rarity || "Magic")}</span> ` : ""}${escapeHtml(it.name)}${it.quantity > 1 ? ` ×${it.quantity}` : ""}</li>`));
    box.appendChild(h("ul", { class: "cp-loot-list" }, lines.join("") || "<li class='meta'>Nothing of value.</li>"));
    const tags = ctx.monsterOf(token)?.treasure || [];
    if (tags.length) box.appendChild(h("div", { class: "meta" }, `Treasure: ${escapeHtml(tags.join(", "))}`));
    if (loot.sent) { box.appendChild(h("div", { class: "meta" }, "✔ Sent to the party.")); return box; }
    const btns = h("div", { class: "cp-btn-row" });
    if (loot.hoardThemes?.length && !loot.hoardRolled) {
      const hb = h("button", { class: "btn sm", title: "DMG Random Treasure Hoard for this CR, with magic items from its treasure theme" }, `Roll hoard (${loot.hoardThemes.join("/")})`);
      hb.addEventListener("click", () => rollHoardLoot(token));
      btns.appendChild(hb);
    }
    const mi = h("button", { class: "btn sm ghost", title: "Add one random magic item (rarity by CR)" }, "+ Magic item");
    mi.addEventListener("click", () => addRandomMagicItem(token));
    const coinsBtn = h("button", { class: "btn sm ghost", title: "Roll Individual Treasure coins again" }, "Reroll coins");
    coinsBtn.addEventListener("click", () => db.tokens.update(ctx.campaignId, ctx.mapId(), token.id, { loot: { ...loot, coins: rollIndividualCoins(token.stats?.cr) } }));
    const send = h("button", { class: "btn sm primary" }, "Send to party");
    send.addEventListener("click", () => sendLootToParty(token));
    [mi, coinsBtn, send].forEach(b => btns.appendChild(b));
    box.appendChild(btns);
    return box;
  }

  function footer(token, st, { onSize, onToggleHidden, onRemove, onOpenSheet }) {
    const row = h("div", { class: "cp-footer" });
    if (st && ctx.isDm) {
      const ini = h("button", { class: "btn sm", title: "Add to the initiative order (rolls for monsters)" }, "⚔ Initiative");
      ini.addEventListener("click", () => addToInitiative([token]));
      row.appendChild(ini);
      const gr = h("button", { class: "btn sm", title: token.grappledBy ? "End this grapple" : "Pick who grapples this creature" }, token.grappledBy ? "Release" : "Grapple…");
      gr.addEventListener("click", () => token.grappledBy ? releaseGrapple(token) : (stateOf(token).condImmune.includes("Grappled") ? toast(`${st.name} is immune to Grappled`, "error") : chooseGrappler(token, gr.getBoundingClientRect().left, gr.getBoundingClientRect().bottom)));
      row.appendChild(gr);
    }
    if (ctx.isDm) {
      const sz = h("button", { class: "btn sm", title: "Token size" }, `Size: ${SIZES.find(s => s.id === sizeIdForSquares(token.w || 1))?.label || `${token.w}×${token.h}`}`);
      sz.addEventListener("click", () => onSize(token, sz));
      row.appendChild(sz);
      const hid = h("button", { class: "btn sm", title: "Hidden tokens are invisible to players" }, token.hidden ? "\u{1F441} Show" : "\u{1F576} Hide");
      hid.addEventListener("click", () => onToggleHidden(token));
      row.appendChild(hid);
    }
    if (st && token.kind !== "monster" && onOpenSheet && canEdit(token)) {
      const os = h("button", { class: "btn sm ghost" }, "Open sheet");
      os.addEventListener("click", () => onOpenSheet(token));
      row.appendChild(os);
    }
    if (ctx.isDm && onRemove) {
      const rm = h("button", { class: "btn sm ghost danger" }, "Remove");
      rm.addEventListener("click", () => onRemove(token));
      row.appendChild(rm);
    }
    return row;
  }

  return { stateOf, canEdit, render, reconcile, startGrapple, releaseGrapple, chooseGrappler, addToInitiative, toggleCondition, damage, heal, grappledBy };
}
