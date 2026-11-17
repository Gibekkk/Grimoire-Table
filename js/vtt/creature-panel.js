// Creature panel for the VTT: one place to run a creature in combat — HP
// (damage types respect resistances), conditions with their automatic effects,
// defenses, grapples, size, visibility, initiative, monster rolls and loot.
// Works for PC/NPC tokens (state lives on the character doc) and for monster
// tokens (state lives on the token's `stats`).
import { db } from "../db.js";
import { h, toast, escapeHtml, showContextMenu } from "../util.js";
import { ABILITIES, abilityModifier, formatModifier, estimateArmorClass, rollDie } from "../rules-engine.js";
import { computeRoll, formatBreakdown } from "../dice/roll-logic.js";
import { openDialog, promptDialog, confirmDialog } from "../dialogs.js";
import { showItemPopover, findItem } from "../item-info.js";
import {
  SIZES, CONDITIONS, CONDITION_TEXT, DAMAGE_TYPES, impliedConditions, withCondition, isIncapacitated,
  attackMode, saveRule, defenseNotes, adjustDamage, takeDamage, concentrationDc, footprintGap, distanceFt, ringOffset,
  actionInfo, legendaryUses, parseSkills, revealed, DEFAULT_ALIAS, checkRule,
  STATUS_EFFECTS, effectDef, hasEffect, effectPatch, conditionImmunities, effectAc, effectiveSpeed, effectiveSquares, initiativeRule, rollExtraDice, confusionResult, characterSpeed,
  monsterSaveBonus, attackDamageParts, rollFormula, generateLoot, rollMagicItem, INDIVIDUAL_TREASURE, TREASURE_HOARD, treasureTier, sizeIdForSquares, innateResistances
} from "./creatures.js";

const CHAR_FIELDS = { resist: "damageResistances", immune: "damageImmunities", vulnerable: "damageVulnerabilities", condImmune: "conditionImmunities", effects: "statusEffects" };
// A grapple with no Grappled condition may just be two writes arriving apart, so it
// only counts as ended once it has stayed that way this long.
const GRAPPLE_GRACE_MS = 4000;
const SOURCE_CONDITIONS = { Frightened: "Who is it afraid of?", Charmed: "Who charmed it?" };
const ui = { amount: "", dmgType: "", open: {}, privateRolls: false };
try { ui.privateRolls = sessionStorage.getItem("gt_vtt_private_rolls") === "1"; } catch { /* noop */ }

