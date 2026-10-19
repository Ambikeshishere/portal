/* Comprehensive test: exercises every exported function from all lib modules. */
const path = require('path');
const fs = require('fs');
const dbFile = path.join(__dirname, 'coverage.db');
try { fs.unlinkSync(dbFile); } catch (e) {}
process.env.DB_URL = 'file:' + dbFile;
process.env.FIREBASE_PROJECT_ID = 'pw-test-proj';   // must be set before lib/config is loaded

const mail = require('../lib/mail');
const sent = [];
mail.sendMail = async (m) => { sent.push(m); return { ok: true }; };
mail.sendBatch = async (ms) => { ms.forEach(m => sent.push(m)); return { ok: true, data: { sent: ms.length, failed: 0, results: ms.map(m => ({ to: m.to, ok: true })) } }; };

const helpers = require('../lib/helpers');
const db = require('../lib/db');
const settings = require('../lib/settings');
const auth = require('../lib/auth');
const tickets = require('../lib/tickets');
const approvals = require('../lib/approvals');
const reassign = require('../lib/reassign');
const admin = require('../lib/admin');
const jobs = require('../lib/jobs');
const routes = require('../lib/routes');
const firebaseMod = require('../lib/firebase');
const realVerify = firebaseMod.verifyIdToken;   // keep the real verifier before any stubbing

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + label); } else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + label); } };

function grabOtp(email) {
  const m = sent.filter(s => s.tpl === 'otp' && (!email || s.to === email)).pop();
  if (!m) throw new Error('no otp mail captured');
  return m.vars.code;
}

async function loginAs(email) {
  await auth.requestOtp({ email });
  const code = grabOtp(email);
  return await auth.verifyOtp({ email, code });
}

