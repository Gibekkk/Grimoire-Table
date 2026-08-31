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

1. Push this whole folder to a new GitHub repo (root of the repo).
2. Repo **Settings → Pages → Build and deployment → Source**: "Deploy from a branch".
3. Branch `main`, folder `/ (root)`. Save.
4. Live at `https://<username>.github.io/<repo-name>/` shortly after.

Everything uses relative paths and `import.meta.url` for data loading, so a
project sub-path needs no config changes.

**Optional:** `.github/workflows/deploy.yml` (if you added it) obfuscates `js/`
with `javascript-obfuscator` before publishing, deploying via GitHub Actions
instead of the branch method above — use one or the other, not both.

## Data model (Firestore collections)

```
campaigns/{campaignId}
  name, dmUid, dmName, inviteCode, memberUids[], memberNames{uid: name}, partyCurrency{cp,sp,ep,gp,pp}
  campaigns/{campaignId}/log/{entryId}            -- rolls + chat, append-only
  campaigns/{campaignId}/notes/{noteId}           -- DM-only
  campaigns/{campaignId}/partyInventory/{itemId}  -- shared loot pool

characters/{characterId}
  ownerUid, name, classes[{classId, level, subclassId}], speciesId, backgroundId,
  alignment, xp, abilityScores{}, abilityOverrides{}, skillOverrides{}, savingThrowOverrides{},
  skillProficiencies[], skillExpertise[], savingThrowProficiencies[], hp{current,max,temp},
  hitDiceUsed, acAdjustments[], currency{cp,sp,ep,gp,pp}, resourcesUsed{}, weaponMasteries[],
  featChoices{}, spellsPrepared[], spellSlotsUsed{}, pactSlotsUsed, appearance{}, campaignId, notes
  characters/{characterId}/inventory/{itemId}     -- personal items (weapon/armor/ammo/gear)

rules_species/{id}, rules_classes/{id}, rules_backgrounds/{id}, rules_skills/{id},
rules_feats/{id}, rules_spells/{id}, rules_class_features/{id}   -- one doc per entry
rules_meta/alignments   { list: [...] }
rules_meta/equipment    { weapons: [...], armor: [...], ammo: [...], gear: [...] }
```

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

This is a deep v1, not a complete VTT. Deliberately simplified:

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
  total level, rather than summing each class's own Hit Die per level
  (the fully correct multiclass HP rule). Proficiency bonus, spell slots, and
  ability math are all total-level-correct.
- **AC** from armor is formula-driven (base + Dex cap + shield); it doesn't yet
  read a Strength requirement into a Speed penalty.
- Feats beyond Skilled's skill choice don't yet have their own configurable
  sub-options (e.g., Magic Initiate's specific cantrip picks) — track those in
  Notes for now.

The code is modular by design (`js/rules-engine.js` for math, `data/*.json` for
content, one file per sheet tab under `js/sheet/`) so all of the above are
additive, not rewrites.