// ctx: { campaignId, user, isDm, mapId(), tokens(), ready(), charOf(token), monsterOf(token), ruleset(), combat(), artOf(token) }
export function createCreatureTools(ctx) {
  const isCreature = (t) => t && (t.kind === "pc" || t.kind === "npc" || t.kind === "monster");

  function stateOf(token) {
    if (!isCreature(token)) return null;
    if (token.kind === "monster") {
      const s = token.stats || {};
      return {
        kind: "monster", name: token.name, hp: s.hp || { current: 0, max: 0, temp: 0 }, ac: effectAc(s.ac ?? 10, s.effects).ac, baseAc: s.ac ?? 10, effects: s.effects || [],
        baseSpeed: parseInt(String(s.speed || "").match(/\d+/)?.[0], 10) || 0,
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
      kind: token.kind, name: c.name, hp: c.hp || { current: 0, max: 0, temp: 0 }, ac: effectAc(ac, c.statusEffects).ac, effects: c.statusEffects || [],
      baseSpeed: characterSpeed(c, ctx.ruleset()),
      conditions: c.conditions || [], exhaustion: c.exhaustion || 0, concentration: c.concentration || null,
      resist: [...new Set([...innate, ...(c.damageResistances || [])])], innateResist: innate, immune: c.damageImmunities || [], vulnerable: c.damageVulnerabilities || [], condImmune: c.conditionImmunities || [],
      deathSaves: c.deathSaves || { successes: 0, failures: 0 }, ownerUid: c.ownerUid,
      dead: token.kind === "npc" ? (c.hp?.current ?? 1) <= 0 : failures >= 3 || (c.exhaustion || 0) >= 6
    };
  }

  // Players the DM handed this creature to (summons, companions, a borrowed mount)
  const controls = (token) => (token.controllers || []).includes(ctx.user.uid);

  // ---------------- Names and what players see ----------------
  // The DM can keep a creature's name (showing an alias instead), its picture, or its
  // details (health, conditions, creature type) back from the players. This only governs
  // what the app shows; it isn't hidden from someone reading the database directly.
  const realName = (t) => stateOf(t)?.name || t.name || "";
  const seesAll = (t) => ctx.isDm || controls(t) || t.kind === "pc";
  // The name as everyone at the table knows it (used for the shared log and initiative)
  const publicName = (t) => revealed(t, "name") ? realName(t) : (t.alias || DEFAULT_ALIAS);
  // The name as this viewer should see it
  const displayName = (t) => seesAll(t) ? realName(t) : publicName(t);

  // Rename, alias and reveal settings in one dialog (DM)
  async function editIdentity(token) {
    token = tokenById(token.id) || token;
    const r = await openDialog({
      title: "Name and what players see",
      okLabel: "Save",
      fields: [
        { name: "name", label: "Name", value: realName(token) },
        { name: "alias", label: "Players see this name while the real one is hidden", value: token.alias || "", placeholder: DEFAULT_ALIAS },
        { name: "reveal", label: "Show players", type: "checks", value: ["name", "picture", "details"].filter(k => revealed(token, k)),
          options: [["name", "Its real name"], ["picture", "Its picture"], ["details", "Its type, health, conditions and effects"]] }
      ]
    });
    if (!r) return;
    const name = r.name.trim() || realName(token);
    const reveal = { name: r.reveal.includes("name"), picture: r.reveal.includes("picture"), details: r.reveal.includes("details") };
    const writes = [db.tokens.update(ctx.campaignId, ctx.mapId(), token.id, { name, alias: r.alias.trim() || null, reveal })];
    // An NPC's name lives on its sheet; its other tokens on this map follow
    if (token.kind === "npc" && name !== realName(token)) {
      writes.push(db.characters.update(token.refId, { name }));
      ctx.tokens().filter(t => t.kind === "npc" && t.refId === token.refId && t.id !== token.id).forEach(t => writes.push(db.tokens.update(ctx.campaignId, ctx.mapId(), t.id, { name })));
    }
    await Promise.all(writes);
    syncCombatName({ ...token, name, alias: r.alias.trim() || null, reveal }, name);
    toast(reveal.name ? `${name}: players see the real name` : `${name}: players see "${r.alias.trim() || DEFAULT_ALIAS}"`);
  }

  // Keeps the initiative order's names in step: players see the public name, the DM the real one
  function syncCombatName(token, real) {
    const combat = ctx.combat();
    if (!combat?.active) return;
    const id = token.kind === "monster" ? token.id : token.refId;
    const shown = revealed(token, "name") ? real : (token.alias || DEFAULT_ALIAS);
    if (!combat.combatants?.some(c => c.id === id)) return;
    db.combat.set(ctx.campaignId, { combatants: combat.combatants.map(c => c.id === id ? { ...c, name: shown, dmName: real } : c) });
  }

  // NPC state lives on the NPC's character doc, which only the DM may write, so a
  // player controlling an NPC moves it but can't edit it
  function canEdit(token) {
    if (ctx.isDm) return true;
    if (token.kind === "pc") return ctx.charOf(token)?.ownerUid === ctx.user.uid;
    return token.kind === "monster" && controls(token);
  }

  async function patchState(token, patch) {
    if (token.kind === "monster") {
      // Merge onto the newest copy: a panel or menu can outlive the snapshot it was built from
      const cur = tokenById(token.id) || token;
      const stats = { ...(cur.stats || {}), ...patch };
      cur.stats = stats; token.stats = stats; // keep the open panel in step before the snapshot lands
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

  // Footprint on the grid right now (Enlarge / Reduce change it without touching the token doc)
  function footprint(t) {
    const effects = stateOf(t)?.effects || [];
    return { w: (t.w || 1) === (t.h || 1) ? effectiveSquares(t.w || 1, effects) : t.w || 1, h: (t.w || 1) === (t.h || 1) ? effectiveSquares(t.h || 1, effects) : t.h || 1 };
  }

  // Current offset of a grappled token from its grappler, always within 5 ft.
  // grappleOffsets on the grappler's token holds a move made by a player, who may only
  // write their own token; the DM's client folds it into the target (see reconcile).
  function followOffset(t, g) {
    const off = g.grappleOffsets?.[t.id] || t.grappleOffset || { dx: t.x - g.x, dy: t.y - g.y };
    return ringOffset(footprint(g), footprint(t), off.dx, off.dy);
  }

  // A grapple-start write is one document for monsters. For PCs and NPCs the condition goes
  // first so nothing ever sees a grappler without the condition from this client.
  async function startGrapple(target, grappler) {
    target = tokenById(target.id) || target;
    grappler = tokenById(grappler.id) || grappler;
    const st = stateOf(target);
    if (conditionImmunities(st).includes("Grappled")) { toast(`${st.name} can't be Grappled (immune)`, "error"); return; }
    const off = ringOffset(footprint(grappler), footprint(target), target.x - grappler.x, target.y - grappler.y);
    const place = { x: grappler.x + off.dx, y: grappler.y + off.dy, grappledBy: grappler.id, grappleOffset: off };
    const conditions = withCondition(st.conditions, "Grappled", true);
    toast(`${st.name} is Grappled by ${displayName(grappler)} \u2014 it moves with them, and they can drag it around to any side`);
    if (target.kind === "monster") {
      const stats = { ...(target.stats || {}), conditions };
      target.stats = stats;
      await db.tokens.update(ctx.campaignId, ctx.mapId(), target.id, { ...place, stats });
      return;
    }
    await Promise.all([patchState(target, { conditions }), db.tokens.update(ctx.campaignId, ctx.mapId(), target.id, place)]);
  }

  async function releaseGrapple(target, { quiet = false } = {}) {
    target = tokenById(target.id) || target;
    const st = stateOf(target);
    const clear = { grappledBy: null, grappleOffset: null };
    const hadCondition = st?.conditions.includes("Grappled");
    if (!quiet) toast(`${st?.name || target.name} is no longer Grappled`);
    if (target.kind === "monster" && hadCondition) {
      const stats = { ...(target.stats || {}), conditions: withCondition(st.conditions, "Grappled", false) };
      target.stats = stats;
      await db.tokens.update(ctx.campaignId, ctx.mapId(), target.id, { ...clear, stats });
      return;
    }
    await Promise.all([db.tokens.update(ctx.campaignId, ctx.mapId(), target.id, clear), hadCondition ? patchState(target, { conditions: withCondition(st.conditions, "Grappled", false) }) : null]);
  }

  // The grappler repositions what it holds. (dx, dy) comes from the canvas, already on the ring.
  async function moveGrappled(target, dx, dy) {
    target = tokenById(target.id) || target;
    const g = grappledBy(target);
    if (!g) return;
    if (ctx.isDm) {
      const { [target.id]: _, ...others } = g.grappleOffsets || {};
      const writes = [db.tokens.update(ctx.campaignId, ctx.mapId(), target.id, { x: g.x + dx, y: g.y + dy, grappleOffset: { dx, dy } })];
      if (g.grappleOffsets?.[target.id]) writes.push(db.tokens.update(ctx.campaignId, ctx.mapId(), g.id, { grappleOffsets: others }));
      await Promise.all(writes);
      return;
    }
    await db.tokens.update(ctx.campaignId, ctx.mapId(), g.id, { grappleOffsets: { ...(g.grappleOffsets || {}), [target.id]: { dx, dy } } });
  }

  // Menu of creatures that could be the grappler, closest first
  function chooseGrappler(target, x, y) {
    const others = ctx.tokens().filter(t => t.id !== target.id && isCreature(t)).map(t => ({ t, gap: footprintGap(target, t) })).sort((a, b) => a.gap - b.gap);
    if (!others.length) { toast("No other creature on this map to grapple with", "error"); return; }
    const items = [{ header: `Who grapples ${target.name}?` }];
    others.slice(0, 14).forEach(({ t, gap }) => items.push({
      label: `${displayName(t)} \u2022 ${distanceFt(target, t)} ft${gap > 0 ? " (pulled adjacent)" : ""}`,
      action: () => startGrapple(target, t)
    }));
    showContextMenu(x, y, items);
  }

  // Frightened and Charmed name their source, like Grappled names its grappler
  function chooseSource(token, name, x, y) {
    const st = stateOf(token);
    const apply = async (sourceId) => {
      const cur = tokenById(token.id) || token;
      await Promise.all([
        patchState(cur, { conditions: withCondition(st.conditions, name, true) }),
        db.tokens.update(ctx.campaignId, ctx.mapId(), cur.id, { condSources: { ...(cur.condSources || {}), [name]: sourceId } })
      ]);
    };
    const others = ctx.tokens().filter(t => t.id !== token.id && isCreature(t)).map(t => ({ t, ft: distanceFt(token, t) })).sort((a, b) => a.ft - b.ft);
    const items = [{ header: SOURCE_CONDITIONS[name] }, { label: "No specific creature", action: () => apply(null) }];
    others.slice(0, 14).forEach(({ t, ft }) => items.push({ label: `${displayName(t)} \u2022 ${ft} ft`, action: () => apply(t.id) }));
    showContextMenu(x, y, items);
  }
  const sourceOf = (token, name) => token.condSources?.[name] ? tokenById(token.condSources[name]) : null;

  // Why a token may not end a move at (x, y), for the mover to be told: a Frightened
  // creature can't willingly move closer to the source of its fear. The DM can still
  // force the move (shoves, falls), with a reminder.
  function moveBlockedWhy(token, x, y) {
    const st = stateOf(token);
    const src = st?.conditions.includes("Frightened") ? sourceOf(token, "Frightened") : null;
    if (!src) return null;
    const c = (p, t) => ({ x: p.x + (t.w || 1) / 2, y: p.y + (t.h || 1) / 2 });
    const s = c(src, src), from = c(token, token), to = c({ x, y }, token);
    if (Math.hypot(to.x - s.x, to.y - s.y) >= Math.hypot(from.x - s.x, from.y - s.y) - 0.01) return null;
    const why = `${st.name} is Frightened of ${displayName(src)} and can't willingly move closer`;
    if (ctx.isDm) { toast(`${why} (allowed: you're the DM)`); return null; }
    return why;
  }

  // DM-side upkeep after any token/character change: grapples end when the grappler
  // is gone, incapacitated or dead, or the Grappled condition was removed elsewhere;
  // followers are kept at their offset from the grappler (also covers players moving
  // a PC that drags a monster, which their own client isn't allowed to write).
  const reconciling = new Set();
  const noCondSince = new Map();
  function reconcile() {
    if (!ctx.isDm) return;
    ctx.tokens().forEach(t => {
      if (!t.grappledBy || reconciling.has(t.id)) return;
      const g = tokenById(t.grappledBy);
      const st = stateOf(t);
      if (!st) return;
      const gs = g ? stateOf(g) : null;
      const noCond = !st.conditions.includes("Grappled");
      if (g && noCond && !(gs && (gs.dead || isIncapacitated(gs.conditions)))) {
        // Grapple and condition are separate writes for PCs/NPCs: give the other one time to land
        const since = noCondSince.get(t.id) ?? Date.now();
        noCondSince.set(t.id, since);
        if (Date.now() - since < GRAPPLE_GRACE_MS) { setTimeout(reconcile, GRAPPLE_GRACE_MS + 50); return; }
      }
      noCondSince.delete(t.id);
      const broken = !g || noCond || (gs && (gs.dead || isIncapacitated(gs.conditions)));
      reconciling.add(t.id);
      const done = () => setTimeout(() => reconciling.delete(t.id), 400);
      if (broken) {
        const why = !g ? "the grappler left the map" : noCond ? null : gs?.dead ? `${g.name} is down` : `${g.name} is Incapacitated`;
        releaseGrapple(t, { quiet: true }).then(() => { if (why) toast(`Grapple on ${st.name} ends \u2014 ${why}`); }).finally(done);
        return;
      }
      const off = followOffset(t, g);
      const want = { x: g.x + off.dx, y: g.y + off.dy };
      const writes = [];
      const stored = t.grappleOffset || {};
      if (Math.abs(want.x - t.x) > 0.01 || Math.abs(want.y - t.y) > 0.01 || Math.abs((stored.dx ?? 1e9) - off.dx) > 0.01 || Math.abs((stored.dy ?? 1e9) - off.dy) > 0.01) {
        writes.push(db.tokens.update(ctx.campaignId, ctx.mapId(), t.id, { x: want.x, y: want.y, grappleOffset: off }));
      }
      if (g.grappleOffsets?.[t.id]) {
        const { [t.id]: _, ...others } = g.grappleOffsets;
        writes.push(db.tokens.update(ctx.campaignId, ctx.mapId(), g.id, { grappleOffsets: others }));
      }
      Promise.all(writes).finally(done);
    });
  }

  // ---------------- Status effects ----------------
  async function toggleEffect(token, id) {
    const st = stateOf(token);
    const on = !hasEffect(st.effects, id);
    const def = effectDef(st.effects.find(e => e.id === id) || id);
    const extra = {};
    if (on && def?.askValue) {
      const v = await promptDialog(def.askValue, "3", { title: def.name, type: "number" });
      if (v == null) return;
      extra.value = parseInt(v, 10) || 0;
    }
    const patch = effectPatch(st, id, on, extra);
    // Gaining an immunity ends the conditions it covers
    if (on && def?.condImmune) patch.conditions = (patch.conditions || st.conditions).filter(c => !def.condImmune.includes(c));
    if (!on && def?.endsInto) toast(`${st.name}: ${def.name} ends \u2014 ${effectDef(def.endsInto).text}`, "error");
    await patchState(token, patch);
    if (isIncapacitated(patch.conditions || []) && !isIncapacitated(st.conditions)) {
      if (st.concentration) await patchState(token, { concentration: null });
      for (const t of grappling(token)) await releaseGrapple(t, { quiet: true });
    }
  }

  // Anything the catalog doesn't cover: a name, a duration, and damage each turn if any
  async function addCustomEffect(token) {
    const r = await openDialog({ title: "Custom effect", okLabel: "Add", fields: [
      { name: "name", label: "Name", placeholder: "e.g. Bleeding, Cursed" },
      { name: "rounds", label: "Lasts how many of its turns? (blank = until removed)", type: "number", min: 1 },
      { name: "tick", label: "Damage at the start of each of its turns (blank = none)", placeholder: "e.g. 1d6 poison" }
    ] });
    const name = r?.name;
    if (!name?.trim()) return;
    const rounds = parseInt(r.rounds || "", 10);
    const tick = (r.tick || "").trim().match(/^(\d*d\d+(?:[+-]\d+)?)\s*(\w+)?$/i);
    const fields = { name: name.trim(), abbr: name.trim().slice(0, 2), tone: tick ? "hazard" : "neutral", text: "Custom effect." };
    if (rounds > 0) fields.rounds = rounds;
    if (tick) { fields.tick = { dice: tick[1], type: DAMAGE_TYPES.includes(tick[2]?.toLowerCase()) ? tick[2].toLowerCase() : "" }; fields.text = `${tick[0]} at the start of each turn.`; }
    const st = stateOf(token);
    await patchState(token, effectPatch(st, `custom:${Date.now()}`, true, fields));
  }

  // Turn upkeep runs once per turn on the DM's client. effectsTurn on the combat doc records
  // the last turn handled, so reopening the VTT or a second tab doesn't repeat it.
  let lastTurnKey = null;
  const tokenOfCombatant = (id) => ctx.tokens().find(t => t.id === id || (t.kind !== "monster" && t.refId === id));
  async function processTurn() {
    const combat = ctx.combat();
    if (!ctx.isDm || !combat?.active || !ctx.ready()) return;
    const cur = combat.combatants?.[combat.currentTurnIndex];
    if (!cur) return;
    const key = `${combat.round}:${combat.currentTurnIndex}:${cur.id}`;
    const prev = combat.effectsTurn;
    if (prev?.key === key || lastTurnKey === key) return;
    lastTurnKey = key;
    await db.combat.set(ctx.campaignId, { effectsTurn: { key, id: cur.id } });
    if (prev?.id) await endOfTurn(tokenOfCombatant(prev.id));
    await startOfTurn(tokenOfCombatant(cur.id));
  }

  async function endOfTurn(token) {
    const st = token && stateOf(token);
    if (!st || st.dead) return;
    const work = { ...st }, patch = {};
    const change = (id) => { const p = effectPatch(work, id, false); Object.assign(work, p); Object.assign(patch, p); };
    st.effects.filter(e => effectDef(e)?.ends === "turnEnd").forEach(e => change(e.id));
    if (st.effects.some(e => effectDef(e)?.exhaustionAtTurnEnd)) {
      patch.exhaustion = Math.min(6, st.exhaustion + 1);
      toast(`${st.name} is suffocating: Exhaustion ${patch.exhaustion}`, "error");
    }
    if (Object.keys(patch).length) await patchState(token, patch);
  }

  async function startOfTurn(token) {
    const st = token && stateOf(token);
    if (!st || st.dead) return;
    // Monsters: legendary actions come back, and spent Recharge abilities roll to return
    if (token.kind === "monster") {
      const s = token.stats || {};
      if (s.legendaryUsed) await patchState(token, { legendaryUsed: 0 });
      const monster = ctx.monsterOf(token);
      for (const name of Object.keys(s.spent || {})) {
        const a = [...(monster?.actions || []), ...(monster?.bonusActions || []), ...(monster?.reactions || [])].find(x => x.name === name);
        const need = a ? actionInfo(a).recharge : null;
        if (need) await rollRecharge(tokenById(token.id) || token, name, need);
      }
    }
    const ended = [];
    const work = { ...st, effects: st.effects.map(e => e.rounds ? { ...e, rounds: e.rounds - 1 } : e) };
    const patch = { effects: work.effects };
    st.effects.forEach(e => {
      const def = effectDef(e);
      const live = work.effects.find(x => x.id === e.id);
      if (def?.ends === "turnStart" || (e.rounds && live && live.rounds <= 0)) {
        const p = effectPatch(work, e.id, false);
        Object.assign(work, p); Object.assign(patch, p);
        ended.push(def?.name || e.name);
      }
    });
    if (st.effects.length) await patchState(token, patch);
    if (ended.length) toast(`${st.name}: ${ended.join(", ")} ended`);
    // Everything active as the turn began takes effect, including what lapses this turn
    for (const e of st.effects) {
      const def = effectDef(e);
      if (!def || def.ends === "turnStart") continue;
      if (def?.tick) {
        const total = rollFormula(def.tick.dice);
        toast(`${st.name} \u2014 ${def.name}: ${def.tick.dice} rolled ${total}`);
        await damage(token, total, def.tick.type);
      }
      if (def?.tempFromValue && e.value > 0) await setTemp(token, e.value, { quiet: true });
      if (def?.table === "confusion") {
        const d10 = rollDie(10);
        toast(`${st.name} is Confused (d10 = ${d10}): it ${confusionResult(d10, rollDie(4))}`);
      }
    }
  }

  // ---------------- HP ----------------
  async function damage(token, raw, type) {
    token = tokenById(token.id) || token;
    const st = stateOf(token);
    if (!st || !(raw > 0)) return;
    const { amount, note } = adjustDamage(raw, type, st, st.conditions, st.effects);
    const res = takeDamage(st.hp, amount);
    const patch = { hp: res.hp };
    let msg = `${st.name} takes ${amount}${type ? ` ${type}` : ""} damage${note ? ` (${note})` : ""}`;
    // Death Ward: drops to 1 HP instead of 0, once
    const ward = res.dropped ? st.effects.find(e => effectDef(e)?.deathWard) : null;
    if (ward) {
      res.hp.current = 1; res.dropped = false; res.massive = false;
      Object.assign(patch, effectPatch(st, ward.id, false));
      patch.hp = res.hp;
      msg += " \u2014 Death Ward holds: it drops to 1 HP instead.";
    }
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

  async function setTemp(token, amount, { quiet = false } = {}) {
    const st = stateOf(token);
    if (!st || amount < 0) return;
    // Temporary HP doesn't stack: keep the higher value
    if (amount <= (st.hp.temp || 0)) { if (!quiet) toast(`${st.name} keeps its ${st.hp.temp} temporary HP (they don't stack)`); return; }
    await patchState(token, { hp: { ...st.hp, temp: amount } });
  }

  async function toggleCondition(token, name, anchor) {
    const st = stateOf(token);
    const on = !st.conditions.includes(name);
    if (on && conditionImmunities(st).includes(name)) { toast(`${st.name} is immune to ${name}`, "error"); return; }
    if (name === "Grappled") {
      if (on) { const r = anchor?.getBoundingClientRect(); chooseGrappler(token, r?.left ?? 200, r?.bottom ?? 200); }
      else await releaseGrapple(token);
      return;
    }
    if (on && SOURCE_CONDITIONS[name] && ctx.tokens().some(t => t.id !== token.id && isCreature(t))) {
      const r = anchor?.getBoundingClientRect();
      chooseSource(token, name, r?.left ?? 200, r?.bottom ?? 200);
      return;
    }
    const patch = { conditions: withCondition(st.conditions, name, on) };
    if (on && st.concentration && isIncapacitated(patch.conditions)) { patch.concentration = null; toast(`${st.name} loses Concentration (Incapacitated)`); }
    await patchState(token, patch);
    if (on && isIncapacitated(patch.conditions)) for (const t of grappling(token)) { await releaseGrapple(t, { quiet: true }); toast(`${t.name} is freed — ${st.name} is Incapacitated`); }
  }

  // ---------------- Rolls ----------------
  function logRoll(token, label, spec, dice = []) {
    const extra = rollExtraDice(dice);
    if (extra.note) label = `${label} (${extra.note})`;
    const result = computeRoll({ ...spec, modifier: (spec.modifier || 0) + extra.total });
    const name = publicName(token); // the log is shared
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
      const c = { id, type: token.kind, name: publicName(token), dmName: st.name, portraitBase64: ctx.artOf(token) || null, ownerUid: st.ownerUid || null, initiative: null, initMod,
        actionUsed: false, bonusActionUsed: false, reactionUsed: false, movementUsed: false };
      if (token.kind === "monster") {
        const rule = initiativeRule(st.conditions, st.exhaustion, st.effects);
        c.initiative = computeRoll({ sides: 20, count: 1, modifier: (initMod || 0) + rule.penalty, mode: rule.mode }).total;
      }
      added.push(c);
    }
    if (!added.length) { toast("Already in the initiative order"); return; }
    if (combat?.active) await db.combat.set(ctx.campaignId, { combatants: [...existing, ...added] });
    else await db.combat.set(ctx.campaignId, { active: true, round: 1, currentTurnIndex: 0, combatants: added, pendingRollRequest: null, effectsTurn: null });
    toast(`${added.length === 1 ? added[0].dmName || added[0].name : `${added.length} creatures`} added to initiative${combat?.active ? "" : " — combat started (Initiative button or Combat tab)"}`);
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

  // Loot edits always build on the newest copy of the token
  const lootOf = (token) => ({ coins: {}, items: [], hoardThemes: [], ...((tokenById(token.id) || token).loot || {}) });
  const saveLoot = (token, loot) => db.tokens.update(ctx.campaignId, ctx.mapId(), token.id, { loot });
  const coinText = (c) => Object.entries(c).filter(([, v]) => v > 0).map(([k, v]) => `${v.toLocaleString()} ${k.toUpperCase()}`).join(", ") || "nothing";

  async function addCoins(token, coins, what) {
    const loot = lootOf(token);
    const next = { ...loot.coins };
    Object.entries(coins).forEach(([k, v]) => { next[k] = (next[k] || 0) + v; });
    await saveLoot(token, { ...loot, coins: next });
    toast(`${what}: ${coinText(coins)} added`);
  }

  async function addMagicItems(token, n) {
    const loot = lootOf(token);
    const cr = token.stats?.cr;
    const picks = [];
    for (let i = 0; i < n; i++) { const it = rollMagicItem(ctx.ruleset()?.magicItems || [], cr, loot.hoardThemes || []); if (it) picks.push({ ...magicLootEntry(it), source: "rolled" }); }
    if (!picks.length) { toast("No magic items rolled (the table gave 0)"); return; }
    await saveLoot(token, { ...loot, items: [...loot.items, ...picks] });
    toast(`Rolled ${picks.map(p => `${p.name} (${p.rarity})`).join(", ")}`);
  }

  // Any item by name: a catalog magic item or piece of equipment, or something custom
  async function addItemByName(token) {
    const rs = ctx.ruleset() || {};
    const names = [...(rs.magicItems || []).map(m => m.name), ...["weapons", "armor", "gear", "tools", "ammo"].flatMap(g => (rs.equipment?.[g] || []).map(e => e.name))];
    const r = await openDialog({ title: "Add an item to the loot", okLabel: "Add", fields: [
      { name: "name", label: "Item (start typing for the catalog, or write your own)", list: [...new Set(names)].sort() },
      { name: "qty", label: "Quantity", type: "number", value: 1, min: 1 }
    ] });
    if (!r?.name?.trim()) return;
    const loot = lootOf(token);
    const found = findItem(rs, { name: r.name.trim() });
    const qty = Math.max(1, parseInt(r.qty, 10) || 1);
    const entry = found?.kind === "magic" ? { ...magicLootEntry(found.entry), quantity: qty } : { name: found?.entry?.name || r.name.trim(), quantity: qty, catalogId: found?.entry?.id || null };
    await saveLoot(token, { ...loot, items: [...loot.items, { ...entry, source: "added" }] });
  }

  // ---------------- Panel ----------------
  function render(el, token, { onClose, onSize, onToggleHidden, onRemove, onOpenSheet, onControl }) {
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
    const shownName = displayName(token);
    const art = seesAll(token) || revealed(token, "picture") ? ctx.artOf(token) : null;
    head.innerHTML = `
      <div class="portrait-preview sm">${art ? `<img src="${art}">` : `<span>${escapeHtml((shownName || "?")[0].toUpperCase())}</span>`}</div>
      <div class="cp-title">
        <h4>${escapeHtml(shownName)}</h4>
        <div class="cp-badges">
          <span class="badge ${token.kind === "pc" ? "" : "rune"}">${token.kind === "pc" ? "PC" : token.kind === "npc" ? "NPC" : "Monster"}</span>
          ${token.hidden ? '<span class="badge">Hidden</span>' : ""}
          ${st.dead ? '<span class="badge dead">Dead</span>' : ""}
        </div>
      </div>`;
    if (ctx.isDm && token.kind !== "pc") {
      const ed = h("button", { class: "icon-btn", title: "Rename, alias, and what players see" }, "✎");
      ed.addEventListener("click", () => editIdentity(token));
      head.appendChild(ed);
    }
    const close = h("button", { class: "icon-btn cp-close", title: "Close (Esc)" }, "✕");
    close.addEventListener("click", onClose);
    head.appendChild(close);
    el.appendChild(head);

    // The DM sees what the players are shown
    if (ctx.isDm && token.kind !== "pc" && ["name", "picture", "details"].some(k => !revealed(token, k))) {
      const kept = [!revealed(token, "name") && `name (they see “${token.alias || DEFAULT_ALIAS}”)`, !revealed(token, "picture") && "picture", !revealed(token, "details") && "details"].filter(Boolean);
      el.appendChild(h("div", { class: "cp-note" }, `\u{1F576} Kept from players: ${escapeHtml(kept.join(", "))}`));
    }

    const showDetails = seesAll(token) || revealed(token, "details");
    if (monster && showDetails) el.appendChild(h("div", { class: "cp-sub" }, escapeHtml(`${monster.size} ${monster.creatureType}, ${monster.alignment} • CR ${monster.cr} (${monster.crNote ? monster.crNote.replace(/^XP\s*/, "") : `${monster.xp} XP`}) • PB +${monster.pb || 2}`)));

    // Public view for other players: no numbers, just how it looks
    if (!editable) {
      if (!showDetails) { el.appendChild(h("p", { class: "meta" }, "You don't know anything more about it.")); return; }
      const pct = st.hp.max ? st.hp.current / st.hp.max : 1;
      const look = st.dead ? "Dead" : st.hp.current <= 0 ? "Down" : pct <= 0.5 ? "Bloodied" : pct < 1 ? "Wounded" : "Unhurt";
      el.appendChild(h("p", { class: "cp-look" }, look));
      el.appendChild(conditionChips(token, st, false));
      if (st.effects.length) el.appendChild(effectChips(token, st, false));
      if (g) el.appendChild(h("p", { class: "meta" }, `Grappled by ${escapeHtml(displayName(g))}`));
      return;
    }

    // Stats row
    const speed = effectiveSpeed(st.baseSpeed || 0, st.conditions, st.exhaustion, st.effects);
    const walk = token.kind === "monster" && st.baseSpeed ? String(token.stats?.speed || "").replace(/\d+/, speed.ft) : `${speed.ft} ft.`;
    const speedText = speed.why ? `0 ft (${speed.why})` : walk;
    const stats = h("div", { class: "cp-stats" });
    stats.innerHTML = `<div><span class="lbl">AC</span><b>${st.ac}</b></div><div><span class="lbl">Speed</span><b class="${speed.why ? "bad" : ""}">${escapeHtml(speedText)}</b></div>${token.kind === "monster" ? `<div><span class="lbl">Init</span><b>${formatModifier(st.init)}</b></div>` : ""}`;
    if (token.kind === "monster" && ctx.isDm) {
      const acB = stats.querySelector("div b");
      acB.title = "Click to change its base AC"; acB.style.cursor = "pointer";
      acB.addEventListener("click", async () => { const v = await promptDialog("Before status effects.", String(st.baseAc), { title: `Base AC for ${st.name}`, type: "number", min: 0 }); if (v != null && v !== "" && !isNaN(+v)) patchState(token, { ac: parseInt(v, 10) }); });
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
      maxEl.addEventListener("click", async () => {
        const f = token.stats?.hpFormula;
        const v = await promptDialog(f ? `Type "roll" to roll ${f}.` : "", String(st.hp.max), { title: `Max HP for ${st.name}` });
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
      const gn = escapeHtml(displayName(g));
      row.innerHTML = `<b>Grappled by ${gn}</b> — Speed 0; moves with ${gn}. Disadvantage on attacks except against ${gn}. Escape: action, Athletics or Acrobatics vs. the escape DC.${canMoveHeld(g) ? ` Drag this token to move it around ${gn}.` : ""}`;
      if (editable) { const b = h("button", { class: "btn sm ghost" }, "Escape / Release"); b.addEventListener("click", () => releaseGrapple(token)); row.appendChild(b); }
      el.appendChild(row);
    }
    if (held.length) {
      const row = h("div", { class: "cp-note" });
      const extra = held.some(t => !dragFree(token, t));
      row.innerHTML = `<b>Grappling ${held.map(t => escapeHtml(displayName(t))).join(", ")}</b>${extra ? " — each foot moved costs 1 extra foot while dragging." : ""}`;
      if (ctx.isDm) held.forEach(t => { const b = h("button", { class: "btn sm ghost" }, `Release ${t.name}`); b.addEventListener("click", () => releaseGrapple(t)); row.appendChild(b); });
      el.appendChild(row);
    }

    // Conditions
    el.appendChild(section("Conditions", conditionChips(token, st, true), conditionEditor(token, st), "cond"));
    Object.keys(SOURCE_CONDITIONS).forEach(name => {
      const src = st.conditions.includes(name) ? sourceOf(token, name) : null;
      if (src) el.appendChild(h("div", { class: "cp-note" }, name === "Frightened" ? `<b>Frightened of ${escapeHtml(displayName(src))}</b> \u2014 it can't willingly move closer.` : `<b>Charmed by ${escapeHtml(displayName(src))}</b> \u2014 it can't attack them, and they have Advantage on social checks against it.`));
    });
    el.appendChild(section("Status effects", effectChips(token, st, true), effectEditor(token, st), "fx"));
    const notes = defenseNotes([...st.conditions, ...impliedConditions(st.conditions)], st.effects);
    const am = attackMode(st.conditions, st.exhaustion, { effects: st.effects });
    const effects = [];
    if (am.mode !== "normal" || am.penalty || am.dice.length) effects.push(`Its attacks: ${am.mode !== "normal" ? am.mode : "normal"}${am.penalty ? `, ${am.penalty} (Exhaustion)` : ""}${am.dice.map(d => `, ${d.sides < 0 ? "\u2212" : "+"}1d${Math.abs(d.sides)} (${d.name})`).join("")}${am.reasons.length ? ` (${am.reasons.join(", ")})` : ""}`);
    notes.forEach(n => effects.push(n));
    if (isIncapacitated(st.conditions)) effects.push("No actions, Bonus Actions or Reactions");
    if (effects.length) el.appendChild(h("ul", { class: "cp-effects" }, effects.map(e => `<li>${escapeHtml(e)}</li>`).join("")));

    // Defenses
    el.appendChild(section("Defenses", defenseChips(st), defenseEditor(token, st), "def"));

    // Monster rolls
    if (monster && (ctx.isDm || controls(token))) el.appendChild(monsterSheet(token, st, monster));

    if (ctx.isDm) {
      const priv = h("label", { class: "cp-private" });
      const cb = h("input", { type: "checkbox", checked: ui.privateRolls ? "checked" : null });
      cb.addEventListener("change", () => { ui.privateRolls = cb.checked; try { sessionStorage.setItem("gt_vtt_private_rolls", cb.checked ? "1" : "0"); } catch { /* noop */ } });
      priv.appendChild(cb);
      priv.appendChild(document.createTextNode(" Private rolls (only you see them; always on for hidden tokens)"));
      el.appendChild(priv);
    }
    el.appendChild(footer(token, st, { onSize, onToggleHidden, onRemove, onOpenSheet, onControl }));
  }

  // The DM, or the player whose PC is the grappler, can reposition what it holds
  function canMoveHeld(g) {
    return ctx.isDm || (g.kind === "pc" && ctx.charOf(g)?.ownerUid === ctx.user.uid) || controls(g);
  }

  function effectChips(token, st, interactive) {
    const box = h("div", { class: "condition-chips" });
    const bloodied = st.hp.max && st.hp.current > 0 && st.hp.current <= st.hp.max / 2;
    if (!st.effects.length && !bloodied) box.appendChild(h("span", { class: "meta" }, "None"));
    if (bloodied) box.appendChild(h("span", { class: "condition-chip bloodied", title: "Half its Hit Points or fewer" }, "Bloodied"));
    const edit = interactive && canEdit(token);
    st.effects.forEach(e => {
      const def = effectDef(e);
      if (!def) return;
      const left = e.rounds ? ` (${e.rounds})` : "";
      const chip = h("button", { class: `condition-chip fx-${def.tone}`, title: `${def.text}${e.rounds ? `\n${e.rounds} of its turns left` : ""}${edit ? "\n(click to remove)" : ""}` }, `${escapeHtml(def.name)}${left}${edit ? " \u2715" : ""}`);
      if (edit) chip.addEventListener("click", () => toggleEffect(token, e.id));
      box.appendChild(chip);
    });
    return box;
  }

  function effectEditor(token, st) {
    if (!canEdit(token)) return null;
    const box = h("div", {});
    ["Spells", "Actions", "Hazards"].forEach(group => {
      box.appendChild(h("div", { class: "lbl", style: "margin-top:6px;" }, group));
      const grid = h("div", { class: "cp-toggle-grid" });
      STATUS_EFFECTS.filter(e => e.group === group && !e.hideInMenu).forEach(e => {
        const b = h("button", { class: `btn sm ${hasEffect(st.effects, e.id) ? "primary" : ""}`, title: e.text }, e.name);
        b.addEventListener("click", () => toggleEffect(token, e.id));
        grid.appendChild(b);
      });
      box.appendChild(grid);
    });
    const custom = h("button", { class: "btn sm ghost", style: "margin-top:6px;" }, "+ Custom effect\u2026");
    custom.addEventListener("click", () => addCustomEffect(token));
    box.appendChild(custom);
    return box;
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
      const immune = conditionImmunities(st).includes(c);
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
    conc.addEventListener("click", async () => {
      if (st.concentration) { patchState(token, { concentration: null }); return; }
      if (isIncapacitated(st.conditions)) { toast("Can't concentrate while Incapacitated", "error"); return; }
      const name = await promptDialog("", "", { title: "Concentrating on which spell?", placeholder: "e.g. Bless", okLabel: "Start" });
      if (name) patchState(token, { concentration: name.trim() });
    });
    box.appendChild(conc);
    return box;
  }

  function defenseChips(st) {
    const box = h("div", { class: "cp-def" });
    const line = (label, list, cls) => list.length ? `<div><span class="lbl">${label}</span> ${list.map(x => `<span class="def-chip ${cls}">${escapeHtml(x)}</span>`).join("")}</div>` : "";
    const fromFx = (key) => [...new Set(st.effects.flatMap(e => effectDef(e)?.[key] || []))];
    const html = line("Resist", st.resist, "res") + line("Immune", st.immune, "imm") + line("Vulnerable", st.vulnerable, "vul") + line("Condition immune", st.condImmune, "cimm")
      + line("Resist (effects)", fromFx("resist"), "res") + line("Immune (effects)", [...fromFx("immune"), ...fromFx("condImmune")], "imm");
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

  // One collapsible row: a toggle with the name, its roll buttons beside it, the full text below.
  // Open/closed is remembered per creature, so live updates don't fold it back up.
  function accordion(key, title, { tag = "", buttons = [], body = "", startOpen = false } = {}) {
    const wrap = h("div", { class: "cp-entry" });
    const head = h("div", { class: "cp-entry-head" });
    const isOpen = () => ui.open[key] ?? startOpen;
    const toggle = h("button", { class: "cp-entry-toggle", type: "button", "aria-expanded": String(isOpen()) }, `<span class="arrow">${isOpen() ? "▾" : "▸"}</span> <b>${escapeHtml(title)}</b>${tag ? ` <span class="cp-entry-tag">${tag}</span>` : ""}`);
    const content = h("div", { class: "cp-entry-body" }, body);
    content.hidden = !isOpen();
    toggle.addEventListener("click", () => {
      ui.open[key] = !isOpen();
      content.hidden = !ui.open[key];
      toggle.setAttribute("aria-expanded", String(ui.open[key]));
      toggle.querySelector(".arrow").textContent = ui.open[key] ? "▾" : "▸";
    });
    head.appendChild(toggle);
    if (buttons.length) { const btns = h("div", { class: "cp-entry-btns" }); buttons.forEach(b => btns.appendChild(b)); head.appendChild(btns); }
    wrap.appendChild(head);
    wrap.appendChild(content);
    return wrap;
  }

  // Use pips for X/Day abilities and legendary actions (click the next pip to spend one,
  // a spent pip to give it back)
  function pips(total, used, onSet, title) {
    const box = h("span", { class: "cp-pips", title });
    for (let i = 0; i < total; i++) {
      const p = h("button", { type: "button", class: `cp-pip ${i < used ? "used" : ""}`, "aria-label": `${title}: ${i < used ? "spent" : "available"}` });
      p.addEventListener("click", (e) => { e.stopPropagation(); onSet(i < used ? i : i + 1); });
      box.appendChild(p);
    }
    return box;
  }

  // The full monster sheet: abilities with save buttons, rollable skills, senses and the
  // rest of the header, then every trait and action as an accordion with its rolls.
  function monsterSheet(token, st, monster) {
    const wrap = h("div", { class: "cp-section cp-sheet" });
    const s = token.stats || {};
    const sc = monster.abilityScores || {};
    const g = grappledBy(token);
    const key = (k) => `${token.id}:${k}`;

    // Abilities and saving throws (automatic fails / Advantage from conditions and effects)
    const abil = h("div", { class: "cp-abil-grid" });
    ABILITIES.forEach(a => {
      const bonus = monsterSaveBonus(monster, a);
      const rule = saveRule(a, st.conditions, st.exhaustion, st.effects);
      const cell = h("div", { class: "cp-abil-cell" });
      cell.innerHTML = `<span class="lbl">${a.toUpperCase()}</span><b>${sc[a] ?? 10}</b><small>${formatModifier(abilityModifier(sc[a] ?? 10))}</small>`;
      const b = h("button", { class: `btn sm ${rule.autoFail ? "danger" : rule.mode === "advantage" ? "adv" : rule.mode === "disadvantage" ? "dis" : ""}`, title: rule.autoFail ? `Automatically fails (${rule.reason})` : `${a.toUpperCase()} saving throw${rule.reason ? ` — ${rule.mode} (${rule.reason})` : ""}` },
        `Save ${rule.autoFail ? "✖" : formatModifier(bonus + rule.penalty)}`);
      b.addEventListener("click", () => {
        if (rule.autoFail) { toast(`${st.name} automatically fails the ${a.toUpperCase()} save (${rule.reason})`, "error"); return; }
        logRoll(token, `${a.toUpperCase()} save`, { sides: 20, count: 1, modifier: bonus + rule.penalty, mode: rule.mode }, rule.dice);
      });
      cell.appendChild(b);
      abil.appendChild(cell);
    });
    wrap.appendChild(abil);

    // Skills: each one rolls a check
    const skills = parseSkills(monster.skills);
    if (skills.length) {
      const row = h("div", { class: "cp-skills" });
      row.appendChild(h("span", { class: "lbl" }, "Skills"));
      skills.forEach(sk => {
        const ability = (ctx.ruleset()?.skills || []).find(x => x.name.toLowerCase() === sk.name.toLowerCase())?.ability;
        const rule = checkRule(ability, st.conditions, st.exhaustion, st.effects);
        const b = h("button", { class: `btn sm ghost ${rule.mode === "advantage" ? "adv" : rule.mode === "disadvantage" ? "dis" : ""}`, title: rule.reason ? `${rule.mode} (${rule.reason})` : `Roll ${sk.name}` }, `${escapeHtml(sk.name)} ${formatModifier(sk.bonus + rule.penalty)}`);
        b.addEventListener("click", () => logRoll(token, sk.name, { sides: 20, count: 1, modifier: sk.bonus + rule.penalty, mode: rule.mode }, rule.dice));
        row.appendChild(b);
      });
      wrap.appendChild(row);
    }

    const facts = [["HP", `${monster.hpAverage} (${monster.hpFormula})`], ["Initiative", `${formatModifier(monster.initiative ?? 0)} (${10 + (monster.initiative ?? 0)})`], ["Senses", monster.senses], ["Languages", monster.languages || "—"], ["Gear", monster.gear]].filter(([, v]) => v);
    wrap.appendChild(h("div", { class: "cp-facts" }, facts.map(([k, v]) => `<div><span class="lbl">${k}</span> ${escapeHtml(String(v))}</div>`).join("")));
    if (isIncapacitated(st.conditions)) wrap.appendChild(h("div", { class: "cp-note bad" }, "Incapacitated — it can't take actions, Bonus Actions or Reactions."));

    const am = attackMode(st.conditions, st.exhaustion, { effects: st.effects });
    const uses = s.uses || {}, spent = s.spent || {};
    // Buttons for one stat block entry
    function entryButtons(a) {
      const info = actionInfo(a);
      const out = [];
      if (info.hit != null) {
        const hit = h("button", { class: `btn sm ${am.mode === "disadvantage" ? "dis" : am.mode === "advantage" ? "adv" : "primary"}`, title: `Attack roll${am.reasons.length ? ` — ${am.mode} (${am.reasons.join(", ")})` : ""}${g ? `\nGrappled: Disadvantage unless attacking ${displayName(g)} (right-click)` : ""}\nRight-click for Advantage / Disadvantage` },
          `${formatModifier(info.hit + am.penalty)}${am.mode === "advantage" ? " ▲" : am.mode === "disadvantage" ? " ▼" : ""}`);
        const doHit = (mode) => {
          const r = logRoll(token, `${a.name} attack`, { sides: 20, count: 1, modifier: info.hit + am.penalty, mode }, am.dice);
          if (r.isCritHigh) toast(`Critical hit! Use Crit for ${a.name}'s damage.`);
        };
        hit.addEventListener("click", () => doHit(am.mode));
        hit.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const items = [{ label: "Normal", action: () => doHit("normal") }, { label: "Advantage", action: () => doHit("advantage") }, { label: "Disadvantage", action: () => doHit("disadvantage") }];
          if (g) items.unshift({ label: `Against ${displayName(g)} (grappler)`, action: () => doHit(attackMode(st.conditions, st.exhaustion, { vsGrappler: true, effects: st.effects }).mode) });
          showContextMenu(e.clientX, e.clientY, items);
        });
        out.push(hit);
      }
      if (info.save) out.push(h("span", { class: "cp-dc", title: "Targets make this saving throw" }, `DC ${info.save.dc} ${info.save.ability.toUpperCase()}`));
      if (info.recharge && spent[a.name]) {
        // Used up: it comes back on a d6 roll at the start of its turn (or roll now)
        const rr = h("button", { class: "btn sm ghost", title: `Recharges on a ${info.recharge}${info.recharge < 6 ? "–6" : ""} (rolled automatically at the start of its turn)` }, `Recharge ${info.recharge}${info.recharge < 6 ? "–6" : ""}`);
        rr.addEventListener("click", () => rollRecharge(token, a.name, info.recharge));
        out.push(rr);
        return out;
      }
      if (info.damage.length) {
        const dmg = h("button", { class: "btn sm", title: info.recharge ? "Roll damage (marks it as used until it recharges)" : "Roll damage" }, "Dmg");
        dmg.addEventListener("click", () => { rollDamage(token, a); if (info.recharge) patchState(token, { spent: { ...(tokenById(token.id)?.stats?.spent || {}), [a.name]: true } }); });
        out.push(dmg);
        if (info.hit != null) {
          const crit = h("button", { class: "btn sm ghost", title: "Critical hit: double the damage dice" }, "Crit");
          crit.addEventListener("click", () => rollDamage(token, a, true));
          out.push(crit);
        }
      } else if (info.recharge) {
        const use = h("button", { class: "btn sm", title: "Mark as used until it recharges" }, "Use");
        use.addEventListener("click", () => patchState(token, { spent: { ...(tokenById(token.id)?.stats?.spent || {}), [a.name]: true } }));
        out.push(use);
      }
      if (info.perDay) out.push(pips(info.perDay, uses[a.name] || 0, (n) => patchState(token, { uses: { ...(tokenById(token.id)?.stats?.uses || {}), [a.name]: n } }), `${a.name} uses per day`));
      return out;
    }
    const tagFor = (a) => {
      const info = actionInfo(a);
      return info.damage.length ? escapeHtml(info.damage.map(p => `${p.formula} ${p.type}`).join(" + ")) : "";
    };

    const groups = [["traits", "Traits", monster.traits], ["actions", "Actions", monster.actions], ["bonus", "Bonus Actions", monster.bonusActions], ["reactions", "Reactions", monster.reactions], ["legendary", "Legendary Actions", monster.legendaryActions]];
    groups.forEach(([id, title, list]) => {
      if (!list?.length) return;
      const sec = h("div", { class: "cp-sheet-group" });
      const head = h("div", { class: "cp-sheet-group-head" });
      head.appendChild(h("span", { class: "lbl" }, `${title} (${list.length})`));
      if (id === "legendary") {
        // Legendary actions: uses per round, back at the start of its turn
        const total = legendaryUses(monster);
        head.appendChild(pips(total, s.legendaryUsed || 0, (n) => patchState(token, { legendaryUsed: n }), "Legendary action uses this round"));
      }
      sec.appendChild(head);
      if (id === "legendary" && monster.legendaryUses) sec.appendChild(h("p", { class: "cp-sheet-note" }, escapeHtml(monster.legendaryUses)));
      list.forEach(a => sec.appendChild(accordion(key(`${id}:${a.name}`), a.name, { tag: tagFor(a), buttons: entryButtons(a), body: escapeHtml(a.description || "") })));
      wrap.appendChild(sec);
    });
    return wrap;
  }

  async function rollRecharge(token, name, need) {
    const r = rollDie(6);
    const ok = r >= need;
    if (ok) {
      const { [name]: _, ...rest } = tokenById(token.id)?.stats?.spent || {};
      await patchState(token, { spent: rest });
    }
    toast(`${displayName(token)} — ${name}: rolled ${r}, ${ok ? "recharged!" : "not yet"}`);
    return ok;
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
        list.innerHTML = "";
        if (!items.length) list.appendChild(h("div", {}, "No items."));
        items.forEach(i => {
          const row = h("div", { class: "cp-loot-item" });
          const b = h("button", { class: "linkish", type: "button", title: "What this item does" }, `${escapeHtml(i.name)}${i.quantity > 1 ? ` ×${i.quantity}` : ""}`);
          b.addEventListener("click", () => showItemPopover(b, ctx.ruleset(), i));
          row.appendChild(b);
          list.appendChild(row);
        });
        if (coins) list.appendChild(h("div", {}, `Coins: ${coins}`));
        list.appendChild(h("small", {}, "Open the NPC's sheet to hand items over."));
      });
      return box;
    }
    const loot = token.loot;
    if (!loot) {
      const b = h("button", { class: "btn sm primary" }, "Show loot");
      b.addEventListener("click", () => { const m = ctx.monsterOf(token); saveLoot(token, generateLoot(m || {})); });
      box.appendChild(b);
      return box;
    }
    const monster = ctx.monsterOf(token);
    const tags = monster?.treasure || [];
    box.appendChild(h("div", { class: "meta" }, `Monster Manual treasure: ${escapeHtml(tags.join(", ") || "none listed")}`));

    // What it has: click an item for its description
    const list = h("div", { class: "cp-loot-items" });
    if (!loot.items.length) list.appendChild(h("div", { class: "meta" }, "No items yet."));
    loot.items.forEach((it, i) => {
      const row = h("div", { class: "cp-loot-item" });
      if (it.magic) row.appendChild(h("span", { class: `badge rarity-${(it.rarity || "").toLowerCase().split(" (")[0].replace(/\s+/g, "-")}` }, escapeHtml(it.rarity || "Magic")));
      const name = h("button", { class: "linkish", type: "button", title: "What this item does" }, `${escapeHtml(it.name)}${it.quantity > 1 ? ` \u00d7${it.quantity}` : ""}`);
      name.addEventListener("click", () => showItemPopover(name, ctx.ruleset(), it));
      row.appendChild(name);
      if (!loot.sent) {
        const rm = h("button", { class: "icon-btn", type: "button", title: "Take it out of the loot" }, "\u2715");
        rm.addEventListener("click", () => { const l = lootOf(token); saveLoot(token, { ...l, items: l.items.filter((_, j) => j !== i) }); });
        row.appendChild(rm);
      }
      list.appendChild(row);
    });
    box.appendChild(list);

    // Coins: set them directly, or add from the tables below
    const coins = h("div", { class: "cp-coins" });
    ["cp", "sp", "ep", "gp", "pp"].forEach(k => {
      const lab = h("label", {}, k.toUpperCase());
      const inp = h("input", { type: "number", min: "0", value: String(loot.coins?.[k] || 0), "aria-label": `${k.toUpperCase()} in the loot` });
      inp.disabled = !!loot.sent;
      inp.addEventListener("change", () => { const l = lootOf(token); saveLoot(token, { ...l, coins: { ...l.coins, [k]: Math.max(0, parseInt(inp.value, 10) || 0) } }); });
      lab.appendChild(inp);
      coins.appendChild(lab);
    });
    box.appendChild(coins);

    if (loot.sent) { box.appendChild(h("div", { class: "meta" }, "\u2714 Sent to the party.")); return box; }

    // The DMG tables for its CR: the DM decides whether to roll, take the average, or skip
    const t = treasureTier(token.stats?.cr);
    const tables = h("div", { class: "cp-tables" });
    const btn = (label, title, fn) => { const b = h("button", { class: "btn sm ghost", type: "button", title }, label); b.addEventListener("click", fn); return b; };
    tables.appendChild(h("h5", {}, "Individual Treasure"));
    tables.appendChild(h("table", {}, `<tr><th>CR</th><th>Treasure</th><th>Average</th></tr>${INDIVIDUAL_TREASURE.map((r, i) => `<tr class="${i === t ? "here" : ""}"><td>${r.cr}</td><td>${r.text}</td><td>${coinText(r.avg)}</td></tr>`).join("")}`));
    const ind = INDIVIDUAL_TREASURE[t];
    const row1 = h("div", { class: "cp-btn-row" });
    row1.appendChild(btn(`Roll ${ind.text}`, "Roll this CR's Individual Treasure and add it", () => addCoins(token, ind.roll(), "Individual treasure")));
    row1.appendChild(btn(`Average (${coinText(ind.avg)})`, "Add the table's average instead of rolling", () => addCoins(token, ind.avg, "Individual treasure (average)")));
    tables.appendChild(row1);
    tables.appendChild(h("h5", {}, "Treasure Hoard"));
    tables.appendChild(h("p", { class: "meta", style: "margin:0;" }, "For a lair or a creature that hoards (Treasure: Any or a theme). Usually one hoard per encounter or session, not per creature."));
    tables.appendChild(h("table", {}, `<tr><th>CR</th><th>Coins</th><th>Magic items</th></tr>${TREASURE_HOARD.map((r, i) => `<tr class="${i === t ? "here" : ""}"><td>${r.cr}</td><td>${r.text}</td><td>${r.items}</td></tr>`).join("")}`));
    const hoard = TREASURE_HOARD[t];
    const row2 = h("div", { class: "cp-btn-row" });
    row2.appendChild(btn(`Roll ${hoard.text}`, "Roll this CR's hoard coins and add them", () => addCoins(token, hoard.roll(), "Hoard coins")));
    row2.appendChild(btn(`Average (${coinText(hoard.avg)})`, "Add the table's average instead of rolling", () => addCoins(token, hoard.avg, "Hoard coins (average)")));
    row2.appendChild(btn(`Roll ${hoard.items} magic items`, `Rarity by CR${loot.hoardThemes?.length ? `, from the ${loot.hoardThemes.join("/")} theme` : ""}`, () => addMagicItems(token, hoard.rollItems())));
    tables.appendChild(row2);
    box.appendChild(accordion(`${token.id}:loot-tables`, `DMG treasure tables (CR ${token.stats?.cr ?? "?"})`, { body: "", startOpen: true }));
    box.lastChild.querySelector(".cp-entry-body").appendChild(tables);

    const btns = h("div", { class: "cp-btn-row" });
    btns.appendChild(btn("+ Magic item", "One random magic item, rarity by CR", () => addMagicItems(token, 1)));
    btns.appendChild(btn("+ Item\u2026", "Any catalog item, or one of your own", () => addItemByName(token)));
    btns.appendChild(btn("Clear coins", "Set every coin back to 0", async () => { if (await confirmDialog("Set all the coins in this loot back to 0?", { okLabel: "Clear" })) { const l = lootOf(token); saveLoot(token, { ...l, coins: {} }); } }));
    const send = h("button", { class: "btn sm primary", type: "button" }, "Send to party");
    send.addEventListener("click", () => sendLootToParty(token));
    btns.appendChild(send);
    box.appendChild(btns);
    return box;
  }

  function footer(token, st, { onSize, onToggleHidden, onRemove, onOpenSheet, onControl }) {
    const row = h("div", { class: "cp-footer" });
    const who = (token.controllers || []).map(uid => ctx.memberName?.(uid) || "a player");
    if (st && who.length) row.appendChild(h("div", { class: "cp-control-note" }, ctx.isDm ? `Controlled by ${escapeHtml(who.join(", "))}` : controls(token) ? "You control this creature" : `Controlled by ${escapeHtml(who.join(", "))}`));
    if (st && ctx.isDm && onControl && token.kind !== "pc") {
      const ctl = h("button", { class: "btn sm", title: "Let players move and run this creature (summons, companions)" }, "\u{1F91D} Control\u2026");
      ctl.addEventListener("click", () => onControl(token));
      row.appendChild(ctl);
    }
    if (st && ctx.isDm) {
      const ini = h("button", { class: "btn sm", title: "Add to the initiative order (rolls for monsters)" }, "⚔ Initiative");
      ini.addEventListener("click", () => addToInitiative([token]));
      row.appendChild(ini);
      const gr = h("button", { class: "btn sm", title: token.grappledBy ? "End this grapple" : "Pick who grapples this creature" }, token.grappledBy ? "Release" : "Grapple…");
      gr.addEventListener("click", () => token.grappledBy ? releaseGrapple(token) : (conditionImmunities(stateOf(token)).includes("Grappled") ? toast(`${st.name} is immune to Grappled`, "error") : chooseGrappler(token, gr.getBoundingClientRect().left, gr.getBoundingClientRect().bottom)));
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

  return { stateOf, canEdit, controls, displayName, publicName, editIdentity, syncCombatName, render, reconcile, processTurn, startGrapple, releaseGrapple, moveGrappled, chooseGrappler, addToInitiative, toggleCondition, toggleEffect, damage, heal, grappledBy, followOffset, footprint, canMoveHeld, moveBlockedWhy };
}
