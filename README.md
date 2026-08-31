# Grimoire Table

A digital table for D&D 2024 (2024 Player's Handbook) campaigns: build rules-legal
characters, roll physics-based 3D dice with the party in real time, manage a shared
party inventory and gold, and give the DM a private notes space — all as a static
site you can host for free on GitHub Pages.

No build step. No framework. Plain HTML/CSS/JS modules + Firebase.

## What's inside

**Character creation & sheet**
- Guided wizard: Class → Species → Background → Ability Scores → Skills → Equipment → Details → Review, pulling every option from `data/*.json` (or Firestore) so it's impossible to build an off-rules character.
- Starting equipment and gold are actually added to your inventory on creation, not just shown as text.
- Tabbed sheet — **Core** (abilities/saves/skills with passive scores), **Actions** (unarmed strike, equipped weapon attacks, toggleable class resources), **Spells** (slot tracking incl. Warlock Pact Magic, prepared-spell list, a spell picker), **Feats & Traits** (origin feat with sub-choices, level-gated species traits, class features, subclass, multiclassing, weapon mastery), **Inventory** (currency, weight/value, containers), **Description**.
- Click AC or HP in the Vitals panel for a full breakdown (armor/Dex/shield/manual adjustments; hit dice and a "spend a Hit Die" heal action).
- Short Rest / Long Rest buttons that recharge the right resources and spell slots automatically.
- Right-click any d20 modifier (ability check, save, skill) for a quick Advantage/Disadvantage roll, or to set a manual override.
- XP tracker with automatic leveling (PHB 2024 thresholds), or set level directly for milestone tables.

**Campaigns**
- DM creates a campaign, gets a 6-character invite code; players join with it and attach a character.
- **Game Table** — 3D physics dice tray (d4–d100, custom dice-count builder, Adv/Dis, free-text notation), shared real-time log.
- **Party** — tabbed view of every party member's full sheet.
- **Party Loot** — a shared inventory and 5-coin currency pool anyone can send items/gold to or take from.
- **DM Notes** — private to the DM.
- Characters can quit a campaign and join another anytime from the sidebar's **⋮** menu (also where character deletion lives).
- **Demo Mode** — no Firebase needed to try everything: data lives in `localStorage` + `BroadcastChannel`, so a second browser tab acts like a second player in real time.

**DM tools**
- **NPCs** — lightweight roster entries (name + portrait; class/species/background are optional, so an NPC can be a fully-statted spellcaster or just "a regular person"). Each NPC gets the same inventory, notes, and stat tools as a player character.
- **Full sheet access** — as DM, you can edit and roll for *any* character in your campaign, not just NPCs. Players can still edit their own characters too.
- **Social** — a relationship web between NPCs and/or player characters, with a \u201312 to +12 affinity score and freeform notes per relationship.
- **Combat tracker** — start combat with any mix of party + NPCs, roll initiative for NPCs directly, or send a roll request that pops up a modal on the right player's screen (wherever they are in the app) showing their bonus. Turn order shows portraits; Action/Bonus Action/Reaction/Movement toggle per turn and auto-clear on End Turn. Attacking and moving on the VTT auto-mark Action/Movement used.
- **Map Workshop** — upload map backgrounds and build a folder-organized library of reusable furniture/props, each optionally flagged as Half/Three-Quarters/Total Cover.
- **VTT** — a grid-based 2D tabletop per map: drag your own token (players) or any token (DM), a ruler in feet, rectangle/circle AoE markers, click a token for an HP/AC popup, right-click (DM) to open a sheet, resize, or move a token to a different map in real time. Cover AC bonuses apply and clear automatically as tokens cross a cover object's footprint. Players toggle their docked mini-sheet from the toolbar; the DM's toggle shows a map switcher instead.
- **No Firebase Storage needed** — portraits, map backgrounds, and component art are compressed client-side and stored as base64 directly in Firestore documents (see `js/image-utils.js`), since Storage typically isn't part of a free-tier setup.



## 1. Run it locally first (Demo Mode, zero setup)

```bash
npx serve .
# or: python3 -m http.server 8080
```

Open the printed URL, enter a name, and you're in. Open a second tab with a
different name to see campaigns/rolls/party loot sync live.

## 2. Turn on Firebase (production mode)

Create a project at [console.firebase.google.com](https://console.firebase.google.com):

| Firebase console section | What to enable |
|---|---|
| **Build → Authentication → Sign-in method** | Enable the **Google** provider |
| **Build → Firestore Database** | **Create database** (production mode) |
| **Authentication → Settings → Authorized domains** | Add your GitHub Pages domain, e.g. `yourname.github.io` |

In **Project settings → General → Your apps**, add a **Web app** and copy the
generated config into `js/firebase-config.js`, replacing the `YOUR_...`
placeholders. The app detects a real config automatically and leaves Demo Mode.

### Firestore security rules

Paste `firestore.rules` into **Firestore Database → Rules** and publish. Players
can only edit their own characters and inventory; the DM can adjust HP/XP for the
party; DM Notes are DM-only; `rules_*` collections are public read-only.

### Seed the rulebook data into Firestore

`js/firebase-config.js` is your **public web config** — safe to commit, but it can
only do what a signed-in user is allowed to do under your security rules. Seeding
reference data (classes, species, spells, etc.) is a trusted server-side action, so
it uses the separate **Admin SDK** instead:

1. Firebase console → **Project settings → Service accounts → Generate new private key**.
   Save the downloaded file as `scripts/service-account.json` (already `.gitignore`d — never commit it).
2. `cd scripts && npm install`
3. `node import-rules-data.js`

This seeds `rules_species`, `rules_classes`, `rules_backgrounds`, `rules_skills`,
`rules_feats`, `rules_spells`, `rules_class_features`, and `rules_meta`
(alignments + the weapons/armor/ammo/gear catalog). It's idempotent — rerun it
anytime after editing `data/*.json` to push updates; documents are keyed by each
item's own `id`, so nothing duplicates.

## 3. Deploy to GitHub Pages

**Option A — GitHub Actions (included, obfuscates `js/` before publishing):**
1. Push this whole folder to a new GitHub repo (root of the repo) — this includes `.github/workflows/deploy.yml`.
2. Repo **Settings → Pages → Build and deployment → Source**: "GitHub Actions".
3. Push to `main`; the workflow copies the site to `dist/`, runs `javascript-obfuscator` on `dist/js`, and deploys `dist/`. `scripts/` (the Admin SDK folder) is excluded from what gets published.

**Option B — plain branch deploy (no obfuscation):**
1. Push this whole folder to a new GitHub repo.
2. Repo **Settings → Pages → Build and deployment → Source**: "Deploy from a branch".
3. Branch `main`, folder `/ (root)`. Save.

Use one option or the other, not both. Either way you'll be live at
`https://<username>.github.io/<repo-name>/` shortly after. Everything uses
relative paths and `import.meta.url` for data loading, so a project sub-path
needs no config changes.

### Migrating to a new Firebase project later

`scripts/` is intentionally separate from the app itself so it's easy to point
at a different project: update `js/firebase-config.js` with the new project's
web config, publish `firestore.rules` in the new project's console, download a
service account key for it into `scripts/service-account.json`, and run
`node import-rules-data.js` again. Live campaign data (maps, NPCs, combat
state, etc.) doesn't need seeding — it starts empty and is created through the
app as you play, same as a fresh project.

## Data model (Firestore collections)

```
campaigns/{campaignId}
  name, dmUid, dmName, inviteCode, memberUids[], memberNames{uid: name}, partyCurrency{cp,sp,ep,gp,pp}
  campaigns/{campaignId}/log/{entryId}            -- rolls + chat, append-only
  campaigns/{campaignId}/notes/{noteId}           -- DM-only
  campaigns/{campaignId}/partyInventory/{itemId}  -- shared loot pool
  campaigns/{campaignId}/relationships/{relId}    -- DM-only social web (affinity between PCs/NPCs)
  campaigns/{campaignId}/combat/state             -- single doc: active, round, currentTurnIndex,
                                                      combatants[], pendingRollRequest
  campaigns/{campaignId}/maps/{mapId}             -- name, backgroundBase64, gridPx, widthPx, heightPx
    campaigns/{campaignId}/maps/{mapId}/tokens/{tokenId}
                                                   -- kind:'pc'|'npc'|'component', refId, x, y, w, h,
                                                      imageBase64, isCover, coverType
  campaigns/{campaignId}/componentFolders/{id}    -- { name }
  campaigns/{campaignId}/componentLibrary/{id}    -- reusable furniture: name, imageBase64, folderId,
                                                      defaultW, defaultH, isCover, coverType

characters/{characterId}
  ownerUid, name, isNpc, portraitBase64, classes[{classId, level, subclassId}], speciesId, backgroundId,
  alignment, xp, abilityScores{}, abilityOverrides{}, skillOverrides{}, savingThrowOverrides{},
  skillProficiencies[], skillExpertise[], savingThrowProficiencies[], hp{current,max,temp},
  hitDiceUsed, acAdjustments[], currency{cp,sp,ep,gp,pp}, resourcesUsed{}, weaponMasteries[],
  featChoices{}, spellsPrepared[], spellSlotsUsed{}, pactSlotsUsed, appearance{}, personality,
  campaignId, currentMapId, notes
  characters/{characterId}/inventory/{itemId}     -- personal items (weapon/armor/ammo/gear)

rules_species/{id}, rules_classes/{id}, rules_backgrounds/{id}, rules_skills/{id},
rules_feats/{id}, rules_spells/{id}, rules_class_features/{id}   -- one doc per entry
rules_meta/alignments   { list: [...] }
rules_meta/equipment    { weapons: [...], armor: [...], ammo: [...], gear: [...] }
```

NPCs live in the same `characters` collection as player characters (with
`isNpc: true` and `ownerUid` set to the DM), which is what lets a DM edit,
roll for, and give inventory to an NPC using the exact same sheet UI a player
gets — no separate NPC system to keep in sync.

## Replacing / extending the rules data

`data/*.json` is starter data hand-extracted from the 2024 Player's Handbook —
core class traits, species traits with level-gating, background triads, the full
weapons/armor/ammunition tables, origin feats, a curated ~40-spell starter list,
and a curated set of class features/resources (Rage, Second Wind, Sneak Attack,
Cunning Action, and similar). It's plain flat JSON specifically so you can extend
it — full spell lists, every subclass's features, more feats — without touching
app code. Edit the JSON, then rerun `node scripts/import-rules-data.js` to push it
to Firestore. Every view reads through `js/data-loader.js`, so any shape you add
is just there to use.

## How the dice roller stays fair and in sync

Every roll's actual result comes from `crypto.getRandomValues` on the rolling
player's device (`js/dice/roll-logic.js`) — never from the physics engine — so
results are trustworthy and reproducible in the log. The 3D tumble
(`js/dice/dice-tray.js`, three.js + cannon-es) is a synced *cosmetic* animation:
the roll broadcasts with a shared seed, and every client plays the same-looking
tumble before revealing the already-decided number.

## Known limitations / roadmap

This is a deep v1 covering character sheets, campaigns, and now DM/VTT tools —
not a full commercial VTT. Deliberately simplified:

- **Spells**: a curated ~40-spell starter list, not the full 2024 spellbook. The
  "known vs. prepared" distinction between classes (Wizard prepares from a
  spellbook, Sorcerer "knows" a fixed list, etc.) is unified into one
  `spellsPrepared` list per character for simplicity.
- **Class features**: a curated set of iconic, mostly level 1–5 features per
  class (enough to demonstrate the resource-tracking system), not the complete
  20-level feature progression for all 12 classes and 48 subclasses. Subclass
  *choice* is tracked; subclass *feature text* isn't yet itemized.
  Weapon Mastery properties are shown for reference; their unique mechanical
  effects (Vex, Sap, Graze, etc.) aren't automated — apply them manually.
- **Multiclass HP**: approximated using your first class's Hit Die scaled by
  total level, rather than summing each class's own Hit Die per level (the
  fully correct multiclass HP rule). Proficiency bonus, spell slots, and
  ability math are all total-level-correct.
- **Action economy**: Attacking and moving on the VTT auto-clear Action/Movement
  for whoever's turn it is; everything else (bonus actions, reactions, using a
  skill, Dash) is a manual toggle, since whether a given skill check "counts"
  as your action is genuinely DM/context-dependent, not something to guess at.
