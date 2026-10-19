/* Smoke test: exercises the API through routes.handle() with mail stubbed. */
const path = require('path');
const fs = require('fs');
const dbFile = path.join(__dirname, 'smoke.db');
try { fs.unlinkSync(dbFile); } catch (e) {}
process.env.DB_URL = 'file:' + dbFile;

const mail = require('../lib/mail');
const sent = [];
mail.sendMail = async (m) => { sent.push(m); return { ok: true }; };
mail.sendBatch = async (ms) => { ms.forEach(m => sent.push(m)); return { ok: true, data: { sent: ms.length, failed: 0, results: ms.map(m => ({ to: m.to, ok: true })) } }; };

const { handle } = require('../lib/routes');

function grabOtp() {
  const m = sent.filter(s => s.tpl === 'otp').pop();
  if (!m) throw new Error('no otp mail captured');
  return m.vars.code;
}

async function main() {
  let pass = 0, fail = 0;
  const ok = (cond, label) => { if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + label); } else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + label); } };

  const call = (api, token, payload) => handle({ api, token, payload });

  console.log('\nsetup');
  const g = await call('getClusters', '', {});
  ok(g.ok, 'getClusters ok');
  ok(Array.isArray(g.data), 'getClusters array');

  console.log('\nsignup');
  const su = await call('signup', '', { email: 'tester@pw.live', name: 'Tester', phone: '9876543210', department: 'Analytics', clusterId: '' });
  ok(su.ok, 'signup ok: ' + (su.error || ''));

  console.log('\nOTP flow');
  const ro = await call('requestOtp', '', { email: 'tester@pw.live' });
  ok(ro.ok && ro.data.sent, 'requestOtp sent');
  ok(!JSON.stringify(ro).match(/\d{6}/), 'otp not leaked in response');
  const code = grabOtp();
  const bad = await call('verifyOtp', '', { email: 'tester@pw.live', code: '000000' });
  ok(!bad.ok, 'wrong otp rejected');
  const good = await call('verifyOtp', '', { email: 'tester@pw.live', code });
  ok(good.ok && good.data.token, 'verify ok -> token');
  const tok = good.data.token;

  console.log('\nme');
  const me = await call('me', tok, {});
  ok(me.ok && me.data.email === 'tester@pw.live', 'me returns user');

  console.log('\nticket create');
  const ct = await call('createTicket', tok, { title: 'Need dashboard fix', description: 'Charts broken', priority: 'High', category: 'Data' });
  ok(ct.ok && ct.data.ticketId, 'createTicket -> ' + (ct.data && ct.data.ticketId || ct.error));
  const tid = ct.data.ticketId;

  console.log('\nduplicate guard');
  const dup = await call('createTicket', tok, { title: 'Need dashboard fix', description: 'again', priority: 'High' });
  ok(dup.ok && dup.data.duplicate, 'duplicate detected');

  console.log('\nlist + get');
  const lt = await call('listTickets', tok, {});
  ok(lt.ok && lt.data.total >= 1, 'listTickets total=' + (lt.data && lt.data.total));
  const gt = await call('getTicket', tok, { ticketId: tid });
  ok(gt.ok && gt.data.ticketId === tid, 'getTicket ok');

  console.log('\ndashboard');
  const db = await call('dashboard', tok, {});
  ok(db.ok && db.data.total >= 1, 'dashboard total');

  console.log('\ncomment');
  const cm = await call('addComment', tok, { ticketId: tid, text: 'hello' });
  ok(cm.ok, 'addComment ok');

  console.log('\nclose + reopen + rate');
  const cl = await call('closeTicket', tok, { ticketId: tid });
  ok(cl.ok && cl.data.status === 'CLOSED', 'closed');
  const ro2 = await call('reopenTicket', tok, { ticketId: tid, reason: 'still broken' });
  ok(ro2.ok && ro2.data.status === 'REOPENED', 'reopened');
  const cl2 = await call('closeTicket', tok, { ticketId: tid });
  const rt = await call('rateTicket', tok, { ticketId: tid, rating: 5, feedback: 'great' });
  ok(rt.ok && rt.data.rating === 5, 'rated 5');

  console.log('\nrole guard');
  const an = await call('updateStatus', tok, { ticketId: tid, status: 'IN_PROGRESS' });
  ok(!an.ok, 'USER cannot updateStatus');

  console.log('\nunknown api');
  const un = await call('nope', tok, {});
  ok(!un.ok, 'unknown api rejected');

  console.log('\nsessions: ' + sent.filter(s => s.tpl === 'otp').length + ' otp mails captured (stubbed, none really sent)');
  console.log('\n\x1b[1m' + pass + ' passed, ' + fail + ' failed\x1b[0m\n');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
