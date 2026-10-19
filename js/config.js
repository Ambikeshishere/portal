/* ============================================================
   config.js — front-end configuration
   API_URL  : backend endpoint (same origin in production).
   FIREBASE : Firebase web app config for "Continue with Google".
              Get it from Firebase console → Project settings →
              Your apps → SDK setup → Config (firebaseConfig).
              Leave it empty to hide Google sign-in.
   ============================================================ */
window.PW_CONFIG = {
  API_URL: '/api',

  FIREBASE: {
    apiKey: 'AIzaSyBT0csjQoLFx8-dXVCyMICMQFOObROsJoI',
    authDomain: 'icjhasfd.firebaseapp.com',
    projectId: 'icjhasfd',
    storageBucket: 'icjhasfd.firebasestorage.app',
    messagingSenderId: '143759872982',
    appId: '1:143759872982:web:3aca60d8f0a5e9f8e68a77',
    measurementId: 'G-EF189891TW'
  }
};
