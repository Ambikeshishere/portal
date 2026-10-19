/* Firebase ID-token verification — zero dependencies.
   Verifies the RS256 signature against Google's securetoken JWKS, then
   checks issuer, audience, expiry and the email claims. */
const https = require('https');
const crypto = require('crypto');
const config = require('./config');

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let _keys = null;
let _at = 0;

function fetchJson(urlStr) {
  return new Promise((resolve, reject) => {
    try {
      const req = https.get(urlStr, (res) => {
        let buf = '';
        res.on('data', c => { buf += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('Bad JWKS response')); }
        });
      });
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('JWKS fetch timeout')); });
      req.on('error', reject);
    } catch (e) { reject(e); }
  });
}

function b64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

async function getKeys(force) {
  if (!force && _keys && Date.now() - _at < 3600000) return _keys;
  const data = await fetchJson(JWKS_URL);
  _keys = (data && data.keys) || [];
  _at = Date.now();
  return _keys;
}

/** Test hook: inject signing keys instead of fetching Google's JWKS. */
function setKeysForTest(keys) { _keys = keys; _at = Date.now(); }

async function verifyIdToken(idToken) {
  const projectId = String(config.FIREBASE_PROJECT_ID || '');
  if (!projectId) throw new Error('Firebase is not configured on the server (set FIREBASE_PROJECT_ID).');
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Invalid Firebase token.');
  let header;
  try { header = JSON.parse(b64urlDecode(parts[0]).toString('utf8')); } catch (e) { throw new Error('Invalid Firebase token header.'); }
  if (header.alg !== 'RS256') throw new Error('Unsupported token algorithm.');

  let keys = await getKeys();
  let jwk = keys.filter(k => k.kid === header.kid)[0];
  if (!jwk && Date.now() - _at > 60000) {           // key rotated: refetch once
    keys = await getKeys(true);
    jwk = keys.filter(k => k.kid === header.kid)[0];
  }
  if (!jwk) throw new Error('Token signing key not found.');

  let pub;
  try { pub = crypto.createPublicKey({ key: jwk, format: 'jwk' }); } catch (e) { throw new Error('Invalid signing key.'); }
  const signed = Buffer.from(parts[0] + '.' + parts[1]);
  if (!crypto.verify('RSA-SHA256', signed, pub, b64urlDecode(parts[2]))) {
    throw new Error('Invalid Firebase token signature.');
  }

  let payload;
  try { payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8')); } catch (e) { throw new Error('Invalid Firebase token payload.'); }
  const nowSec = Math.floor(Date.now() / 1000);
  if (!payload.exp || Number(payload.exp) < nowSec) throw new Error('Firebase token expired.');
  if (payload.iss !== 'https://securetoken.google.com/' + projectId) throw new Error('Token issuer mismatch.');
  if (String(payload.aud) !== projectId) throw new Error('Token audience mismatch.');
  if (!payload.email) throw new Error('Firebase token has no email.');
  if (payload.email_verified === false || payload.email_verified === 'false') throw new Error('Email is not verified.');

  return {
    email: String(payload.email).trim().toLowerCase(),
    name: String(payload.name || ''),
    picture: String(payload.picture || ''),
    sub: String(payload.sub || '')
  };
}

module.exports = { verifyIdToken, setKeysForTest };