- **Cover** is bounding-box overlap between a token and a cover-flagged
  component on the same map — a practical approximation, not true line-of-sight
  raycasting. It reads correctly for "standing behind the crate" and misreads
  for anything requiring an actual sightline calculation.
- **Token movement sync** writes on drop, not continuously mid-drag — other
  viewers see a token jump to its new spot rather than glide, which avoids
  write-spamming Firestore during a drag.
- **AoE shapes** (rectangle/circle) on the VTT are a local, temporary visual
  aid for the person who drew them — not broadcast to other clients, and don't
  auto-detect which tokens fall inside.
- **Images live in Firestore, not Storage**: portraits/maps/components are
  compressed client-side (`js/image-utils.js`) to fit Firestore's per-document
  size limit. Map backgrounds in particular will look noticeably more
  compressed than a native VTT product with real object storage — that's the
  deliberate trade-off for staying on a Storage-free setup.
- **AC** from armor is formula-driven (base + Dex cap + shield); it doesn't yet
  read a Strength requirement into a Speed penalty.
- Feats beyond Skilled's skill choice don't yet have their own configurable
  sub-options (e.g., Magic Initiate's specific cantrip picks) — track those in
  Notes for now.

The code is modular by design (`js/rules-engine.js` for math, `data/*.json` for
content, one file per sheet tab under `js/sheet/`) so all of the above are
additive, not rewrites.
