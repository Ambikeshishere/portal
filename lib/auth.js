const { q, run, sha256, nextId } = require('./db');
const { normEmail, now, addHours, toMs, randomToken, randomOtp } = require('./helpers');
const { cfg, cfgNum, ROLES } = require('./settings');
const { sendMail } = require('./mail');

function addMinutes(d, m) { return new Date(new Date(d).getTime() + m * 60000).toISOString(); }

async function publicUser(u) {
  return {
    userId: u.user_id, name: u.name || '', email: normEmail(u.email),
    phone: u.phone || '', department: u.department || '',
    role: String(u.role || 'USER').toUpperCase(), clusterId: u.cluster_id || '',
    defaultPriority: u.default_priority || 'Medium', reportsTo: u.reports_to || ''
  };
}

async function logActivity(user, event, meta) {
  if (!user) return;
  await run('INSERT INTO activity_log (email, role, event, meta, timestamp) VALUES (?, ?, ?, ?, ?)',
    [normEmail(user.email), String(user.role || '').toUpperCase(), event, meta || '', now()]);
}

/* ------------------------------- signup ------------------------------- */
async function signup(p) {
  const email = normEmail(p.email);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('A valid email address is required.');
  const domain = String(await cfg('ALLOWED_DOMAIN') || '').toLowerCase();
  if (domain && email.split('@')[1] !== domain) throw new Error('Please sign up with your @' + domain + ' email address.');
  const existing = await q('SELECT id FROM users WHERE email = ?', [email]);
  if (existing.length) throw new Error('An account with this email already exists. Please log in.');
  if (!p.name || !String(p.name).trim()) throw new Error('Full name is required.');
  if (!/^[6-9]\d{9}$/.test(String(p.phone || '').trim())) throw new Error('Enter a valid 10-digit mobile number.');
  if (!p.department || !String(p.department).trim()) throw new Error('Department is required.');

  const clusterId = String(p.clusterId || '').trim();
  let cluster = null;
  if (clusterId) {
    const cr = await q('SELECT * FROM clusters WHERE id = ?', [Number(clusterId)]);
    cluster = cr[0] || null;
    if (!cluster) throw new Error('Please choose a valid cluster.');
  }
  const uid = await nextId('U');
  const userId = 'U-' + String(uid).padStart(5, '0');
  const dp = ['Low', 'Medium', 'High'].indexOf(p.defaultPriority) >= 0 ? p.defaultPriority : 'Medium';
  await run('INSERT INTO users (user_id, name, email, phone, department, default_priority, role, cluster_id, reports_to, status, created_at, last_login_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [userId, String(p.name).trim(), email, String(p.phone).trim(), String(p.department).trim(), dp,
     ROLES.USER, cluster ? String(cluster.id) : '', '', 'ACTIVE', now(), '']);
  const user = { email, role: ROLES.USER, name: String(p.name).trim() };
  await logActivity({ email, role: ROLES.USER }, 'SIGNUP', email);
  try { await sendMail({ to: email, tpl: 'welcome', vars: { name: String(p.name).trim() } }); } catch (e) { /* non-fatal */ }
  return { registered: true, email };
}

/* ----------------------------- request OTP ---------------------------- */
async function requestOtp(p) {
  const email = normEmail(p.email);
  if (!email) throw new Error('Please enter your email.');
  const GENERIC = "If this email is registered, we've sent an OTP.";
  const users = await q('SELECT * FROM users WHERE email = ?', [email]);
  const user = users[0] || null;

  const otpRows = await q('SELECT * FROM otp WHERE email = ? ORDER BY id DESC LIMIT 1', [email]);
  const existing = otpRows[0];
  if (existing) {
    const createdMs = toMs(existing.created_at);
    const waitMs = Number(await cfgNum('OTP_RESEND_SEC')) * 1000;
    if (createdMs && Date.now() - createdMs < waitMs) {
      throw new Error('Please wait ' + await cfgNum('OTP_RESEND_SEC') + ' seconds before requesting another OTP.');
    }
  }
  if (!user || String(user.status).toUpperCase() !== 'ACTIVE') return { email, sent: true, message: GENERIC };

  const otp = randomOtp();
  const exp = addMinutes(now(), Number(await cfgNum('OTP_EXPIRY_MIN')));
  await run('DELETE FROM otp WHERE email = ?', [email]);
  await run('INSERT INTO otp (email, code, expires_at, attempts, created_at) VALUES (?,?,?,0,?)',
    [email, sha256(otp + '|' + email), exp, now()]);
  const r = await sendMail({ to: email, tpl: 'otp', vars: { name: user.name, code: otp, expiryMin: await cfgNum('OTP_EXPIRY_MIN') } });
  if (!r || !r.ok) throw new Error('Could not send the OTP email. Please try again.');
  await logActivity(user, 'OTP_REQUEST', email);
  return { email, sent: true, ttlMinutes: Number(await cfgNum('OTP_EXPIRY_MIN')) };
}

