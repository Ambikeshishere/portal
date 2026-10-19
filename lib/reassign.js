const { q, run } = require('./db');
const { normEmail, now, toMs, randomToken } = require('./helpers');
const { logActivity } = require('./auth');
const { sendMail } = require('./mail');
const Tickets = require('./tickets');

async function request(user, p) {
  const ts = await q('SELECT * FROM tickets WHERE ticket_id = ?', [String(p.ticketId)]);
  const t = ts[0];
  if (!t) throw new Error('Ticket not found.');
  if (normEmail(t.analyst_email) !== normEmail(user.email)) throw new Error('Only the assigned analyst can request a reassignment.');
  const st = String(t.status).toUpperCase();
  if (st === 'CLOSED') throw new Error('Closed tickets cannot be reassigned.');
  const toAnalyst = normEmail(p.toAnalystEmail);
  if (!toAnalyst) throw new Error('Select the analyst to reassign to.');
  if (toAnalyst === normEmail(user.email)) throw new Error('You cannot reassign to yourself.');
  const targets = await q('SELECT * FROM users WHERE email = ?', [toAnalyst]);
  const target = targets[0];
  if (!target || String(target.role).toUpperCase() !== 'ANALYST' || String(target.status).toUpperCase() !== 'ACTIVE') throw new Error('Target is not an active Associate Analyst.');
  if (String(target.cluster_id) !== String(t.cluster_id)) throw new Error("Target analyst is not in this ticket's cluster.");
  const pending = await q("SELECT id FROM reassign_requests WHERE ticket_id=? AND UPPER(status)='PENDING'", [t.ticket_id]);
  if (pending.length) throw new Error('A reassignment request is already pending for this ticket.');
  const reqId = 'RR-' + randomToken().slice(0, 10).toUpperCase();
  await run('INSERT INTO reassign_requests (req_id,ticket_id,from_analyst,to_analyst,reason,status,cba_email,decision_note,requested_at,decided_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [reqId, t.ticket_id, normEmail(user.email), toAnalyst, String(p.reason || '').trim(), 'PENDING', t.cba_email || '', '', now(), '']);
  await run("UPDATE tickets SET status='PENDING_APPROVAL', updated_at=? WHERE ticket_id=?", [now(), t.ticket_id]);
  await Tickets.log(t.ticket_id, user, 'REASSIGN_REQUESTED', normEmail(user.email), toAnalyst, String(p.reason || '').trim());
  await logActivity(user, 'REASSIGN_REQUEST', t.ticket_id + ' -> ' + toAnalyst);
  try { await sendMail({ to: t.cba_email, tpl: 'reassignRequest', vars: { ticketId: t.ticket_id, title: t.title, actorName: user.name, from: normEmail(user.email), to: toAnalyst, reason: String(p.reason || '').trim() } }); } catch (e) { /* non-fatal */ }
  return { req_id: reqId, ticket_id: t.ticket_id, from_analyst: normEmail(user.email), to_analyst: toAnalyst, reason: String(p.reason || '').trim(), status: 'PENDING', cba_email: t.cba_email || '', decision_note: '', requested_at: now(), decided_at: '' };
}

async function list(user) {
  const role = String(user.Role || user.role).toUpperCase();
  let rows = await q('SELECT * FROM reassign_requests');
  if (role === 'CBA') rows = rows.filter(r => normEmail(r.cba_email) === normEmail(user.email));
  rows.sort((a, b) => toMs(b.requested_at) - toMs(a.requested_at));
  const out = [];
  for (const r of rows) {
    const t = (await q('SELECT * FROM tickets WHERE ticket_id = ?', [r.ticket_id]))[0] || {};
    out.push({ reqId: r.req_id, ticketId: r.ticket_id, ticketTitle: t.title || '', fromAnalyst: normEmail(r.from_analyst), toAnalyst: normEmail(r.to_analyst), reason: r.reason, status: String(r.status).toUpperCase(), decisionNote: r.decision_note || '', requestedAt: r.requested_at, decidedAt: r.decided_at || '' });
  }
  return out;
}

async function decide(user, p) {
  const rows = await q('SELECT * FROM reassign_requests WHERE req_id = ?', [String(p.reqId)]);
  const req = rows[0];
  if (!req) throw new Error('Request not found.');
  if (String(req.status).toUpperCase() !== 'PENDING') throw new Error('This request was already decided.');
  const role = String(user.Role || user.role).toUpperCase();
  if (role === 'CBA' && normEmail(req.cba_email) !== normEmail(user.email)) throw new Error('This request is not assigned to you.');
  const t = (await q('SELECT * FROM tickets WHERE ticket_id = ?', [req.ticket_id]))[0];
  if (!t) throw new Error('Ticket not found.');
  const approve = p.approve === true || String(p.approve) === 'true';
  await run('UPDATE reassign_requests SET status=?, decision_note=?, decided_at=? WHERE id=?', [approve ? 'APPROVED' : 'REJECTED', String(p.note || '').trim(), now(), req.id]);
  req.decision_note = String(p.note || '').trim();
  if (approve) {
    const target = (await q('SELECT * FROM users WHERE email = ?', [normEmail(req.to_analyst)]))[0] || {};
    await run("UPDATE tickets SET analyst_email=?, status='ASSIGNED', updated_at=? WHERE ticket_id=?", [normEmail(req.to_analyst), now(), req.ticket_id]);
    await Tickets.log(req.ticket_id, user, 'REASSIGN_APPROVED', normEmail(req.from_analyst), normEmail(req.to_analyst), req.decision_note);
    await logActivity(user, 'REASSIGN_APPROVED', req.ticket_id + ' -> ' + req.to_analyst);
    try { const fresh = (await q('SELECT * FROM tickets WHERE ticket_id = ?', [req.ticket_id]))[0]; await sendMail({ to: normEmail(target.email), tpl: 'assignedToAnalyst', vars: { ticketId: req.ticket_id, title: fresh.title, priority: fresh.priority, requesterName: fresh.raised_by_name, dueAt: fresh.due_at, actorName: user.name } }); } catch (e) { /* non-fatal */ }
  } else {
    await run("UPDATE tickets SET status='IN_PROGRESS', updated_at=? WHERE ticket_id=?", [now(), req.ticket_id]);
    await Tickets.log(req.ticket_id, user, 'REASSIGN_REJECTED', '', '', req.decision_note);
    await logActivity(user, 'REASSIGN_REJECTED', req.ticket_id);
  }
  try {
    const recips = new Set([normEmail(req.from_analyst), normEmail(req.to_analyst)].filter(Boolean));
    for (const r of recips) await sendMail({ to: r, tpl: 'reassignDecision', vars: { ticketId: req.ticket_id, title: t.title, approved: approve, decider: user.name, to: req.to_analyst, note: req.decision_note } });
  } catch (e) { /* non-fatal */ }
  return { status: approve ? 'APPROVED' : 'REJECTED' };
}

module.exports = { request, list, decide };
