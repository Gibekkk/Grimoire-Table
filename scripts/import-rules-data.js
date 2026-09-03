// One-time (and re-runnable) seed script: pushes the rulebook data in ../data/*.json
// into Firestore so the live app reads classes/species/backgrounds/skills/feats/
// equipment from your database instead of the bundled JSON.
//
// Uses the Firebase ADMIN SDK, not the public web config in js/firebase-config.js.
// The admin SDK authenticates with a service account and bypasses Firestore
// security rules entirely — exactly what a trusted server-side seed script needs,
// and NOT something that should ever ship to the browser.
//
// Setup:
//   1. Firebase console -> Project settings -> Service accounts -> Generate new private key.
//      Save the downloaded file as scripts/service-account.json (already .gitignored).
//   2. cd scripts && npm install
//   3. node import-rules-data.js
//
// Every document is written with `merge: true` and a deterministic ID (the item's
// own "id" field), so running this again after editing data/*.json updates existing
// docs instead of creating duplicates.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import admin from "firebase-admin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const SERVICE_ACCOUNT_PATH = path.join(__dirname, "service-account.json");

async function loadServiceAccount() {
  try {
    const raw = await readFile(SERVICE_ACCOUNT_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`\nCouldn't read ${SERVICE_ACCOUNT_PATH}`);
    console.error("Download a service account key from Firebase console -> Project settings");
    console.error("-> Service accounts -> Generate new private key, and save it at that path.\n");
    process.exit(1);
  }
}

async function loadJson(name) {
  const raw = await readFile(path.join(DATA_DIR, name), "utf-8");
  return JSON.parse(raw);
}

// Writes one Firestore document per array item, keyed by the item's own "id" field.
async function seedCollection(db, collectionName, items) {
  const batchSize = 400; // Firestore batch limit is 500 writes
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = db.batch();
    for (const item of items.slice(i, i + batchSize)) {
      if (!item.id) throw new Error(`Item in ${collectionName} is missing an "id" field: ${JSON.stringify(item)}`);
      batch.set(db.collection(collectionName).doc(item.id), item, { merge: true });
    }
    await batch.commit();
  }
  console.log(`  \u2713 ${collectionName}: ${items.length} document(s)`);
}

async function seedSingleDoc(db, collectionName, docId, data) {
  await db.collection(collectionName).doc(docId).set(data, { merge: true });
  console.log(`  \u2713 ${collectionName}/${docId}`);
}

// Firestore rejects any array that directly contains other arrays
// ("3 INVALID_ARGUMENT: Nested arrays are not allowed"). classes.json's
// `startingEquipmentItems` is exactly that shape: an array of equipment-option
// arrays, e.g. [ [ {catalogId, category, quantity}, ... ], [ ... ] ] for
// "Option A" / "Option B" starting gear.
//
// Firestore *does* allow an array of maps, and a map containing its own array
// field, so we wrap each option array as { items: [...] } before writing.
// js/data-loader.js unwraps this back to a plain array-of-arrays when reading
// from Firestore, so js/views/character-creator-view.js (which does
// `cls.startingEquipmentItems?.[idx]`) never has to know the difference, and
// Demo Mode / local-JSON mode (which reads classes.json directly, already
// array-of-arrays) is completely unaffected.
function classesForFirestore(classes) {
  return classes.map((cls) => {
    if (!Array.isArray(cls.startingEquipmentItems)) return cls;
    return {
      ...cls,
      startingEquipmentItems: cls.startingEquipmentItems.map((option) => ({ items: option }))
    };
  });
}

async function main() {
  const serviceAccount = await loadServiceAccount();
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  console.log(`Seeding Firestore project "${serviceAccount.project_id}"...\n`);

  const [species, classes, backgrounds, skills, feats, spells, classFeatures, monsters, alignments, equipment] = await Promise.all([
    loadJson("species.json"),
    loadJson("classes.json"),
    loadJson("backgrounds.json"),
    loadJson("skills.json"),
    loadJson("feats.json"),
    loadJson("spells.json"),
    loadJson("class-features.json"),
    loadJson("monsters.json"),
    loadJson("alignments.json"),
    loadJson("equipment.json")
  ]);

  await seedCollection(db, "rules_species", species);
  await seedCollection(db, "rules_classes", classesForFirestore(classes));
  await seedCollection(db, "rules_backgrounds", backgrounds);
  await seedCollection(db, "rules_skills", skills);
  await seedCollection(db, "rules_feats", feats);
  await seedCollection(db, "rules_spells", spells);
  await seedCollection(db, "rules_class_features", classFeatures);
  await seedCollection(db, "rules_monsters", monsters);
  await seedSingleDoc(db, "rules_meta", "alignments", { list: alignments });
  await seedSingleDoc(db, "rules_meta", "equipment", equipment);

  console.log("\nDone. The live app will now read rules data from Firestore automatically.");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nImport failed:", err);
  process.exit(1);
});
