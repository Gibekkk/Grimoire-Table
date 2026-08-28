// Replace these with the values from Firebase console:
// Project settings -> General -> "Your apps" -> Web app -> SDK setup and configuration.
//
// Until you fill these in with real values, the app runs in local Demo Mode
// automatically (see js/db.js) so you can click through every screen first.
export const firebaseConfig = {
  apiKey: "AIzaSyBrbPV8GJtMFvXzYdsH55AzVWipG6H_SUg",
  authDomain: "dnd-app-b08ed.firebaseapp.com",
  projectId: "dnd-app-b08ed",
  storageBucket: "dnd-app-b08ed.firebasestorage.app",
  messagingSenderId: "642119887492",
  appId: "1:642119887492:web:f43f9fa618b6c5e7e930d1"
};

export function isFirebaseConfigured() {
  return firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("YOUR_");
}
