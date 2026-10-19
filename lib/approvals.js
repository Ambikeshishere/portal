const { q, run, sha256 } = require('./db');
const { normEmail, now, toMs, addHours, randomToken } = require('./helpers');
const { cfgNum, cfg } = require('./settings');
const { logActivity } = require('./auth');
const { sendMail } = require('./mail');
const Tickets = require('./tickets');

async function lookup(token, approvalId) {
  if (!token || !approvalId) throw new Error('Missing approval link details.');
  const rows = await q('SELECT * FROM approvals WHERE approval_id = ? AND token_hash = ?', [String(approvalId), sha256(token)]);
  if (!rows[0]) throw new Error('This approval link is invalid.');
  return rows[0];
}

async function request(user, p) {
  const ts = await q('SELECT * FROM tickets WHERE ticket_id = ?', [String(p.ticketId)]);
  const t = ts[0];
  if (!t) throw new Error('Ticket not found.');
  if (!(await Tickets.canSee(user, t))) throw new Error('Access denied.');
  const approver = normEmail(p.approverEmail);
  if (!approver || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(approver)) throw new Error('A valid approver email is required.');
  const token = randomToken();
  const approvalId = 'APR-' + randomToken().slice(0, 10).toUpperCase();
  const expiresAt = addHours(now(), Number(await cfgNum('APPROVAL_EXPIRY_HRS')));
  await run('INSERT INTO approvals (approval_id,ticket_id,requested_by_email,approver_email,token_hash,status,request_note,decision_note,requested_at,expires_at,decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [approvalId, t.ticket_id, normEmail(user.email), approver, sha256(token), 'PENDING', String(p.note || '').trim(), '', now(), expiresAt, '']);
  await run("UPDATE tickets SET approval_required='TRUE', approval_status='PENDING', status='PENDING_APPROVAL', updated_at=? WHERE ticket_id=?", [now(), t.ticket_id]);
  await Tickets.log(t.ticket_id, user, 'APPROVAL_REQUESTED', '', approver, String(p.note || '').trim());
  await logActivity(user, 'APPROVAL_SENT', t.ticket_id + ' -> ' + approver);
  const base = String(await cfg('PORTAL_URL') || process.env.PORTAL_BASE_URL || '').replace(/\/+$/, '');
  const approveUrl = base + '#approve/' + approvalId + '/' + token;
  try {
    await sendMail({ to: approver, tpl: 'approvalRequest', vars: { ticketId: t.ticket_id, title: t.title, priority: t.priority, description: t.description, requesterName: user.name, requesterEmail: user.email, cbaName: user.name, cbaEmail: user.email, note: String(p.note || '').trim(), approveUrl, rejectUrl: approveUrl, expiryHrs: await cfgNum('APPROVAL_EXPIRY_HRS') } });
  } catch (e) { /* non-fatal */ }
  return { approvalId, approverEmail: approver, expiresAt };
}

async function getInfo(token, approvalId) {
  const a = await lookup(token, approvalId);
  const t = (await q('SELECT * FROM tickets WHERE ticket_id = ?', [a.ticket_id]))[0] || {};
  const requester = (await q('SELECT * FROM users WHERE email = ?', [normEmail(t.raised_by_email)]))[0] || {};
  const expired = toMs(a.expires_at) < Date.now() && String(a.status).toUpperCase() === 'PENDING';
  return {
    approvalId: a.approval_id, status: expired ? 'EXPIRED' : String(a.status).toUpperCase(),
    canDecide: String(a.status).toUpperCase() === 'PENDING' && !expired,
    approverEmail: normEmail(a.approver_email), requestedBy: normEmail(a.requested_by_email),
    note: a.request_note, decisionNote: a.decision_note || '', requestedAt: a.requested_at,
    expiresAt: a.expires_at, decidedAt: a.decided_at || '',
    ticket: { ticketId: t.ticket_id, title: t.title, description: t.description, priority: t.priority, category: t.category, department: t.department, raisedByName: t.raised_by_name, raisedByEmail: normEmail(t.raised_by_email), raisedByPhone: requester.phone || t.raised_by_phone || '' }
  };
}

async function decide(token, approvalId, decision, note) {
  decision = String(decision || '').toUpperCase();
  if (decision !== 'APPROVED' && decision !== 'REJECTED') throw new Error('Invalid decision.');
  const a = await lookup(token, approvalId);
  if (String(a.status).toUpperCase() !== 'PENDING') throw new Error('This request has already been ' + String(a.status).toLowerCase() + '.');
  if (toMs(a.expires_at) < Date.now()) throw new Error('This approval link has expired.');
  const t = (await q('SELECT * FROM tickets WHERE ticket_id = ?', [a.ticket_id]))[0];
  if (!t) throw new Error('Ticket not found.');
  await run('UPDATE approvals SET status=?, decision_note=?, decided_at=? WHERE id=?', [decision, String(note || '').trim(), now(), a.id]);
  await run('UPDATE tickets SET approval_status=?, approved_by=?, status=?, updated_at=? WHERE ticket_id=?',
    [decision, normEmail(a.approver_email), decision === 'APPROVED' ? 'IN_PROGRESS' : 'ON_HOLD', now(), a.ticket_id]);
  const actor = { email: a.approver_email, name: a.approver_email, role: 'APPROVER' };
  await Tickets.log(a.ticket_id, actor, 'APPROVAL_' + decision, '', decision, String(note || '').trim());
  await logActivity(actor, 'APPROVAL_' + decision, a.ticket_id);
  const fresh = (await q('SELECT * FROM tickets WHERE ticket_id = ?', [a.ticket_id]))[0];
  try {
    const recips = new Set([normEmail(a.requested_by_email), normEmail(fresh.analyst_email)].filter(Boolean));
    for (const r of recips) await sendMail({ to: r, tpl: 'approvalDecision', vars: { ticketId: a.ticket_id, title: fresh.title, decision, decider: a.approver_email, note: String(note || '').trim() } });
  } catch (e) { /* non-fatal */ }
  return { status: decision };
}

module.exports = { request, getInfo, decide, lookup };
