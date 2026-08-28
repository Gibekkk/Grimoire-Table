import { db, backendMode } from "./db.js";

let currentUser = null;
const listeners = new Set();

db.auth.onChange((user) => {
  currentUser = user;
  listeners.forEach(cb => cb(user));
});

export function onAuthChange(cb) {
  listeners.add(cb);
  cb(currentUser);
  return () => listeners.delete(cb);
}

export function getCurrentUser() {
  return currentUser;
}

export function isDemoMode() {
  return backendMode === "demo";
}

export async function signOutUser() {
  await db.auth.signOut();
}