async function main() {
  console.log('\n── helpers ──');
  ok(helpers.now().includes('T'), 'now() returns ISO');
  ok(helpers.randomToken().length === 32, 'randomToken() default 32');
  ok(helpers.randomToken(8).length === 8, 'randomToken(8) length 8');
  ok(/^\d{6}$/.test(helpers.randomOtp()), 'randomOtp() 6 digits');
  ok(helpers.normEmail('  Test@PW.Live ') === 'test@pw.live', 'normEmail');
  ok(helpers.isEmail('a@b.co'), 'isEmail valid');
  ok(!helpers.isEmail('not-an-email'), 'isEmail invalid');
  ok(helpers.toMs('2026-01-01T00:00:00Z') > 0, 'toMs valid');
  ok(helpers.toMs('invalid') === 0, 'toMs invalid');
  const h1 = helpers.addHours('2026-01-01T00:00:00Z', 1);
  ok(h1.includes('01:00:00'), 'addHours +1');
  const d1 = helpers.addDays('2026-01-01T00:00:00Z', 1);
  ok(d1.includes('2026-01-02'), 'addDays +1');
  ok(typeof helpers.fmtDateIST('2026-01-01T00:00:00Z') === 'string', 'fmtDateIST');
  ok(helpers.safeJson('{"a":1}').a === 1, 'safeJson valid');
  ok(helpers.safeJson('bad') === null, 'safeJson invalid');

  console.log('\n── db + setup ──');
  const { ensureSetup } = require('../lib/setup');
  await ensureSetup();
  ok(true, 'ensureSetup() runs');
  const cfgVal = await settings.cfg('ALLOWED_DOMAIN');
  ok(cfgVal === 'pw.live', 'cfg(ALLOWED_DOMAIN)');
  const cfgNumVal = await settings.cfgNum('OTP_EXPIRY_MIN');
  ok(cfgNumVal === 5, 'cfgNum(OTP_EXPIRY_MIN)');
  await settings.setCfg('TEST_KEY', 'hello');
  ok(await settings.cfg('TEST_KEY') === 'hello', 'setCfg + cfg roundtrip');
  const due = await settings.slaDueDate('High', '2026-01-01T00:00:00Z');
  ok(due.includes('2026-01-02'), 'slaDueDate High 24h');
  const n1 = await db.nextId('TESTCTR');
  const n2 = await db.nextId('TESTCTR');
  ok(n2 === n1 + 1, 'nextId increments');

  console.log('\n── auth: signup ──');
  const su1 = await auth.signup({ email: 'user1@pw.live', name: 'User One', phone: '9876543210', department: 'Analytics', clusterId: '' });
  ok(su1.registered, 'signup ok');
  try { await auth.signup({ email: 'bad-email', name: 'X', phone: '9876543210', department: 'D' }); ok(false, 'signup bad email rejected'); } catch (e) { ok(true, 'signup bad email rejected'); }
  try { await auth.signup({ email: 'x@gmail.com', name: 'X', phone: '9876543210', department: 'D' }); ok(false, 'signup wrong domain rejected'); } catch (e) { ok(true, 'signup wrong domain rejected'); }
  try { await auth.signup({ email: 'user1@pw.live', name: 'Dup', phone: '9876543210', department: 'D' }); ok(false, 'signup duplicate rejected'); } catch (e) { ok(true, 'signup duplicate rejected'); }
  try { await auth.signup({ email: 'u2@pw.live', name: '', phone: '9876543210', department: 'D' }); ok(false, 'signup no name rejected'); } catch (e) { ok(true, 'signup no name rejected'); }
  try { await auth.signup({ email: 'u2@pw.live', name: 'U2', phone: '123', department: 'D' }); ok(false, 'signup bad phone rejected'); } catch (e) { ok(true, 'signup bad phone rejected'); }

  console.log('\n── auth: OTP ──');
  const ro1 = await auth.requestOtp({ email: 'user1@pw.live' });
  ok(ro1.sent, 'requestOtp sent');
  try { await auth.requestOtp({ email: 'user1@pw.live' }); ok(false, 'requestOtp cooldown'); } catch (e) { ok(e.message.includes('wait'), 'requestOtp cooldown'); }
  await db.run("DELETE FROM otp WHERE email='user1@pw.live'");
  const ro2 = await auth.requestOtp({ email: 'user1@pw.live' });
  const otpCode = grabOtp('user1@pw.live');
  ok(!JSON.stringify(ro2).match(/\d{6}/), 'OTP not leaked in response');
  try { await auth.verifyOtp({ email: 'user1@pw.live', code: '000000' }); ok(false, 'wrong OTP rejected'); } catch (e) { ok(true, 'wrong OTP rejected'); }
  const vo1 = await auth.verifyOtp({ email: 'user1@pw.live', code: otpCode });
  ok(vo1.token && vo1.user.email === 'user1@pw.live', 'verifyOtp ok');
  const sessTok = vo1.token;

  console.log('\n── auth: session ──');
  const me = await auth.requireSession(sessTok);
  ok(me.email === 'user1@pw.live', 'requireSession ok');
  try { await auth.requireSession('garbage-token'); ok(false, 'requireSession bad token rejected'); } catch (e) { ok(e.message === 'SESSION_EXPIRED', 'requireSession bad token rejected'); }
  const pu = await auth.publicUser({ user_id: 'U-1', name: 'X', email: 'X@PW.LIVE', role: 'user', cluster_id: 'C1' });
  ok(pu.email === 'x@pw.live' && pu.role === 'USER', 'publicUser normalizes');
  await auth.logActivity({ email: 'user1@pw.live', role: 'USER' }, 'TEST', 'meta');
  ok(true, 'logActivity runs');
  await auth.killSessions('user1@pw.live');
  try { await auth.requireSession(sessTok); ok(false, 'killSessions invalidates'); } catch (e) { ok(true, 'killSessions invalidates'); }
  const vo2 = await loginAs('user1@pw.live');
  const userTok = vo2.token;
  const lo = await auth.logout(userTok);
  ok(lo.loggedOut, 'logout ok');
  try { await auth.requireSession(userTok); ok(false, 'logout invalidates session'); } catch (e) { ok(true, 'logout invalidates session'); }
  const userTok2 = (await loginAs('user1@pw.live')).token;

  console.log('\n── admin: clusters + users ──');
  const adminTok = (await loginAs('ambikesh.srivastava@pw.live')).token;
  const cl1 = await admin.saveCluster({ email: 'ambikesh.srivastava@pw.live', role: 'ADMIN' }, { cluster: { name: 'North', cbaEmail: 'cba.n@pw.live', status: 'ACTIVE' } });
  ok(cl1.created, 'saveCluster create');
  const clId = cl1.clusterId;
  const clUpd = await admin.saveCluster({ email: 'ambikesh.srivastava@pw.live', role: 'ADMIN' }, { cluster: { clusterId: clId, name: 'North Zone', cbaEmail: 'cba.n@pw.live', status: 'ACTIVE' } });
  ok(clUpd.updated, 'saveCluster update');
  try { await admin.saveCluster({ email: 'ambikesh.srivastava@pw.live', role: 'ADMIN' }, { cluster: { name: '' } }); ok(false, 'saveCluster no name rejected'); } catch (e) { ok(true, 'saveCluster no name rejected'); }
  const listCl = await admin.listClusters();
  ok(listCl.some(c => c.clusterId === clId), 'listClusters contains new');
  const pubCl = await admin.publicClusters();
  ok(pubCl.length >= 1, 'publicClusters non-empty');

  await admin.saveUser({ email: 'ambikesh.srivastava@pw.live', role: 'ADMIN' }, { user: { email: 'cba.n@pw.live', name: 'CBA North', role: 'CBA', clusterId: clId, status: 'ACTIVE' } });
  await admin.saveUser({ email: 'ambikesh.srivastava@pw.live', role: 'ADMIN' }, { user: { email: 'an1@pw.live', name: 'Analyst One', role: 'ANALYST', clusterId: clId, status: 'ACTIVE' } });
  await admin.saveUser({ email: 'ambikesh.srivastava@pw.live', role: 'ADMIN' }, { user: { email: 'an2@pw.live', name: 'Analyst Two', role: 'ANALYST', clusterId: clId, status: 'ACTIVE' } });
  await admin.saveUser({ email: 'ambikesh.srivastava@pw.live', role: 'ADMIN' }, { user: { email: 'emp1@pw.live', name: 'Emp One', role: 'USER', clusterId: clId, status: 'ACTIVE' } });
  const lu = await admin.listUsers();
  ok(lu.length >= 5, 'listUsers count');
  try { await admin.saveUser({ role: 'ADMIN' }, { user: { email: 'x@pw.live', role: 'BOGUS' } }); ok(false, 'saveUser invalid role rejected'); } catch (e) { ok(true, 'saveUser invalid role rejected'); }
  const updU = await admin.saveUser({ email: 'ambikesh.srivastava@pw.live', role: 'ADMIN' }, { user: { email: 'emp1@pw.live', name: 'Emp One Updated', role: 'USER', clusterId: clId, status: 'ACTIVE' } });
  ok(updU.updated, 'saveUser update');

  console.log('\n── admin: analysts ──');
  const cbaTok = (await loginAs('cba.n@pw.live')).token;
  const an1Tok = (await loginAs('an1@pw.live')).token;
  const an2Tok = (await loginAs('an2@pw.live')).token;
  const empTok = (await loginAs('emp1@pw.live')).token;
  const ca = await admin.clusterAnalysts({ email: 'cba.n@pw.live', role: 'CBA', cluster_id: clId });
  ok(ca.length === 2, 'clusterAnalysts=2');
  const sAn = await admin.saveAnalyst({ email: 'cba.n@pw.live', role: 'CBA', cluster_id: clId }, { analyst: { email: 'an3@pw.live', name: 'Analyst Three', clusterId: clId } });
  ok(sAn.created, 'saveAnalyst create');
  const sAnUpd = await admin.saveAnalyst({ email: 'ambikesh.srivastava@pw.live', role: 'ADMIN', cluster_id: clId }, { analyst: { email: 'an3@pw.live', name: 'Analyst Three Updated' } });
  ok(sAnUpd.updated, 'saveAnalyst update');
  try { await admin.saveAnalyst({ email: 'cba.n@pw.live', role: 'CBA', cluster_id: clId }, { analyst: { email: 'nonexistent@pw.live', name: '' } }); ok(false, 'saveAnalyst no name rejected'); } catch (e) { ok(true, 'saveAnalyst no name rejected'); }
  const rmAn = await admin.removeAnalyst({ email: 'ambikesh.srivastava@pw.live', role: 'ADMIN' }, { email: 'an3@pw.live' });
  ok(rmAn.removed, 'removeAnalyst');
  try { await admin.removeAnalyst({ role: 'ADMIN' }, { email: 'not-an-analyst@pw.live' }); ok(false, 'removeAnalyst not found'); } catch (e) { ok(true, 'removeAnalyst not found'); }

  console.log('\n── firebase: ID-token verification ──');
  const cryptoMod = require('crypto');
  const kp = cryptoMod.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const testJwk = Object.assign({}, kp.publicKey.export({ format: 'jwk' }), { kid: 'test-key', alg: 'RS256', use: 'sig' });
  firebaseMod.setKeysForTest([testJwk]);
  const b64u = (s) => Buffer.from(s).toString('base64url');
  const makeJwt = (payload, hdr) => {
    const h = b64u(JSON.stringify(Object.assign({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }, hdr || {})));
    const b = b64u(JSON.stringify(payload));
    const sig = cryptoMod.sign('RSA-SHA256', Buffer.from(h + '.' + b), kp.privateKey).toString('base64url');
    return h + '.' + b + '.' + sig;
  };
  const baseClaims = () => ({
    iss: 'https://securetoken.google.com/pw-test-proj', aud: 'pw-test-proj',
    sub: 'google-oauth2|123', email: 'token.user@pw.live', email_verified: true,
    name: 'Token User', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600
  });
  const vGood = await realVerify(makeJwt(baseClaims()));
  ok(vGood.email === 'token.user@pw.live' && vGood.name === 'Token User', 'verifyIdToken valid token');
  try { await realVerify('not.a.jwt'); ok(false, 'malformed token rejected'); } catch (e) { ok(true, 'malformed token rejected'); }
  try { await realVerify(makeJwt(baseClaims(), { alg: 'HS256' })); ok(false, 'non-RS256 rejected'); } catch (e) { ok(e.message.includes('algorithm'), 'non-RS256 rejected'); }
  try { await realVerify(makeJwt(Object.assign(baseClaims(), { exp: Math.floor(Date.now() / 1000) - 10 }))); ok(false, 'expired token rejected'); } catch (e) { ok(e.message.includes('expired'), 'expired token rejected'); }
  try { await realVerify(makeJwt(Object.assign(baseClaims(), { aud: 'other-proj' }))); ok(false, 'wrong audience rejected'); } catch (e) { ok(e.message.includes('audience'), 'wrong audience rejected'); }
  try { await realVerify(makeJwt(Object.assign(baseClaims(), { iss: 'https://securetoken.google.com/other' }))); ok(false, 'wrong issuer rejected'); } catch (e) { ok(e.message.includes('issuer'), 'wrong issuer rejected'); }
  try { await realVerify(makeJwt(Object.assign(baseClaims(), { email_verified: false }))); ok(false, 'unverified email rejected'); } catch (e) { ok(e.message.includes('verified'), 'unverified email rejected'); }
  try { await realVerify(makeJwt(Object.assign(baseClaims(), { email: '' }))); ok(false, 'no email rejected'); } catch (e) { ok(e.message.includes('email'), 'no email rejected'); }
  try { await realVerify(makeJwt(baseClaims(), { kid: 'unknown-kid' })); ok(false, 'unknown kid rejected'); } catch (e) { ok(e.message.includes('key not found'), 'unknown kid rejected'); }
  const forgedParts = makeJwt(baseClaims()).split('.');
  forgedParts[1] = b64u(JSON.stringify(Object.assign(baseClaims(), { email: 'forged@pw.live' })));
  try { await realVerify(forgedParts.join('.')); ok(false, 'tampered payload rejected'); } catch (e) { ok(e.message.includes('signature'), 'tampered payload rejected'); }
  const cfgObj = require('../lib/config');
  const savedProj = cfgObj.FIREBASE_PROJECT_ID;
  cfgObj.FIREBASE_PROJECT_ID = '';
  try { await realVerify(makeJwt(baseClaims())); ok(false, 'missing project id rejected'); } catch (e) { ok(e.message.includes('not configured'), 'missing project id rejected'); }
  cfgObj.FIREBASE_PROJECT_ID = savedProj;

  // From here on, stub the verifier (no network in tests): idToken 'fb:<email>' → that email.
  firebaseMod.verifyIdToken = async (tok) => {
    const t = String(tok || '');
    if (t.startsWith('fb:')) return { email: t.slice(3), name: 'Stub Google User', picture: '', sub: 'stub-sub' };
    throw new Error('Invalid Firebase token.');
  };

  console.log('\n── auth: loginWithFirebase ──');
  const fb1 = await auth.loginWithFirebase({ idToken: 'fb:newuser@pw.live' });
  ok(fb1.provisioned === true && fb1.user.role === 'USER' && fb1.token, 'unknown email auto-provisioned as USER');
  ok(/^U-\d{5}$/.test(fb1.user.userId), 'provisioned user got U-##### id');
  const fbSess = await auth.requireSession(fb1.token);
  ok(fbSess.email === 'newuser@pw.live', 'firebase session token works');
  ok(sent.some(s => s.tpl === 'welcome' && s.to === 'newuser@pw.live'), 'welcome mail for provisioned user');
  const fb2 = await auth.loginWithFirebase({ idToken: 'fb:newuser@pw.live' });
  ok(fb2.provisioned === false && fb2.user.userId === fb1.user.userId, 'relogin does not re-provision');
  const fbAn = await auth.loginWithFirebase({ idToken: 'fb:an1@pw.live' });
  ok(fbAn.user.role === 'ANALYST' && !fbAn.provisioned, 'existing ANALYST keeps role');
  const fbAdm = await auth.loginWithFirebase({ idToken: 'fb:ambikesh.srivastava@pw.live' });
  ok(fbAdm.user.role === 'ADMIN' && !fbAdm.provisioned, 'existing ADMIN keeps role');
  try { await auth.loginWithFirebase({ idToken: 'fb:someone@gmail.com' }); ok(false, 'foreign domain rejected'); } catch (e) { ok(e.message.includes('pw.live'), 'foreign domain rejected'); }
  try { await auth.loginWithFirebase({ idToken: 'garbage' }); ok(false, 'bad token rejected'); } catch (e) { ok(e.message.includes('Invalid'), 'bad token rejected'); }
  try { await auth.loginWithFirebase({}); ok(false, 'missing token rejected'); } catch (e) { ok(true, 'missing token rejected'); }
  await db.run("UPDATE users SET status='INACTIVE' WHERE email='emp1@pw.live'");
  try { await auth.loginWithFirebase({ idToken: 'fb:emp1@pw.live' }); ok(false, 'inactive user rejected'); } catch (e) { ok(e.message.includes('inactive'), 'inactive user rejected'); }
  await db.run("UPDATE users SET status='ACTIVE' WHERE email='emp1@pw.live'");
  const fbRoute = await routes.handle({ api: 'loginWithFirebase', payload: { idToken: 'fb:newuser@pw.live' } });
  ok(fbRoute.ok && fbRoute.data.token && fbRoute.data.user.email === 'newuser@pw.live', 'loginWithFirebase exposed in PUBLIC_API');
  // restore the real verifier for anything that might use it later
  firebaseMod.verifyIdToken = realVerify;

  console.log('\n── tickets: create + assign ──');
  const ct1 = await tickets.create({ ...vo2.user, email: 'user1@pw.live', role: 'USER', cluster_id: clId, name: 'User One', phone: '9876543210', department: 'Analytics', Role: 'USER' }, { title: 'Fix dashboard', description: 'charts broken', priority: 'High', category: 'Data' });
  ok(ct1.ticketId && ct1.status === 'NEW', 'create ticket NEW');
  const tid1 = ct1.ticketId;
  const dup = await tickets.create({ ...vo2.user, email: 'user1@pw.live', role: 'USER', cluster_id: clId, name: 'User One', Role: 'USER' }, { title: 'Fix dashboard', description: 'again' });
  ok(dup.duplicate, 'duplicate detected');
  try { await tickets.create({ email: 'user1@pw.live', role: 'USER', cluster_id: clId, name: 'X', Role: 'USER' }, { title: '', description: 'x' }); ok(false, 'create no title rejected'); } catch (e) { ok(true, 'create no title rejected'); }
  try { await tickets.create({ email: 'user1@pw.live', role: 'USER', cluster_id: clId, name: 'X', Role: 'USER' }, { title: 'T', description: '' }); ok(false, 'create no description rejected'); } catch (e) { ok(true, 'create no description rejected'); }

  const cbaUser = { email: 'cba.n@pw.live', role: 'CBA', cluster_id: clId, name: 'CBA North', Role: 'CBA' };
  const asg1 = await tickets.assign(cbaUser, { ticketId: tid1, analystEmail: 'an1@pw.live' });
  ok(asg1.status === 'ASSIGNED' && asg1.analystEmail === 'an1@pw.live', 'assign to analyst1');
  try { await tickets.assign(cbaUser, { ticketId: 'TKT-9999-00001', analystEmail: 'an1@pw.live' }); ok(false, 'assign not found'); } catch (e) { ok(true, 'assign not found'); }

  console.log('\n── tickets: status machine ──');
  const an1User = { email: 'an1@pw.live', role: 'ANALYST', cluster_id: clId, name: 'Analyst One', Role: 'ANALYST' };
  const st1 = await tickets.updateStatus(an1User, { ticketId: tid1, status: 'IN_PROGRESS' });
  ok(st1.status === 'IN_PROGRESS', 'ASSIGNED -> IN_PROGRESS');
  try { await tickets.updateStatus(an1User, { ticketId: tid1, status: 'CLOSED' }); ok(false, 'invalid transition rejected'); } catch (e) { ok(true, 'invalid transition rejected'); }
  const st2 = await tickets.updateStatus(an1User, { ticketId: tid1, status: 'ON_HOLD' });
  ok(st2.status === 'ON_HOLD', 'IN_PROGRESS -> ON_HOLD');
  const st3 = await tickets.updateStatus(an1User, { ticketId: tid1, status: 'IN_PROGRESS' });
  ok(st3.status === 'IN_PROGRESS', 'ON_HOLD -> IN_PROGRESS');
  const st4 = await tickets.updateStatus(an1User, { ticketId: tid1, status: 'RESOLVED' });
  ok(st4.status === 'RESOLVED' && st4.resolvedAt, 'IN_PROGRESS -> RESOLVED');
  const an2User = { email: 'an2@pw.live', role: 'ANALYST', cluster_id: clId, name: 'Analyst Two', Role: 'ANALYST' };
  try { await tickets.updateStatus(an2User, { ticketId: tid1, status: 'IN_PROGRESS' }); ok(false, 'non-assignee rejected'); } catch (e) { ok(true, 'non-assignee rejected'); }

  console.log('\n── tickets: close/reopen/rate ──');
  const cl1r = await tickets.close({ email: 'user1@pw.live', role: 'USER', Role: 'USER', name: 'User One' }, { ticketId: tid1 });
  ok(cl1r.status === 'CLOSED', 'close ticket');
  try { await tickets.close({ email: 'user1@pw.live', role: 'USER', Role: 'USER' }, { ticketId: tid1 }); ok(false, 'close already closed rejected'); } catch (e) { ok(true, 'close already closed rejected'); }
  try { await tickets.reopen({ email: 'user1@pw.live', role: 'USER', Role: 'USER' }, { ticketId: tid1, reason: '' }); ok(false, 'reopen no reason rejected'); } catch (e) { ok(true, 'reopen no reason rejected'); }
  const ro3 = await tickets.reopen({ email: 'user1@pw.live', role: 'USER', Role: 'USER' }, { ticketId: tid1, reason: 'still broken' });
  ok(ro3.status === 'REOPENED', 'reopen ticket');
  const cl2 = await tickets.close({ email: 'user1@pw.live', role: 'USER', Role: 'USER' }, { ticketId: tid1 });
  ok(cl2.status === 'CLOSED', 'close again');
  const rate1 = await tickets.rate({ email: 'user1@pw.live', role: 'USER', Role: 'USER' }, { ticketId: tid1, rating: 5, feedback: 'great' });
  ok(rate1.rating === 5, 'rate 5');
  try { await tickets.rate({ email: 'user1@pw.live', role: 'USER', Role: 'USER' }, { ticketId: tid1, rating: 3 }); ok(false, 'rate already rated rejected'); } catch (e) { ok(true, 'rate already rated rejected'); }
  try { await tickets.rate({ email: 'user1@pw.live', role: 'USER', Role: 'USER' }, { ticketId: 'TKT-9999-00001', rating: 3 }); ok(false, 'rate not owner rejected'); } catch (e) { ok(true, 'rate not owner rejected'); }

  console.log('\n── tickets: comment + visibility ──');
  const cm1 = await tickets.addComment({ email: 'user1@pw.live', role: 'USER', Role: 'USER', name: 'User One' }, { ticketId: tid1, text: 'hello' });
  ok(cm1.commentId === 'ok', 'addComment');
  try { await tickets.addComment({ email: 'user1@pw.live', role: 'USER', Role: 'USER' }, { ticketId: tid1, text: '' }); ok(false, 'empty comment rejected'); } catch (e) { ok(true, 'empty comment rejected'); }
  ok(await tickets.canSee({ email: 'user1@pw.live', role: 'USER' }, { raised_by_email: 'user1@pw.live' }), 'canSee owner');
  ok(await tickets.canSee({ email: 'admin@x', role: 'ADMIN' }, { raised_by_email: 'someone@else' }), 'canSee admin');
  ok(await tickets.canSee({ email: 'cba.n@pw.live', role: 'CBA', cluster_id: clId }, { cluster_id: clId }), 'canSee cba same cluster');
  ok(!(await tickets.canSee({ email: 'cba.other@pw.live', role: 'CBA', cluster_id: 'OTHER' }, { cluster_id: clId })), 'canSee cba diff cluster');
  ok(await tickets.canSee({ email: 'an1@pw.live', role: 'ANALYST' }, { analyst_email: 'an1@pw.live' }), 'canSee analyst assigned');
  ok(!(await tickets.canSee({ email: 'an2@pw.live', role: 'ANALYST' }, { analyst_email: 'an1@pw.live' })), 'canSee analyst not assigned');

  console.log('\n── tickets: list + get + dashboard + myAnalysts ──');
  const lt = await tickets.list({ email: 'user1@pw.live', role: 'USER', Role: 'USER' }, {});
  ok(lt.total >= 1, 'listTickets total');
  const lt2 = await tickets.list({ email: 'user1@pw.live', role: 'USER', Role: 'USER' }, { status: 'CLOSED', pageSize: 5 });
  ok(lt2.rows.every(r => r.status === 'CLOSED'), 'listTickets filter status');
  const gt = await tickets.get({ email: 'user1@pw.live', role: 'USER', Role: 'USER' }, { ticketId: tid1 });
  ok(gt.logs.length > 0 && gt.comments.length > 0, 'getTicket with logs+comments');
  try { await tickets.get({ email: 'user1@pw.live', role: 'USER', Role: 'USER' }, { ticketId: 'TKT-9999-00001' }); ok(false, 'getTicket not found'); } catch (e) { ok(true, 'getTicket not found'); }
  try { await tickets.get({ email: 'stranger@pw.live', role: 'USER', Role: 'USER' }, { ticketId: tid1 }); ok(false, 'getTicket access denied'); } catch (e) { ok(true, 'getTicket access denied'); }
  const dbd = await tickets.dashboard({ email: 'user1@pw.live', role: 'USER', Role: 'USER', cluster_id: clId });
  ok(dbd.total >= 1 && dbd.role === 'USER', 'dashboard');
  const ma = await tickets.myAnalysts({ email: 'cba.n@pw.live', role: 'CBA', Role: 'CBA', cluster_id: clId });
  ok(ma.length === 3, 'myAnalysts CBA sees 2 analysts + self');
  const maAdm = await tickets.myAnalysts({ email: 'ambikesh.srivastava@pw.live', role: 'ADMIN', Role: 'ADMIN', cluster_id: 'CL-ADMIN' });
  ok(maAdm.length >= 3, 'myAnalysts ADMIN');

  console.log('\n── approvals ──');
  const ct2 = await tickets.create({ email: 'user1@pw.live', role: 'USER', Role: 'USER', cluster_id: clId, name: 'User One', phone: '', department: 'Analytics' }, { title: 'Approval flow test', description: 'needs sign-off', priority: 'Medium' });
  const tid2 = ct2.ticketId;
  await tickets.assign(cbaUser, { ticketId: tid2, analystEmail: 'an1@pw.live' });
  const apr1 = await approvals.request(cbaUser, { ticketId: tid2, approverEmail: 'ambikesh.srivastava@pw.live', note: 'need budget' });
  ok(apr1.approvalId && apr1.approverEmail === 'ambikesh.srivastava@pw.live', 'request approval');
  const aprMail = sent.filter(s => s.tpl === 'approvalRequest').pop();
  ok(!!aprMail && aprMail.vars.approveUrl.includes('#approve/'), 'approval mail sent');
  const tu = aprMail.vars.approveUrl.match(/#approve\/([^/]+)\/(.+)$/);
  const info1 = await approvals.getInfo(tu[2], tu[1]);
  ok(info1.canDecide && info1.ticket.ticketId === tid2, 'getInfo canDecide');
  try { await approvals.decide(tu[2], tu[1], 'BOGUS'); ok(false, 'invalid decision rejected'); } catch (e) { ok(true, 'invalid decision rejected'); }
  const dec1 = await approvals.decide(tu[2], tu[1], 'APPROVED', 'go ahead');
  ok(dec1.status === 'APPROVED', 'decide APPROVED');
  const gt2 = await tickets.get(cbaUser, { ticketId: tid2 });
  ok(gt2.status === 'IN_PROGRESS', 'ticket after approve IN_PROGRESS');
  try { await approvals.decide(tu[2], tu[1], 'REJECTED'); ok(false, 'already decided rejected'); } catch (e) { ok(true, 'already decided rejected'); }
  try { await approvals.lookup('bad-token', tu[1]); ok(false, 'lookup bad token rejected'); } catch (e) { ok(true, 'lookup bad token rejected'); }
  try { await approvals.request({ email: 'stranger@pw.live', role: 'USER', Role: 'USER' }, { ticketId: tid2, approverEmail: 'x@pw.live' }); ok(false, 'request access denied'); } catch (e) { ok(true, 'request access denied'); }

  console.log('\n── reassign ──');
  // After approval, ticket is already IN_PROGRESS — no need to updateStatus again
  const rr1 = await reassign.request(an1User, { ticketId: tid2, toAnalystEmail: 'an2@pw.live', reason: 'busy' });
  ok(rr1.req_id && rr1.status === 'PENDING', 'request reassign');
  try { await reassign.request(an1User, { ticketId: tid2, toAnalystEmail: 'an2@pw.live', reason: 'again' }); ok(false, 'duplicate pending rejected'); } catch (e) { ok(true, 'duplicate pending rejected'); }
  try { await reassign.request(an2User, { ticketId: tid2, toAnalystEmail: 'an1@pw.live', reason: 'x' }); ok(false, 'not assignee rejected'); } catch (e) { ok(true, 'not assignee rejected'); }
  try { await reassign.request(an1User, { ticketId: tid2, toAnalystEmail: 'an1@pw.live', reason: 'x' }); ok(false, 'self reassign rejected'); } catch (e) { ok(true, 'self reassign rejected'); }
  const lr1 = await reassign.list(cbaUser);
  ok(lr1.length === 1 && lr1[0].reqId === rr1.req_id, 'list reassign for CBA');
  const dr1 = await reassign.decide(cbaUser, { reqId: rr1.req_id, approve: true, note: 'ok' });
  ok(dr1.status === 'APPROVED', 'decide reassign approve');
  const gt3 = await tickets.get(cbaUser, { ticketId: tid2 });
  ok(gt3.analystEmail === 'an2@pw.live' && gt3.status === 'ASSIGNED', 'ticket reassigned to an2');

  console.log('\n── admin: workload / analytics / activity / export ──');
  const tw = await admin.teamWorkload(cbaUser);
  ok(tw.length >= 2, 'teamWorkload >= 2 (an1 + an2, an3 inactive also listed)');
  const anl = await admin.analytics({ email: 'ambikesh.srivastava@pw.live', role: 'ADMIN' }, { days: 30 });
  ok(anl.totals && anl.range, 'analytics shape');
  const act = await admin.activity({ email: 'ambikesh.srivastava@pw.live', role: 'ADMIN' }, { days: 30 });
  ok(Array.isArray(act.users), 'activity shape');
  const myAct = await admin.myActivity({ email: 'user1@pw.live', name: 'User One', role: 'USER' }, { days: 30 });
  ok(myAct.total >= 1 && myAct.streak, 'myActivity shape');
  const mq = await admin.mailQueue({}, {});
  ok(mq.enabled && Array.isArray(mq.rows), 'mailQueue shape');
  const exT = await admin.exportCsv({}, { type: 'tickets' });
  ok(exT.filename === 'tickets.csv' && exT.csv.includes('TicketID'), 'exportCsv tickets');
  const exL = await admin.exportCsv({}, { type: 'logs' });
  ok(exL.filename === 'ticket-logs.csv', 'exportCsv logs');
  const exA = await admin.exportCsv({}, { type: 'activity' });
  ok(exA.filename === 'activity-log.csv', 'exportCsv activity');

  console.log('\n── jobs ──');
  const jDrain = await jobs.drainMailQueue();
  ok(typeof jDrain.sent === 'number', 'drainMailQueue');
  const jRem = await jobs.dailyReminders();
  ok(typeof jRem.digests === 'number', 'dailyReminders');
  const jSla = await jobs.hourlySlaCheck();
  ok(typeof jSla.warnings === 'number', 'hourlySlaCheck');
  const jClean = await jobs.cleanupExpired();
  ok(typeof jClean.closed === 'number', 'cleanupExpired');

  console.log('\n── routes: role guards + unknown ──');
  const rg1 = await routes.handle({ api: 'adminUsers', token: userTok2, payload: {} });
  ok(!rg1.ok && rg1.error.includes('role'), 'USER cannot adminUsers');
  const rg2 = await routes.handle({ api: 'updateStatus', token: userTok2, payload: {} });
  ok(!rg2.ok, 'USER cannot updateStatus');
  const rg3 = await routes.handle({ api: 'nope', token: '', payload: {} });
  ok(!rg3.ok && rg3.error.includes('Unknown'), 'unknown API rejected');
  const rg4 = await routes.handle({ api: 'me', token: 'bad', payload: {} });
  ok(!rg4.ok && rg4.error === 'SESSION_EXPIRED', 'bad token SESSION_EXPIRED');
  const rg5 = await routes.handle({ api: 'me', token: userTok2, payload: {} });
  ok(rg5.ok && rg5.data.email === 'user1@pw.live', 'me via routes');

  console.log('\n── mail (real, unstubbed) ──');
  delete require.cache[require.resolve('../lib/mail')];
  const realMail = require('../lib/mail');
  const r1 = await realMail.sendBatch([]);
  ok(r1.ok && r1.data.sent === 0, 'sendBatch empty');
  const r2 = await realMail.sendMail({ to: 'x@y.z', tpl: 'test', vars: {} });
  ok(r2.ok === false || r2.ok === true, 'sendMail returns ok flag (no crash)');

  console.log('\n\x1b[1m' + pass + ' passed, ' + fail + ' failed\x1b[0m\n');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
