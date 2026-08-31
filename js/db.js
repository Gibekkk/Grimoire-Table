import { isFirebaseConfigured } from "./firebase-config.js";
import { initFirebase, getFirebase } from "./firebase-init.js";

const USE_FIREBASE = isFirebaseConfigured();

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function inviteCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I ambiguity
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// ===========================================================================
// LOCAL DEMO BACKEND — localStorage for persistence, BroadcastChannel so
// multiple open tabs (e.g. "DM" and "Player") see the same data update live.
// ===========================================================================
const LOCAL_PREFIX = "dnd_demo_v1_";
const bc = ("BroadcastChannel" in window) ? new BroadcastChannel("dnd-demo-sync") : null;
const localListeners = new Map(); // key -> Set(callback)

function readTable(name) {
  try { return JSON.parse(localStorage.getItem(LOCAL_PREFIX + name) || "{}"); }
  catch { return {}; }
}
function writeTable(name, obj) {
  localStorage.setItem(LOCAL_PREFIX + name, JSON.stringify(obj));
  notifyLocal(name);
  bc?.postMessage({ table: name });
}
function notifyLocal(name) {
  (localListeners.get(name) || []).forEach(cb => cb());
}
bc?.addEventListener("message", (e) => notifyLocal(e.data.table));

function subscribeTable(name, cb) {
  if (!localListeners.has(name)) localListeners.set(name, new Set());
  localListeners.get(name).add(cb);
  cb(); // fire immediately with current state
  return () => localListeners.get(name)?.delete(cb);
}

