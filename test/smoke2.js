/* Smoke test #2: CBA / Analyst / Admin flows (approvals, reassign, admin). Mail stubbed. */
const path = require('path');
const fs = require('fs');
const dbFile = path.join(__dirname, 'smoke2.db');
try { fs.unlinkSync(dbFile); } catch (e) {}
process.env.DB_URL = 'file:' + dbFile;

const mail = require('../lib/mail');
const sent = [];
mail.sendMail = async (m) => { sent.push(m); return { ok: true }; };
mail.sendBatch = async (ms) => { ms.forEach(m => sent.push(m)); return { ok: true, data: { sent: ms.length, failed: 0, results: ms.map(m => ({ to: m.to, ok: true })) } }; };

const { handle } = require('../lib/routes');
const call = (api, token, payload) => handle({ api, token, payload });

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + label); } else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + label); } };

async function loginAs(email) {
  await call('requestOtp', '', { email });
  const m = sent.filter(s => s.tpl === 'otp' && s.to === email).pop();
  if (!m) throw new Error('no otp for ' + email);
  const r = await call('verifyOtp', '', { email, code: m.vars.code });
  if (!r.ok) throw new Error('verify failed for ' + email + ': ' + r.error);
  return r.data.token;
}

async function main() {
  console.log('\nadmin login (seeded)');
  const adminTok = await loginAs('ambikesh.srivastava@pw.live');
  ok(!!adminTok, 'admin logged in');

  console.log('\nadmin: clusters');
  const cl = await call('adminSaveCluster', adminTok, { cluster: { name: 'North', cbaEmail: 'cba.north@pw.live', status: 'ACTIVE' } });
  ok(cl.ok && cl.data.clusterId, 'create cluster -> ' + (cl.data && cl.data.clusterId || cl.error));
  const clId = cl.data.clusterId;

  console.log('\nadmin: users');
  const uCba = await call('adminSaveUser', adminTok, { user: { email: 'cba.north@pw.live', name: 'CBA North', role: 'CBA', clusterId: clId, status: 'ACTIVE' } });
  ok(uCba.ok, 'create CBA: ' + (uCba.error || ''));
  const uAn1 = await call('adminSaveUser', adminTok, { user: { email: 'an1@pw.live', name: 'Analyst One', role: 'ANALYST', clusterId: clId, status: 'ACTIVE' } });
  ok(uAn1.ok, 'create analyst1: ' + (uAn1.error || ''));
  const uAn2 = await call('adminSaveUser', adminTok, { user: { email: 'an2@pw.live', name: 'Analyst Two', role: 'ANALYST', clusterId: clId, status: 'ACTIVE' } });
  ok(uAn2.ok, 'create analyst2: ' + (uAn2.error || ''));
  const uUser = await call('adminSaveUser', adminTok, { user: { email: 'emp1@pw.live', name: 'Emp One', role: 'USER', clusterId: clId, status: 'ACTIVE' } });
  ok(uUser.ok, 'create user: ' + (uUser.error || ''));
  const lu = await call('adminUsers', adminTok, {});
  ok(lu.ok && lu.data.length >= 4, 'adminUsers count=' + (lu.data && lu.data.length));

  console.log('\nCBA login + clusterAnalysts');
  const cbaTok = await loginAs('cba.north@pw.live');
  const ca = await call('clusterAnalysts', cbaTok, {});
  ok(ca.ok && ca.data.length === 2, 'clusterAnalysts=2: ' + (ca.error || ''));

  console.log('\nuser creates ticket');
  const userTok = await loginAs('emp1@pw.live');
  const ct = await call('createTicket', userTok, { title: 'Approval needed report', description: 'plz', priority: 'High', category: 'Data' });
  ok(ct.ok && ct.data.ticketId, 'ticket -> ' + (ct.data && ct.data.ticketId || ct.error));
  const tid = ct.data.ticketId;

  console.log('\nCBA assigns to analyst1');
  const asg = await call('assignTicket', cbaTok, { ticketId: tid, analystEmail: 'an1@pw.live' });
  ok(asg.ok && asg.data.analystEmail === 'an1@pw.live', 'assigned: ' + (asg.error || ''));

  console.log('\nCBA requests approval');
  const ra = await call('requestApproval', cbaTok, { ticketId: tid, approverEmail: 'ambikesh.srivastava@pw.live', note: 'need budget' });
  ok(ra.ok && ra.data.approvalId, 'approval -> ' + (ra.data && ra.data.approvalId || ra.error));
  const aprId = ra.data.approvalId;
  const aprMail = sent.filter(s => s.tpl === 'approvalRequest').pop();
  ok(!!aprMail && !!aprMail.vars.approveUrl, 'approval mail with approveUrl');
  const turl = aprMail.vars.approveUrl.match(/#approve\/([^/]+)\/(.+)$/);
  ok(!!turl, 'approveUrl parsed');

  console.log('\nadmin decides approval (via token URL)');
  const dec = await call('decideApproval', '', { t: turl[2], a: turl[1], decision: 'APPROVED', note: 'go ahead' });
  ok(dec.ok && dec.data.status === 'APPROVED', 'approved: ' + (dec.error || ''));
  const gt = await call('getTicket', cbaTok, { ticketId: tid });
  ok(gt.ok && gt.data.status === 'IN_PROGRESS', 'ticket now IN_PROGRESS');

  console.log('\nanalyst1 requests reassign');
  const anTok = await loginAs('an1@pw.live');
  const rr = await call('requestReassign', anTok, { ticketId: tid, toAnalystEmail: 'an2@pw.live', reason: 'busy' });
  ok(rr.ok && rr.data.req_id, 'reassign -> ' + (rr.data && rr.data.req_id || rr.error));

  console.log('\nCBA decides reassign');
  const lr = await call('listReassign', cbaTok, {});
  ok(lr.ok && lr.data.length === 1, 'listReassign=1');
  const dr = await call('decideReassign', cbaTok, { reqId: rr.data.req_id, approve: true, note: 'ok' });
  ok(dr.ok && dr.data.status === 'APPROVED', 'reassign approved: ' + (dr.error || ''));
  const gt2 = await call('getTicket', cbaTok, { ticketId: tid });
  ok(gt2.ok && gt2.data.analystEmail === 'an2@pw.live', 'analyst now an2');

  console.log('\nanalyst2 status updates');
  const an2Tok = await loginAs('an2@pw.live');
  const st1 = await call('updateStatus', an2Tok, { ticketId: tid, status: 'IN_PROGRESS' });
  ok(st1.ok, 'to IN_PROGRESS: ' + (st1.error || ''));
  const st2 = await call('updateStatus', an2Tok, { ticketId: tid, status: 'RESOLVED' });
  ok(st2.ok, 'to RESOLVED: ' + (st2.error || ''));

  console.log('\nadmin: analytics / activity / workload / export / mailQueue');
  const an = await call('adminAnalytics', adminTok, { days: 7 });
  ok(an.ok && an.data.totals && typeof an.data.totals.total === 'number', 'analytics: ' + (an.error || ''));
  const ac = await call('adminActivity', adminTok, { days: 7 });
  ok(ac.ok && Array.isArray(ac.data.users), 'activity: ' + (ac.error || ''));
  const tw = await call('teamWorkload', cbaTok, {});
  ok(tw.ok && tw.data.length === 2, 'teamWorkload=2: ' + (tw.error || ''));
  const ex = await call('adminExportCsv', adminTok, { type: 'tickets' });
  ok(ex.ok && ex.data.csv.indexOf('TicketID') === 0, 'export csv: ' + (ex.error || ''));
  const mq = await call('adminMailQueue', adminTok, {});
  ok(mq.ok, 'mailQueue: ' + (mq.error || ''));

  console.log('\nrole guards');
  ok(!(await call('adminUsers', cbaTok, {})).ok, 'CBA cannot adminUsers');
  ok(!(await call('requestApproval', anTok, { ticketId: tid, approverEmail: 'x@pw.live' })).ok, 'ANALYST cannot requestApproval');
  ok(!(await call('decideReassign', anTok, { reqId: 'RR-X', approve: true })).ok, 'ANALYST cannot decideReassign');
  ok(!(await call('assignTicket', userTok, { ticketId: tid, analystEmail: 'an1@pw.live' })).ok, 'USER cannot assign');

  console.log('\nmyActivity (user)');
  const ma = await call('myActivity', userTok, { days: 7 });
  ok(ma.ok && ma.data.total >= 1, 'myActivity total=' + (ma.data && ma.data.total));

  console.log('\ncron jobs (direct, secret checked in api layer)');
  const jobs = require('../lib/jobs');
  const dr2 = await jobs.drainMailQueue().catch(e => ({ err: String(e) }));
  ok(!dr2.err, 'drainMailQueue: ' + JSON.stringify(dr2));
  const dc = await jobs.cleanupExpired().catch(e => ({ err: String(e) }));
  ok(!dc.err, 'cleanupExpired: ' + JSON.stringify(dc));

  console.log('\n\x1b[1m' + pass + ' passed, ' + fail + ' failed\x1b[0m\n');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
