import { isFirebaseConfigured } from "./firebase-config.js";
import { initFirebase } from "./firebase-init.js";

// Rules data (classes, species, spells, ...) ships with the site as data/*.json and is
// the source of truth: it's versioned with the code that reads it, served from the
// browser's HTTP cache after the first visit, and needs no Firestore reads. Set
// RULES_SOURCE to "firestore" to read the seeded rules_* collections instead (e.g. to
// hot-edit data in the Firebase console); bundled JSON then fills anything missing.
const RULES_SOURCE = "bundled";
const DATA_VERSION = "2024.4";

let cache = null;
let pending = null;
const BASE = new URL("../data/", import.meta.url);

async function loadJson(name) {
  const res = await fetch(new URL(`${name}?v=${DATA_VERSION}`, BASE));
  if (!res.ok) throw new Error(`Failed to load data/${name}`);
  return res.json();
}

async function loadLocalRuleset() {
  const [species, classes, backgrounds, skills, alignments, feats, equipment, spells, classFeatures, classOptions, languages, monsters, magicItems] = await Promise.all([
    loadJson("species.json"), loadJson("classes.json"), loadJson("backgrounds.json"),
    loadJson("skills.json"), loadJson("alignments.json"), loadJson("feats.json"),
    loadJson("equipment.json"), loadJson("spells.json"), loadJson("class-features.json"),
    loadJson("class-options.json"), loadJson("languages.json"), loadJson("monsters.json"), loadJson("magic-items.json")
  ]);
  return { species, classes, backgrounds, skills, alignments, feats, equipment, spells, classFeatures, classOptions, languages, monsters, magicItems };
}

async function loadFirestoreCollection(fx, db, name) {
  const snap = await fx.getDocs(fx.collection(db, name));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function loadFirestoreDoc(fx, db, collectionName, docId, fallback) {
  const snap = await fx.getDoc(fx.doc(db, collectionName, docId));
  return snap.exists() ? snap.data() : fallback;
}

async function loadFirestoreRuleset() {
  const local = await loadLocalRuleset();
  try {
    const { db, fx } = await initFirebase();
    const [species, classes, backgrounds, skills, feats, spells, classFeatures, monsters, alignmentsDoc, equipmentDoc] = await Promise.all([
      loadFirestoreCollection(fx, db, "rules_species"),
      loadFirestoreCollection(fx, db, "rules_classes"),
      loadFirestoreCollection(fx, db, "rules_backgrounds"),
      loadFirestoreCollection(fx, db, "rules_skills"),
      loadFirestoreCollection(fx, db, "rules_feats"),
      loadFirestoreCollection(fx, db, "rules_spells"),
      loadFirestoreCollection(fx, db, "rules_class_features"),
      loadFirestoreCollection(fx, db, "rules_monsters"),
      loadFirestoreDoc(fx, db, "rules_meta", "alignments", null),
      loadFirestoreDoc(fx, db, "rules_meta", "equipment", null)
    ]);
    const pick = (remote, fallback) => (remote && remote.length ? remote : fallback);
    return {
      ...local,
      species: pick(species, local.species), classes: pick(classes, local.classes),
      backgrounds: pick(backgrounds, local.backgrounds), skills: pick(skills, local.skills),
      feats: pick(feats, local.feats), spells: pick(spells, local.spells),
      classFeatures: pick(classFeatures, local.classFeatures), monsters: pick(monsters, local.monsters),
      alignments: alignmentsDoc?.list?.length ? alignmentsDoc.list : local.alignments,
      equipment: equipmentDoc?.weapons ? equipmentDoc : local.equipment
    };
  } catch (e) {
    console.warn("Couldn't read rules_* from Firestore; using bundled data/ JSON.", e);
    return local;
  }
}

export async function loadRuleset() {
  if (cache) return cache;
  if (!pending) {
    pending = (RULES_SOURCE === "firestore" && isFirebaseConfigured() ? loadFirestoreRuleset() : loadLocalRuleset())
      .then(r => { cache = indexRuleset(r); return cache; })
      .catch(e => { pending = null; throw e; });
  }
  return pending;
}

// Adds lookup maps so hot paths (sheet renders, VTT token popups) don't scan arrays.
function indexRuleset(r) {
  const byId = (list) => new Map((list || []).map(x => [x.id, x]));
  Object.defineProperty(r, "index", {
    enumerable: false,
    value: {
      classes: byId(r.classes), species: byId(r.species), backgrounds: byId(r.backgrounds),
      feats: byId(r.feats), spells: byId(r.spells), skills: byId(r.skills), monsters: byId(r.monsters)
    }
  });
  return r;
}

export function findById(list, id) {
  if (!list || id == null) return undefined;
  return list.find(x => x.id === id);
}
