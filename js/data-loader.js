import { isFirebaseConfigured } from "./firebase-config.js";
import { initFirebase } from "./firebase-init.js";

let cache = null;
const BASE = new URL("../data/", import.meta.url);

async function loadJson(name) {
  const res = await fetch(new URL(name, BASE));
  if (!res.ok) throw new Error(`Failed to load data/${name}`);
  return res.json();
}

async function loadLocalRuleset() {
  const [species, classes, backgrounds, skills, alignments, feats, equipment, spells, classFeatures] = await Promise.all([
    loadJson("species.json"), loadJson("classes.json"), loadJson("backgrounds.json"),
    loadJson("skills.json"), loadJson("alignments.json"), loadJson("feats.json"),
    loadJson("equipment.json"), loadJson("spells.json"), loadJson("class-features.json")
  ]);
  return { species, classes, backgrounds, skills, alignments, feats, equipment, spells, classFeatures };
}

async function loadFirestoreCollection(fx, db, name) {
  const snap = await fx.getDocs(fx.collection(db, name));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function loadFirestoreDoc(fx, db, collectionName, docId, fallback) {
  const snap = await fx.getDoc(fx.doc(db, collectionName, docId));
  return snap.exists() ? snap.data() : fallback;
}

// Mirrors scripts/import-rules-data.js's classesForFirestore(): Firestore
// can't store an array that directly contains other arrays, so each
// startingEquipmentItems option array is stored there as { items: [...] }.
// Unwrap it back to a plain array-of-arrays here so every consumer — notably
// `cls.startingEquipmentItems?.[idx]` in character-creator-view.js — sees the
// exact same shape whether the ruleset came from Firestore or from the
// bundled data/*.json (Demo Mode never wraps in the first place).
function unwrapStartingEquipmentItems(classes) {
  return classes.map((cls) => {
    if (!Array.isArray(cls.startingEquipmentItems)) return cls;
    return {
      ...cls,
      startingEquipmentItems: cls.startingEquipmentItems.map((option) =>
        Array.isArray(option) ? option : (option?.items ?? [])
      )
    };
  });
}

async function loadFirestoreRuleset() {
  const { db, fx } = await initFirebase();
  const [species, rawClasses, backgrounds, skills, feats, spells, classFeatures, alignmentsDoc, equipmentDoc] = await Promise.all([
    loadFirestoreCollection(fx, db, "rules_species"),
    loadFirestoreCollection(fx, db, "rules_classes"),
    loadFirestoreCollection(fx, db, "rules_backgrounds"),
    loadFirestoreCollection(fx, db, "rules_skills"),
    loadFirestoreCollection(fx, db, "rules_feats"),
    loadFirestoreCollection(fx, db, "rules_spells"),
    loadFirestoreCollection(fx, db, "rules_class_features"),
    loadFirestoreDoc(fx, db, "rules_meta", "alignments", { list: [] }),
    loadFirestoreDoc(fx, db, "rules_meta", "equipment", { weapons: [], armor: [], ammo: [], gear: [] })
  ]);
  if (species.length === 0 || rawClasses.length === 0) {
    console.warn("Firestore rules_* collections look empty. Run scripts/import-rules-data.js — continuing with bundled data/ JSON for now.");
    return loadLocalRuleset();
  }
  const classes = unwrapStartingEquipmentItems(rawClasses);
  return { species, classes, backgrounds, skills, alignments: alignmentsDoc.list, feats, equipment: equipmentDoc, spells, classFeatures };
}

export async function loadRuleset() {
  if (cache) return cache;
  cache = isFirebaseConfigured() ? await loadFirestoreRuleset() : await loadLocalRuleset();
  return cache;
}

export function findById(list, id) {
  return list.find(x => x.id === id);
}
