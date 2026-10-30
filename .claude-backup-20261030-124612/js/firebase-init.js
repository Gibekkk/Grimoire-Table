import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js";

const FIREBASE_VERSION = "10.13.0";
const SDK = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;

let _app = null, _auth = null, _db = null, _googleProvider = null, _fx = null;
let _initPromise = null;

// Loads the Firebase SDK from CDN and boots the app. Only called when a real
// project config is present — demo mode never touches the network.
export function initFirebase() {
  if (!isFirebaseConfigured()) return Promise.resolve(null);
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const [{ initializeApp }, authMod, fsMod] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-firestore.js`)
    ]);
    _app = initializeApp(firebaseConfig);
    _auth = authMod.getAuth(_app);
    _googleProvider = new authMod.GoogleAuthProvider();
    _db = fsMod.getFirestore(_app);
    _fx = { ...authMod, ...fsMod };
    return { app: _app, auth: _auth, db: _db, googleProvider: _googleProvider, fx: _fx };
  })();

  return _initPromise;
}

export function getFirebase() {
  return { app: _app, auth: _auth, db: _db, googleProvider: _googleProvider, fx: _fx };
}