const localDb = {
  auth: {
    onChange(cb) {
      const read = () => {
        const raw = localStorage.getItem(LOCAL_PREFIX + "session");
        cb(raw ? JSON.parse(raw) : null);
      };
      read();
      const handler = (e) => { if (e.key === LOCAL_PREFIX + "session") read(); };
      window.addEventListener("storage", handler);
      bc?.addEventListener("message", (e) => { if (e.data.table === "session") read(); });
      return () => window.removeEventListener("storage", handler);
    },
    async signInDemo(displayName) {
      const user = { uid: uid("demo"), displayName, photoURL: null, isDemo: true };
      localStorage.setItem(LOCAL_PREFIX + "session", JSON.stringify(user));
      notifyLocal("session"); bc?.postMessage({ table: "session" });
      return user;
    },
    async signOut() {
      localStorage.removeItem(LOCAL_PREFIX + "session");
      notifyLocal("session"); bc?.postMessage({ table: "session" });
    }
  },

  campaigns: {
    async create({ name, dmUid, dmName }) {
      const campaigns = readTable("campaigns");
      const id = uid("camp");
      campaigns[id] = {
        id, name, dmUid, dmName, inviteCode: inviteCode(),
        memberUids: [dmUid], memberNames: { [dmUid]: dmName },
        createdAt: Date.now()
      };
      writeTable("campaigns", campaigns);
      return id;
    },
    async get(id) { return readTable("campaigns")[id] || null; },
    async join(code, uidVal, displayName) {
      const campaigns = readTable("campaigns");
      const found = Object.values(campaigns).find(c => c.inviteCode === code.toUpperCase());
      if (!found) throw new Error("No campaign found with that invite code.");
      if (!found.memberUids.includes(uidVal)) found.memberUids.push(uidVal);
      found.memberNames[uidVal] = displayName;
      writeTable("campaigns", campaigns);
      return found.id;
    },
    async listMine(uidVal) {
      const campaigns = readTable("campaigns");
      return Object.values(campaigns).filter(c => c.memberUids.includes(uidVal))
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    async update(id, patch) {
      const campaigns = readTable("campaigns");
      if (!campaigns[id]) return;
      Object.assign(campaigns[id], patch);
      writeTable("campaigns", campaigns);
    },
    subscribe(id, cb) {
      return subscribeTable("campaigns", () => cb(readTable("campaigns")[id] || null));
    }
  },

  characters: {
    async create(data) {
      const chars = readTable("characters");
      const id = uid("char");
      chars[id] = { id, createdAt: Date.now(), ...data };
      writeTable("characters", chars);
      return id;
    },
    async update(id, patch) {
      const chars = readTable("characters");
      if (!chars[id]) return;
      Object.assign(chars[id], patch);
      writeTable("characters", chars);
    },
    async get(id) { return readTable("characters")[id] || null; },
    async remove(id) {
      const chars = readTable("characters");
      delete chars[id];
      writeTable("characters", chars);
    },
    async listMine(uidVal) {
      const chars = readTable("characters");
      return Object.values(chars).filter(c => c.ownerUid === uidVal && !c.isNpc)
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    subscribe(id, cb) {
      return subscribeTable("characters", () => cb(readTable("characters")[id] || null));
    },
    subscribeCampaignParty(campaignId, cb) {
      return subscribeTable("characters", () => {
        const chars = Object.values(readTable("characters")).filter(c => c.campaignId === campaignId && !c.isNpc);
        cb(chars);
      });
    },
    subscribeCampaignNpcs(campaignId, cb) {
      return subscribeTable("characters", () => {
        const chars = Object.values(readTable("characters")).filter(c => c.campaignId === campaignId && c.isNpc);
        cb(chars);
      });
    }
  },

  log: {
    async add(campaignId, entry) {
      const logs = readTable("logs");
      logs[campaignId] = logs[campaignId] || [];
      logs[campaignId].push({ id: uid("log"), createdAt: Date.now(), ...entry });
      // keep last 300 entries per campaign
      if (logs[campaignId].length > 300) logs[campaignId] = logs[campaignId].slice(-300);
      writeTable("logs", logs);
    },
    subscribe(campaignId, cb) {
      return subscribeTable("logs", () => cb(readTable("logs")[campaignId] || []));
    }
  },

  inventory: {
    async add(characterId, item) {
      const inv = readTable("inventory");
      inv[characterId] = inv[characterId] || [];
      const id = uid("item");
      inv[characterId].push({ id, createdAt: Date.now(), ...item });
      writeTable("inventory", inv);
      return id;
    },
    async update(characterId, itemId, patch) {
      const inv = readTable("inventory");
      const list = inv[characterId] || [];
      const found = list.find(i => i.id === itemId);
      if (found) Object.assign(found, patch);
      writeTable("inventory", inv);
    },
    async remove(characterId, itemId) {
      const inv = readTable("inventory");
      inv[characterId] = (inv[characterId] || []).filter(i => i.id !== itemId);
      writeTable("inventory", inv);
    },
    subscribe(characterId, cb) {
      return subscribeTable("inventory", () => cb(readTable("inventory")[characterId] || []));
    }
  },

  partyInventory: {
    async add(campaignId, item) {
      const inv = readTable("partyInventory");
      inv[campaignId] = inv[campaignId] || [];
      const id = uid("pitem");
      inv[campaignId].push({ id, createdAt: Date.now(), ...item });
      writeTable("partyInventory", inv);
      return id;
    },
    async update(campaignId, itemId, patch) {
      const inv = readTable("partyInventory");
      const found = (inv[campaignId] || []).find(i => i.id === itemId);
      if (found) Object.assign(found, patch);
      writeTable("partyInventory", inv);
    },
    async remove(campaignId, itemId) {
      const inv = readTable("partyInventory");
      inv[campaignId] = (inv[campaignId] || []).filter(i => i.id !== itemId);
      writeTable("partyInventory", inv);
    },
    subscribe(campaignId, cb) {
      return subscribeTable("partyInventory", () => cb(readTable("partyInventory")[campaignId] || []));
    }
  },

  notes: {
    async add(campaignId, note) {
      const notes = readTable("notes");
      notes[campaignId] = notes[campaignId] || [];
      notes[campaignId].push({ id: uid("note"), createdAt: Date.now(), ...note });
      writeTable("notes", notes);
    },
    async update(campaignId, noteId, patch) {
      const notes = readTable("notes");
      const list = notes[campaignId] || [];
      const found = list.find(n => n.id === noteId);
      if (found) Object.assign(found, patch);
      writeTable("notes", notes);
    },
    async remove(campaignId, noteId) {
      const notes = readTable("notes");
      notes[campaignId] = (notes[campaignId] || []).filter(n => n.id !== noteId);
      writeTable("notes", notes);
    },
    subscribe(campaignId, cb) {
      return subscribeTable("notes", () => cb(readTable("notes")[campaignId] || []));
    }
  },

  maps: {
    async create(campaignId, data) {
      const maps = readTable("maps");
      maps[campaignId] = maps[campaignId] || {};
      const id = uid("map");
      maps[campaignId][id] = { id, createdAt: Date.now(), ...data };
      writeTable("maps", maps);
      return id;
    },
    async update(campaignId, mapId, patch) {
      const maps = readTable("maps");
      if (!maps[campaignId]?.[mapId]) return;
      Object.assign(maps[campaignId][mapId], patch);
      writeTable("maps", maps);
    },
    async remove(campaignId, mapId) {
      const maps = readTable("maps");
      if (maps[campaignId]) delete maps[campaignId][mapId];
      writeTable("maps", maps);
      const tokens = readTable("tokens");
      delete tokens[`${campaignId}:${mapId}`];
      writeTable("tokens", tokens);
    },
    async get(campaignId, mapId) {
      const maps = readTable("maps");
      return maps[campaignId]?.[mapId] || null;
    },
    async listAll(campaignId) {
      const maps = readTable("maps");
      return Object.values(maps[campaignId] || {}).sort((a, b) => a.createdAt - b.createdAt);
    },
    subscribeList(campaignId, cb) {
      return subscribeTable("maps", () => cb(Object.values(readTable("maps")[campaignId] || {}).sort((a, b) => a.createdAt - b.createdAt)));
    },
    subscribe(campaignId, mapId, cb) {
      return subscribeTable("maps", () => cb(readTable("maps")[campaignId]?.[mapId] || null));
    }
  },

  tokens: {
    async add(campaignId, mapId, token) {
      const tokens = readTable("tokens");
      const key = `${campaignId}:${mapId}`;
      tokens[key] = tokens[key] || [];
      const id = uid("tok");
      tokens[key].push({ id, createdAt: Date.now(), ...token });
      writeTable("tokens", tokens);
      return id;
    },
    async update(campaignId, mapId, tokenId, patch) {
      const tokens = readTable("tokens");
      const key = `${campaignId}:${mapId}`;
      const found = (tokens[key] || []).find(t => t.id === tokenId);
      if (found) Object.assign(found, patch);
      writeTable("tokens", tokens);
    },
    async remove(campaignId, mapId, tokenId) {
      const tokens = readTable("tokens");
      const key = `${campaignId}:${mapId}`;
      tokens[key] = (tokens[key] || []).filter(t => t.id !== tokenId);
      writeTable("tokens", tokens);
    },
    subscribe(campaignId, mapId, cb) {
      const key = `${campaignId}:${mapId}`;
      return subscribeTable("tokens", () => cb(readTable("tokens")[key] || []));
    },
    async moveToMap(campaignId, fromMapId, toMapId, token, spawn) {
      await this.remove(campaignId, fromMapId, token.id);
      const { id, createdAt, ...rest } = token;
      return this.add(campaignId, toMapId, { ...rest, x: spawn?.x ?? 2, y: spawn?.y ?? 2 });
    }
  },

  componentFolders: {
    async add(campaignId, data) {
      const folders = readTable("componentFolders");
      folders[campaignId] = folders[campaignId] || [];
      const id = uid("folder");
      folders[campaignId].push({ id, createdAt: Date.now(), ...data });
      writeTable("componentFolders", folders);
      return id;
    },
    async remove(campaignId, folderId) {
      const folders = readTable("componentFolders");
      folders[campaignId] = (folders[campaignId] || []).filter(f => f.id !== folderId);
      writeTable("componentFolders", folders);
    },
    subscribe(campaignId, cb) {
      return subscribeTable("componentFolders", () => cb(readTable("componentFolders")[campaignId] || []));
    }
  },

  componentLibrary: {
    async add(campaignId, data) {
      const lib = readTable("componentLibrary");
      lib[campaignId] = lib[campaignId] || [];
      const id = uid("comp");
      lib[campaignId].push({ id, createdAt: Date.now(), ...data });
      writeTable("componentLibrary", lib);
      return id;
    },
    async update(campaignId, componentId, patch) {
      const lib = readTable("componentLibrary");
      const found = (lib[campaignId] || []).find(c => c.id === componentId);
      if (found) Object.assign(found, patch);
      writeTable("componentLibrary", lib);
    },
    async remove(campaignId, componentId) {
      const lib = readTable("componentLibrary");
      lib[campaignId] = (lib[campaignId] || []).filter(c => c.id !== componentId);
      writeTable("componentLibrary", lib);
    },
    subscribe(campaignId, cb) {
      return subscribeTable("componentLibrary", () => cb(readTable("componentLibrary")[campaignId] || []));
    }
  },

  relationships: {
    async add(campaignId, data) {
      const rel = readTable("relationships");
      rel[campaignId] = rel[campaignId] || [];
      const id = uid("rel");
      rel[campaignId].push({ id, createdAt: Date.now(), ...data });
      writeTable("relationships", rel);
      return id;
    },
    async update(campaignId, relId, patch) {
      const rel = readTable("relationships");
      const found = (rel[campaignId] || []).find(r => r.id === relId);
      if (found) Object.assign(found, patch);
      writeTable("relationships", rel);
    },
    async remove(campaignId, relId) {
      const rel = readTable("relationships");
      rel[campaignId] = (rel[campaignId] || []).filter(r => r.id !== relId);
      writeTable("relationships", rel);
    },
    subscribe(campaignId, cb) {
      return subscribeTable("relationships", () => cb(readTable("relationships")[campaignId] || []));
    }
  },

  combat: {
    async get(campaignId) {
      const combat = readTable("combat");
      return combat[campaignId] || null;
    },
    async set(campaignId, data) {
      const combat = readTable("combat");
      combat[campaignId] = { ...combat[campaignId], ...data };
      writeTable("combat", combat);
    },
    subscribe(campaignId, cb) {
      return subscribeTable("combat", () => cb(readTable("combat")[campaignId] || null));
    }
  }
};

// ===========================================================================
// FIRESTORE BACKEND — mirrors the exact same shape as localDb above.
// ===========================================================================
const firestoreDb = {
  auth: {
    onChange(cb) {
      let unsub = () => {};
      initFirebase().then(({ auth, fx }) => {
        unsub = fx.onAuthStateChanged(auth, (fbUser) => {
          cb(fbUser ? { uid: fbUser.uid, displayName: fbUser.displayName, photoURL: fbUser.photoURL } : null);
        });
      });
      return () => unsub();
    },
    async signInWithGoogle() {
      const { auth, googleProvider, fx } = await initFirebase();
      const result = await fx.signInWithPopup(auth, googleProvider);
      const u = result.user;
      return { uid: u.uid, displayName: u.displayName, photoURL: u.photoURL };
    },
    async signOut() {
      const { auth, fx } = await initFirebase();
      await fx.signOut(auth);
    }
  },

  campaigns: {
    async create({ name, dmUid, dmName }) {
      const { db, fx } = await initFirebase();
      const ref = fx.doc(fx.collection(db, "campaigns"));
      await fx.setDoc(ref, {
        name, dmUid, dmName, inviteCode: inviteCode(),
        memberUids: [dmUid], memberNames: { [dmUid]: dmName },
        createdAt: fx.serverTimestamp()
      });
      return ref.id;
    },
    async get(id) {
      const { db, fx } = await initFirebase();
      const snap = await fx.getDoc(fx.doc(db, "campaigns", id));
      return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    },
    async join(code, uidVal, displayName) {
      const { db, fx } = await initFirebase();
      const q = fx.query(fx.collection(db, "campaigns"), fx.where("inviteCode", "==", code.toUpperCase()));
      const snap = await fx.getDocs(q);
      if (snap.empty) throw new Error("No campaign found with that invite code.");
      const docSnap = snap.docs[0];
      await fx.updateDoc(docSnap.ref, {
        memberUids: fx.arrayUnion(uidVal),
        [`memberNames.${uidVal}`]: displayName
      });
      return docSnap.id;
    },
    async listMine(uidVal) {
      const { db, fx } = await initFirebase();
      const q = fx.query(fx.collection(db, "campaigns"), fx.where("memberUids", "array-contains", uidVal));
      const snap = await fx.getDocs(q);
      return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    },
    async update(id, patch) {
      const { db, fx } = await initFirebase();
      await fx.updateDoc(fx.doc(db, "campaigns", id), patch);
    },
    subscribe(id, cb) {
      let unsub = () => {};
      initFirebase().then(({ db, fx }) => {
        unsub = fx.onSnapshot(fx.doc(db, "campaigns", id), (snap) => {
          cb(snap.exists() ? { id: snap.id, ...snap.data() } : null);
        });
      });
      return () => unsub();
    }
  },

  characters: {
    async create(data) {
      const { db, fx } = await initFirebase();
      const ref = fx.doc(fx.collection(db, "characters"));
      await fx.setDoc(ref, { ...data, createdAt: fx.serverTimestamp() });
      return ref.id;
    },
    async update(id, patch) {
      const { db, fx } = await initFirebase();
      await fx.updateDoc(fx.doc(db, "characters", id), patch);
    },
    async get(id) {
      const { db, fx } = await initFirebase();
      const snap = await fx.getDoc(fx.doc(db, "characters", id));
      return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    },
    async remove(id) {
      const { db, fx } = await initFirebase();
      await fx.deleteDoc(fx.doc(db, "characters", id));
    },
    async listMine(uidVal) {
      const { db, fx } = await initFirebase();
      const q = fx.query(fx.collection(db, "characters"), fx.where("ownerUid", "==", uidVal));
      const snap = await fx.getDocs(q);
      return snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => !c.isNpc)
        .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    },
    subscribe(id, cb) {
      let unsub = () => {};
      initFirebase().then(({ db, fx }) => {
        unsub = fx.onSnapshot(fx.doc(db, "characters", id), (snap) => {
          cb(snap.exists() ? { id: snap.id, ...snap.data() } : null);
        });
      });
      return () => unsub();
    },
    subscribeCampaignParty(campaignId, cb) {
      let unsub = () => {};
      initFirebase().then(({ db, fx }) => {
        const q = fx.query(fx.collection(db, "characters"), fx.where("campaignId", "==", campaignId));
        unsub = fx.onSnapshot(q, (snap) => cb(snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => !c.isNpc)));
      });
      return () => unsub();
    },
    subscribeCampaignNpcs(campaignId, cb) {
      let unsub = () => {};
      initFirebase().then(({ db, fx }) => {
        const q = fx.query(fx.collection(db, "characters"), fx.where("campaignId", "==", campaignId));
        unsub = fx.onSnapshot(q, (snap) => cb(snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => c.isNpc)));
      });
      return () => unsub();
    }
  },

  log: {
    async add(campaignId, entry) {
      const { db, fx } = await initFirebase();
      const ref = fx.collection(db, "campaigns", campaignId, "log");
      await fx.addDoc(ref, { ...entry, createdAt: fx.serverTimestamp() });
    },
    subscribe(campaignId, cb) {
      let unsub = () => {};
      initFirebase().then(({ db, fx }) => {
        const q = fx.query(fx.collection(db, "campaigns", campaignId, "log"), fx.orderBy("createdAt", "asc"), fx.limitToLast(300));
        unsub = fx.onSnapshot(q, (snap) => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
      });
      return () => unsub();
    }
  },

  inventory: {
    async add(characterId, item) {
      const { db, fx } = await initFirebase();
      const ref = fx.collection(db, "characters", characterId, "inventory");
      const docRef = await fx.addDoc(ref, { ...item, createdAt: fx.serverTimestamp() });
      return docRef.id;
    },
    async update(characterId, itemId, patch) {
      const { db, fx } = await initFirebase();
      await fx.updateDoc(fx.doc(db, "characters", characterId, "inventory", itemId), patch);
    },
    async remove(characterId, itemId) {
      const { db, fx } = await initFirebase();
      await fx.deleteDoc(fx.doc(db, "characters", characterId, "inventory", itemId));
    },
    subscribe(characterId, cb) {
      let unsub = () => {};
      initFirebase().then(({ db, fx }) => {
        const q = fx.query(fx.collection(db, "characters", characterId, "inventory"), fx.orderBy("createdAt", "asc"));
        unsub = fx.onSnapshot(q, (snap) => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
      });
      return () => unsub();
    }
  },

  partyInventory: {
    async add(campaignId, item) {
      const { db, fx } = await initFirebase();
      const ref = fx.collection(db, "campaigns", campaignId, "partyInventory");
      const docRef = await fx.addDoc(ref, { ...item, createdAt: fx.serverTimestamp() });
      return docRef.id;
    },
    async update(campaignId, itemId, patch) {
      const { db, fx } = await initFirebase();
      await fx.updateDoc(fx.doc(db, "campaigns", campaignId, "partyInventory", itemId), patch);
    },
    async remove(campaignId, itemId) {
      const { db, fx } = await initFirebase();
      await fx.deleteDoc(fx.doc(db, "campaigns", campaignId, "partyInventory", itemId));
    },
    subscribe(campaignId, cb) {
      let unsub = () => {};
      initFirebase().then(({ db, fx }) => {
        const q = fx.query(fx.collection(db, "campaigns", campaignId, "partyInventory"), fx.orderBy("createdAt", "asc"));
        unsub = fx.onSnapshot(q, (snap) => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
      });
      return () => unsub();
    }
  },

  notes: {
    async add(campaignId, note) {
      const { db, fx } = await initFirebase();
      const ref = fx.collection(db, "campaigns", campaignId, "notes");
      await fx.addDoc(ref, { ...note, createdAt: fx.serverTimestamp() });
    },
    async update(campaignId, noteId, patch) {
      const { db, fx } = await initFirebase();
      await fx.updateDoc(fx.doc(db, "campaigns", campaignId, "notes", noteId), patch);
    },
    async remove(campaignId, noteId) {
      const { db, fx } = await initFirebase();
      await fx.deleteDoc(fx.doc(db, "campaigns", campaignId, "notes", noteId));
    },
    subscribe(campaignId, cb) {
      let unsub = () => {};
      initFirebase().then(({ db, fx }) => {
        const q = fx.query(fx.collection(db, "campaigns", campaignId, "notes"), fx.orderBy("createdAt", "asc"));
        unsub = fx.onSnapshot(q, (snap) => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
      });
      return () => unsub();
    }
  },

  maps: {
    async create(campaignId, data) {
      const { db, fx } = await initFirebase();
      const ref = fx.doc(fx.collection(db, "campaigns", campaignId, "maps"));
      await fx.setDoc(ref, { ...data, createdAt: fx.serverTimestamp() });
      return ref.id;
    },
    async update(campaignId, mapId, patch) {
      const { db, fx } = await initFirebase();
      await fx.updateDoc(fx.doc(db, "campaigns", campaignId, "maps", mapId), patch);
    },
    async remove(campaignId, mapId) {
      const { db, fx } = await initFirebase();
      const tokSnap = await fx.getDocs(fx.collection(db, "campaigns", campaignId, "maps", mapId, "tokens"));
      await Promise.all(tokSnap.docs.map(d => fx.deleteDoc(d.ref)));
      await fx.deleteDoc(fx.doc(db, "campaigns", campaignId, "maps", mapId));
    },
    async get(campaignId, mapId) {
      const { db, fx } = await initFirebase();
      const snap = await fx.getDoc(fx.doc(db, "campaigns", campaignId, "maps", mapId));
      return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    },
    async listAll(campaignId) {
      const { db, fx } = await initFirebase();
      const q = fx.query(fx.collection(db, "campaigns", campaignId, "maps"), fx.orderBy("createdAt", "asc"));
      const snap = await fx.getDocs(q);
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    subscribeList(campaignId, cb) {
      let unsub = () => {};
      initFirebase().then(({ db, fx }) => {
        const q = fx.query(fx.collection(db, "campaigns", campaignId, "maps"), fx.orderBy("createdAt", "asc"));
        unsub = fx.onSnapshot(q, (snap) => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
      });
      return () => unsub();
    },
    subscribe(campaignId, mapId, cb) {
      let unsub = () => {};
      initFirebase().then(({ db, fx }) => {
        unsub = fx.onSnapshot(fx.doc(db, "campaigns", campaignId, "maps", mapId), (snap) => cb(snap.exists() ? { id: snap.id, ...snap.data() } : null));
      });
      return () => unsub();
    }
  },

  tokens: {
    async add(campaignId, mapId, token) {
      const { db, fx } = await initFirebase();
      const ref = fx.doc(fx.collection(db, "campaigns", campaignId, "maps", mapId, "tokens"));
      await fx.setDoc(ref, { ...token, createdAt: fx.serverTimestamp() });
      return ref.id;
    },
    async update(campaignId, mapId, tokenId, patch) {
      const { db, fx } = await initFirebase();
      await fx.updateDoc(fx.doc(db, "campaigns", campaignId, "maps", mapId, "tokens", tokenId), patch);
    },
    async remove(campaignId, mapId, tokenId) {
      const { db, fx } = await initFirebase();
      await fx.deleteDoc(fx.doc(db, "campaigns", campaignId, "maps", mapId, "tokens", tokenId));
    },
    subscribe(campaignId, mapId, cb) {
      let unsub = () => {};
      initFirebase().then(({ db, fx }) => {
        unsub = fx.onSnapshot(fx.collection(db, "campaigns", campaignId, "maps", mapId, "tokens"), (snap) => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
      });
      return () => unsub();
    },
    async moveToMap(campaignId, fromMapId, toMapId, token, spawn) {
      await this.remove(campaignId, fromMapId, token.id);
      const { id, createdAt, ...rest } = token;
      return this.add(campaignId, toMapId, { ...rest, x: spawn?.x ?? 2, y: spawn?.y ?? 2 });
    }
  },

  componentFolders: {
    async add(campaignId, data) {
      const { db, fx } = await initFirebase();
      const ref = fx.doc(fx.collection(db, "campaigns", campaignId, "componentFolders"));
      await fx.setDoc(ref, { ...data, createdAt: fx.serverTimestamp() });
      return ref.id;
    },
    async remove(campaignId, folderId) {
      const { db, fx } = await initFirebase();
      await fx.deleteDoc(fx.doc(db, "campaigns", campaignId, "componentFolders", folderId));
    },
    subscribe(campaignId, cb) {
      let unsub = () => {};
      initFirebase().then(({ db, fx }) => {
        unsub = fx.onSnapshot(fx.collection(db, "campaigns", campaignId, "componentFolders"), (snap) => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
      });
      return () => unsub();
    }
  },

  componentLibrary: {
    async add(campaignId, data) {
      const { db, fx } = await initFirebase();
      const ref = fx.doc(fx.collection(db, "campaigns", campaignId, "componentLibrary"));
      await fx.setDoc(ref, { ...data, createdAt: fx.serverTimestamp() });
      return ref.id;
    },
    async update(campaignId, componentId, patch) {
      const { db, fx } = await initFirebase();
      await fx.updateDoc(fx.doc(db, "campaigns", campaignId, "componentLibrary", componentId), patch);
    },
    async remove(campaignId, componentId) {
      const { db, fx } = await initFirebase();
      await fx.deleteDoc(fx.doc(db, "campaigns", campaignId, "componentLibrary", componentId));
    },
    subscribe(campaignId, cb) {
      let unsub = () => {};
      initFirebase().then(({ db, fx }) => {
        unsub = fx.onSnapshot(fx.collection(db, "campaigns", campaignId, "componentLibrary"), (snap) => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
      });
      return () => unsub();
    }
  },

  relationships: {
    async add(campaignId, data) {
      const { db, fx } = await initFirebase();
      const ref = fx.doc(fx.collection(db, "campaigns", campaignId, "relationships"));
      await fx.setDoc(ref, { ...data, createdAt: fx.serverTimestamp() });
      return ref.id;
    },
    async update(campaignId, relId, patch) {
      const { db, fx } = await initFirebase();
      await fx.updateDoc(fx.doc(db, "campaigns", campaignId, "relationships", relId), patch);
    },
    async remove(campaignId, relId) {
      const { db, fx } = await initFirebase();
      await fx.deleteDoc(fx.doc(db, "campaigns", campaignId, "relationships", relId));
    },
    subscribe(campaignId, cb) {
      let unsub = () => {};
      initFirebase().then(({ db, fx }) => {
        unsub = fx.onSnapshot(fx.collection(db, "campaigns", campaignId, "relationships"), (snap) => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
      });
      return () => unsub();
    }
  },

  combat: {
    async get(campaignId) {
      const { db, fx } = await initFirebase();
      const snap = await fx.getDoc(fx.doc(db, "campaigns", campaignId, "combat", "state"));
      return snap.exists() ? snap.data() : null;
    },
    async set(campaignId, data) {
      const { db, fx } = await initFirebase();
      await fx.setDoc(fx.doc(db, "campaigns", campaignId, "combat", "state"), data, { merge: true });
    },
    subscribe(campaignId, cb) {
      let unsub = () => {};
      initFirebase().then(({ db, fx }) => {
        unsub = fx.onSnapshot(fx.doc(db, "campaigns", campaignId, "combat", "state"), (snap) => cb(snap.exists() ? snap.data() : null));
      });
      return () => unsub();
    }
  }
};

export const db = USE_FIREBASE ? firestoreDb : localDb;
export const backendMode = USE_FIREBASE ? "firebase" : "demo";