/* ------------------------------ verify OTP ----------------------------- */
async function verifyOtp(p) {
  const email = normEmail(p.email);
  const code = String(p.code || '').trim();
  if (!code) throw new Error('Please enter the OTP.');
  const recs = await q('SELECT * FROM otp WHERE email = ? ORDER BY id DESC LIMIT 1', [email]);
  const rec = recs[0];
  if (!rec) throw new Error('No OTP was requested for this email.');
  if (toMs(rec.expires_at) < Date.now()) {
    await run('DELETE FROM otp WHERE email = ?', [email]);
    throw new Error('OTP expired. Please request a new one.');
  }
  const tries = Number(rec.attempts || 0);
  const max = Number(await cfgNum('OTP_MAX_ATTEMPTS'));
  if (tries >= max) {
    await run('DELETE FROM otp WHERE email = ?', [email]);
    throw new Error('Too many incorrect attempts. Please request a new OTP.');
  }
  if (sha256(code + '|' + email) !== String(rec.code)) {
    await run('UPDATE otp SET attempts = ? WHERE id = ?', [tries + 1, rec.id]);
    throw new Error('Incorrect OTP. Attempts left: ' + (max - tries - 1));
  }
  await run('DELETE FROM otp WHERE email = ?', [email]);
  const users = await q('SELECT * FROM users WHERE email = ?', [email]);
  const user = users[0];
  if (!user || String(user.status).toUpperCase() !== 'ACTIVE') throw new Error('Account is not available.');
  await run('UPDATE users SET last_login_at = ? WHERE id = ?', [now(), user.id]);
  const token = await createSession(user);
  await logActivity(user, 'LOGIN', email);
  return { token, user: await publicUser({ ...user, role: String(user.role).toUpperCase() }) };
}

/* ------------------------------ sessions ------------------------------- */
async function createSession(user) {
  const token = randomToken();
  await run('INSERT INTO sessions (token, email, role, expires_at, created_at) VALUES (?,?,?,?,?)',
    [sha256(token), normEmail(user.email), String(user.role || '').toUpperCase(), addHours(now(), Number(await cfgNum('SESSION_HOURS'))), now()]);
  return token;
}

async function requireSession(token) {
  if (!token) throw new Error('SESSION_EXPIRED');
  const recs = await q('SELECT * FROM sessions WHERE token = ?', [sha256(token)]);
  const rec = recs[0];
  if (!rec) throw new Error('SESSION_EXPIRED');
  if (toMs(rec.expires_at) < Date.now()) {
    await run('DELETE FROM sessions WHERE token = ?', [sha256(token)]);
    throw new Error('SESSION_EXPIRED');
  }
  const users = await q('SELECT * FROM users WHERE email = ?', [normEmail(rec.email)]);
  const user = users[0];
  if (!user) throw new Error('SESSION_EXPIRED');
  if (String(user.status).toUpperCase() !== 'ACTIVE') throw new Error('Your account is inactive. Contact the admin.');
  user.Role = String(user.role || '').toUpperCase();
  return user;
}

async function logout(token) {
  if (token) await run('DELETE FROM sessions WHERE token = ?', [sha256(token)]);
  return { loggedOut: true };
}

async function killSessions(email) {
  const e = normEmail(email);
  await run('DELETE FROM sessions WHERE email = ?', [e]);
}

module.exports = { signup, requestOtp, verifyOtp, createSession, requireSession, logout, killSessions, publicUser, logActivity };
