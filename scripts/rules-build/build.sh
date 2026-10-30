#!/usr/bin/env bash
# Rebuilds data/{spells,classes,class-features,class-options,feats,species,backgrounds,
# equipment,languages}.json from the 2024 Player's Handbook PDF in ../../docs/.
#
# Needs: poppler-utils (pdftotext), python3, and /usr/share/dict/words.
# The PDF's OCR text layer is read one column at a time, matched against the
# canonical names in canon_spells.py / classes_def.py, and cleaned up (split
# words re-joined, OCR digit errors in dice fixed). Species, backgrounds and
# equipment are structured by hand in species_bg.py / equipment.py.
#
# Usage:  cd scripts/rules-build && ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
PHB="../../docs/Players Handbook (2024).pdf"
[ -f "$PHB" ] || { echo "Missing $PHB"; exit 1; }
mkdir -p txt
if [ ! -s txt/phb-cols.txt ]; then
  echo "Extracting PHB text (per column)..."
  python3 - "$PHB" <<'PY'
import subprocess, sys, concurrent.futures as cf
P = sys.argv[1]
def page(p):
    cols = []
    for x in (0, 306):
        cols.append(subprocess.run(['pdftotext', '-f', str(p), '-l', str(p), '-x', str(x), '-y', '0', '-W', '306', '-H', '792', P, '-'], capture_output=True, text=True).stdout)
    return f"\n@@PAGE {p}\n" + cols[0] + "\n@@COL\n" + cols[1]
n = int([l for l in subprocess.run(['pdfinfo', P], capture_output=True, text=True).stdout.splitlines() if l.startswith('Pages:')][0].split()[1])
with cf.ThreadPoolExecutor(8) as ex:
    open('txt/phb-cols.txt', 'w').write(''.join(ex.map(page, range(1, n + 1))))
PY
fi
python3 bbox_cols.py "../../docs/Dungeon Master's Guide (2024).pdf" 220 331 txt/dmg-items.txt
[ -s txt/dmg-full.txt ] || pdftotext -layout "../../docs/Dungeon Master's Guide (2024).pdf" txt/dmg-full.txt
for step in species_bg equipment spells2 spells3 spells_final feats_final options options2 options_patch build_classes finalize_features items_raw items_final; do
  echo "== $step"
  python3 "$step.py"
done
echo "Done. Bump DATA_VERSION in js/data-loader.js so browsers fetch the new files."
