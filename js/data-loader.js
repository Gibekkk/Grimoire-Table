let cache = null;

// Resolve data/ relative to this module so it works from any route depth
// (important for GitHub Pages project sites served from a sub-path).
const BASE = new URL("../data/", import.meta.url);

async function loadJson(name) {
  const res = await fetch(new URL(name, BASE));
  if (!res.ok) throw new Error(`Failed to load data/${name}`);
  return res.json();
}

export async function loadRuleset() {
  if (cache) return cache;
  const [species, classes, backgrounds, skills, alignments] = await Promise.all([
    loadJson("species.json"),
    loadJson("classes.json"),
    loadJson("backgrounds.json"),
    loadJson("skills.json"),
    loadJson("alignments.json")
  ]);
  cache = { species, classes, backgrounds, skills, alignments };
  return cache;
}

export function findById(list, id) {
  return list.find(x => x.id === id);
}
