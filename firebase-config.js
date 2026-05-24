// ============================================================
//  ElectroVote — Firebase Configuration
//  Replace the values below with your Firebase project details
//  Get these from: Firebase Console → Project Settings → Your Apps
// ============================================================

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDbYzv35Kv9Pc78zecLDR0rn21krgU1xTA",
  authDomain: "nw-voting-machine-af9bb.firebaseapp.com",
  projectId: "nw-voting-machine-af9bb",
  storageBucket: "nw-voting-machine-af9bb.firebasestorage.app",
  messagingSenderId: "276363465302",
  appId: "1:276363465302:web:d6299e3bbc74657200a1f7"
};

// ============================================================
//  Admin password SHA-256 hash
//  Current password: Rinshan@#$009
//  DO NOT store the plain password here — only the hash below
//  To change password: compute SHA-256 of new password and
//  replace the string below. Use: https://emn178.github.io/online-tools/sha256.html
// ============================================================
const ADMIN_PASS_HASH = "b3c4c738e67c42e66e75c4cb00e87f29d18e4e8de8a7b29d56e8f3c22c3a9f1e";
// ^ This is SHA-256 of "Rinshan@#$009"

// ============================================================
//  Platform settings
// ============================================================
const PLATFORM_CONFIG = {
  name: "ElectroVote",
  tagline: "The Online Voting Machine",
  developerIG: "nightwalker.ofc",
  developerName: "Muhammed Rinshan",
  developerClass: "H2B",
  // H2B pre-loaded election ID (leave as-is)
  featuredElectionId: "h2b-election-2026"
};
