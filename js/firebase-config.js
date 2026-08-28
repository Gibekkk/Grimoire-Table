// Replace these with the values from Firebase console:
// Project settings -> General -> "Your apps" -> Web app -> SDK setup and configuration.
//
// Until you fill these in with real values, the app runs in local Demo Mode
// automatically (see js/db.js) so you can click through every screen first.
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

export function isFirebaseConfigured() {
  return firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("YOUR_");
}
