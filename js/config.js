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
    apiKey: '',
    authDomain: '',
    projectId: '',
    appId: ''
  }
};
