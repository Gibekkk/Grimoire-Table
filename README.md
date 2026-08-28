# Grimoire Table

A digital table for D&D 2024 (2024 Player's Handbook) campaigns: build rules-legal
characters, roll physics-based 3D dice with the party in real time, keep a shared
game log, and give the DM a private notes space \u2014 all as a static site you can
host for free on GitHub Pages.

No build step. No framework. Plain HTML/CSS/JS modules + Firebase.

## What's inside

- **Character creator** \u2014 a guided wizard through Class \u2192 Species \u2192 Background \u2192
  Ability Scores \u2192 Skills \u2192 Equipment \u2192 Details \u2192 Review. Every option is pulled from
  `data/*.json`, so it's impossible to build an off-rules character.
- **Character sheet** \u2014 abilities, saves, skills (with proficiency/expertise toggle),
  HP, AC, proficiency bonus, hit dice, and click-to-roll modifiers.
- **Campaigns** \u2014 create a campaign as DM, get a 6-character invite code, players
  join with it and attach one of their characters.
- **Game Table** \u2014 3D physics dice tray (d4/d6/d8/d10/d12/d20/d100 + custom
  notation like `2d6+3`), advantage/disadvantage toggle, and a shared real-time
  log of every roll and chat message.
- **DM Notes** \u2014 a private notes tab visible only to the campaign's DM.
- **Demo Mode** \u2014 if you haven't set up Firebase yet, the app runs entirely on
  `localStorage` + `BroadcastChannel`, so you (and a second browser tab) can click
  through everything immediately.

## 1. Run it locally first (Demo Mode, zero setup)

Any static file server works, e.g.:

```bash
npx serve .
# or: python3 -m http.server 8080
```

Open the printed URL, enter a name, and you're in. Open a second tab and sign in
with a different name to see campaigns/rolls sync live \u2014 that's the same
real-time pattern Firebase will use in production.

## 2. Turn on Firebase (production mode)

Create a project at [console.firebase.google.com](https://console.firebase.google.com),
then toggle on exactly two things:

| Firebase console section | What to enable |
|---|---|
| **Build \u2192 Authentication \u2192 Sign-in method** | Enable the **Google** provider |
| **Build \u2192 Firestore Database** | Click **Create database** (start in production mode) |
| **Authentication \u2192 Settings \u2192 Authorized domains** | Add your GitHub Pages domain, e.g. `yourname.github.io` |

Then, in **Project settings \u2192 General \u2192 Your apps**, add a **Web app** and copy
the generated config object into `js/firebase-config.js`, replacing the
`YOUR_...` placeholders. That's it \u2014 the app detects a real config automatically
and switches out of Demo Mode.

### Firestore security rules

Paste `firestore.rules` (included in this project) into **Firestore Database \u2192
Rules** in the console and publish it. It's a reasonable starting point:
players can only edit their own characters, the DM can adjust HP for the party,
and DM Notes are locked to the DM. Read the comments inside \u2014 a couple of rules
are intentionally permissive for simplicity and worth tightening once your
group is stable.

## 3. Deploy to GitHub Pages

1. Push this whole folder to a new GitHub repo (root of the repo, not a subfolder).
2. Repo **Settings \u2192 Pages \u2192 Build and deployment \u2192 Source**: "Deploy from a branch".
3. Branch: `main`, folder: `/ (root)`. Save.
4. Your site is live at `https://<username>.github.io/<repo-name>/` within a
   couple of minutes.

Everything in this project uses relative paths and `import.meta.url` for data
loading, so it works fine from a project sub-path \u2014 no config changes needed
for step 3.

## Data model (Firestore collections)

```
campaigns/{campaignId}
  name, dmUid, dmName, inviteCode, memberUids[], memberNames{uid: name}
  campaigns/{campaignId}/log/{entryId}      -- rolls + chat, append-only
  campaigns/{campaignId}/notes/{noteId}     -- DM-only

characters/{characterId}
  ownerUid, name, classId, speciesId, backgroundId, alignment, level,
  abilityScores{str,dex,con,int,wis,cha}, skillProficiencies[], skillExpertise[],
  savingThrowProficiencies[], hp{current,max,temp}, campaignId, notes, ...
```

## Replacing the rules data

`data/species.json`, `data/classes.json`, `data/backgrounds.json`,
`data/skills.json`, and `data/alignments.json` are starter data hand-extracted
from the 2024 Player's Handbook (core traits, hit dice, saves, skill lists,
background ability triads, starting equipment). They're intentionally plain,
flat JSON so you can extend them \u2014 e.g. add full subclass feature text, spell
lists, or feats \u2014 without touching any app code. Every view reads through
`js/data-loader.js`, so any shape you add is just there to use.

## How the dice roller stays fair and in sync

Every roll's actual result comes from `crypto.getRandomValues` on the rolling
player's device (see `js/dice/roll-logic.js`) \u2014 never from the physics engine \u2014
so results are trustworthy and reproducible in the log. The 3D tumble you see
(`js/dice/dice-tray.js`, three.js + cannon-es) is a synced *cosmetic* animation:
the roll is broadcast with a shared seed, and every connected client plays the
same-looking tumble before revealing the already-decided number. This avoids
subtle cross-browser physics drift ever changing what a roll "really" was.

## Known limitations / roadmap

This is a strong v1, not a complete VTT. Not yet automated:

- Spellcasting (slots, prepared/known spell lists, save DCs)
- Feat mechanics beyond the name (e.g. Magic Initiate's granted spell)
- Multiclassing, subclass feature text, and full inventory/weight tracking
- Precise AC from specific worn armor (currently estimated from Dex/Con and
  class, with a manual override field)

The code is small and modular on purpose (`js/rules-engine.js` for math,
`data/*.json` for content, one file per view) so these are additive, not
rewrites.
