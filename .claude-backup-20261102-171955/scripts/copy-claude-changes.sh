#!/usr/bin/env bash
# Copies every file Claude changed in this project into the folder you run it from,
# keeping the same relative paths (js/..., css/..., data/...).
#
# Usage (from the folder you want the files copied into):
#   bash /path/to/grimoire-table/scripts/copy-claude-changes.sh
#
# Any file it would overwrite is first backed up to ./.claude-backup-<timestamp>/.
# This list is kept up to date by Claude whenever it changes more files.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$(pwd)"

FILES=(
  ".gitignore"
  "README.md"
  "firestore.rules"
  "css/style.css"
  "data/monsters.json"
  "data/spells.json"
  "data/classes.json"
  "data/class-features.json"
  "data/class-options.json"
  "data/feats.json"
  "data/species.json"
  "data/backgrounds.json"
  "data/equipment.json"
  "data/languages.json"
  "js/data-loader.js"
  "js/db.js"
  "js/firebase-init.js"
  "js/main.js"
  "js/router.js"
  "js/rules-engine.js"
  "js/monsters.js"
  "js/character-build.js"
  "js/character-sheet.js"
  "js/sheet/sheet-actions.js"
  "js/sheet/sheet-core.js"
  "js/sheet/sheet-description.js"
  "js/sheet/sheet-feats.js"
  "js/sheet/sheet-spells.js"
  "js/sheet/level-up.js"
  "js/views/character-creator-view.js"
  "js/views/campaign-view.js"
  "js/views/campaign/combat-panel.js"
  "js/views/campaign/npc-panel.js"
  "js/views/campaign/vtt-panel.js"
  "js/vtt/vtt-canvas.js"
  "js/vtt/creatures.js"
  "js/vtt/creature-panel.js"
  "scripts/import-rules-data.js"
  "scripts/copy-claude-changes.sh"
  "scripts/rules-build/build.sh"
  "scripts/rules-build/clean.py"
  "scripts/rules-build/textfix.py"
  "scripts/rules-build/canon_spells.py"
  "scripts/rules-build/spells2.py"
  "scripts/rules-build/spells3.py"
  "scripts/rules-build/spells_final.py"
  "scripts/rules-build/classes_def.py"
  "scripts/rules-build/build_classes.py"
  "scripts/rules-build/finalize_features.py"
  "scripts/rules-build/feats.py"
  "scripts/rules-build/feats_final.py"
  "scripts/rules-build/options.py"
  "scripts/rules-build/options2.py"
  "scripts/rules-build/options_patch.py"
  "scripts/rules-build/species_bg.py"
  "scripts/rules-build/equipment.py"
  "js/sheet/sheet-inventory.js"
  "data/magic-items.json"
  "scripts/rules-build/bbox_cols.py"
  "scripts/rules-build/items_final.py"
  "scripts/rules-build/item_themes.py"
  "scripts/rules-build/mm_treasure.py"
  "scripts/rules-build/items_names.py"
  "scripts/rules-build/items_raw.py"
  "scripts/rules-build/subclass_spells.py"
)

if [ "$SRC" = "$DEST" ]; then
  echo "You're inside the source project ($SRC) — nothing to copy. Run this from the folder you want the files copied into."
  exit 1
fi

BACKUP="$DEST/.claude-backup-$(date +%Y%m%d-%H%M%S)"
copied=0
for f in "${FILES[@]}"; do
  if [ ! -f "$SRC/$f" ]; then
    echo "  ! missing in source, skipped: $f"
    continue
  fi
  if [ -f "$DEST/$f" ]; then
    if cmp -s "$SRC/$f" "$DEST/$f"; then
      echo "  = unchanged: $f"
      continue
    fi
    mkdir -p "$BACKUP/$(dirname "$f")"
    cp -p "$DEST/$f" "$BACKUP/$f"
  fi
  mkdir -p "$DEST/$(dirname "$f")"
  cp -p "$SRC/$f" "$DEST/$f"
  echo "  ✓ copied: $f"
  copied=$((copied + 1))
done

echo
echo "Copied $copied file(s) from $SRC into $DEST"
[ -d "$BACKUP" ] && echo "Previous versions of overwritten files are in $BACKUP"
exit 0
