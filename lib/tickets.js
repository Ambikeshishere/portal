const { q, run, nextId } = require('./db');
const { normEmail, now, toMs, randomToken } = require('./helpers');
const { PRIORITIES, TICKET_STATUSES, cfgNum, slaDueDate } = require('./settings');
const { logActivity } = require('./auth');
const { sendMail } = require('./mail');

const OPEN_STATES = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_APPROVAL', 'ON_HOLD', 'REOPENED'];

async function canSee(user, t) {
  if (normEmail(t.raised_by_email) === normEmail(user.email)) return true;
  switch (String(user.Role || user.role).toUpperCase()) {
    case 'ADMIN': return true;
    case 'CBA': return String(t.cluster_id) === String(user.cluster_id);
    case 'ANALYST': return normEmail(t.analyst_email) === normEmail(user.email);
    default: return false;
  }
}

async function log(ticketId, user, action, oldValue, newValue, note) {
  await run('INSERT INTO ticket_logs (log_id, ticket_id, action, by_email, by_role, old_value, new_value, note, timestamp) VALUES (?,?,?,?,?,?,?,?,?)',
    [randomToken().slice(0, 12), ticketId, action, normEmail(user.Email || user.email), String(user.Role || user.role || '').toUpperCase(),
     oldValue == null ? '' : String(oldValue), newValue == null ? '' : String(newValue), note || '', now()]);
}

async function publicTicket(t) {
  const dueMs = toMs(t.due_at);
  const status = String(t.status || '').toUpperCase();
  const slaState = (status === 'CLOSED' || status === 'RESOLVED') ? 'MET'
    : (!dueMs ? '-' : (Date.now() > dueMs ? 'BREACHED' : (dueMs - Date.now() < 4 * 3600000 ? 'DUE_SOON' : 'ON_TRACK')));
  return {
    ticketId: t.ticket_id, title: t.title, description: t.description,
    category: t.category || 'Other', priority: t.priority || 'Medium', status,
    raisedByEmail: normEmail(t.raised_by_email), raisedByName: t.raised_by_name || '',
    raisedByPhone: t.raised_by_phone || '', department: t.department || '',
    clusterId: t.cluster_id || '', cbaEmail: normEmail(t.cba_email),
    analystEmail: normEmail(t.analyst_email),
    approvalRequired: String(t.approval_required).toUpperCase() === 'TRUE',
    approvalStatus: t.approval_status || 'NONE', approvedBy: normEmail(t.approved_by),
    attachments: t.attachment_links ? String(t.attachment_links).split(',').filter(Boolean) : [],
    dueAt: t.due_at || '', createdAt: t.created_at || '', updatedAt: t.updated_at || '',
    resolvedAt: t.resolved_at || '', closedAt: t.closed_at || '',
    rating: t.rating || '', feedback: t.feedback || '', slaState
  };
}

async function resolveAssignee(user, t, email) {
  const targets = await q('SELECT * FROM users WHERE email = ?', [normEmail(email)]);
  const target = targets[0];
  if (!target) throw new Error('Selected user not found.');
  if (String(target.status).toUpperCase() !== 'ACTIVE') throw new Error('That user is inactive.');
  const role = String(target.role).toUpperCase();
  const actorRole = String(user.Role || user.role).toUpperCase();
  const isSelf = normEmail(target.email) === normEmail(user.email);
  const sameCluster = String(target.cluster_id) === String(t.cluster_id);
  if (isSelf && normEmail(t.raised_by_email) === normEmail(user.email)) return target;
  // Admin has every right: take any ticket themselves, or hand it to any manager/analyst.
  if (actorRole === 'ADMIN' && (isSelf || role === 'CBA' || role === 'ANALYST')) return target;
  if (role === 'ANALYST') {
    if (!sameCluster) throw new Error("That analyst is not in this ticket's cluster.");
    return target;
  }
  if (role === 'CBA' && isSelf && sameCluster) return target;
  throw new Error('Assign to an Associate Analyst in this cluster, or take it yourself.');
}

async function create(user, p) {
  if (!p.title || !String(p.title).trim()) throw new Error('Title is required.');
  if (!p.description || !String(p.description).trim()) throw new Error('Description is required.');
  const priority = PRIORITIES.indexOf(p.priority) >= 0 ? p.priority
    : (PRIORITIES.indexOf(user.default_priority) >= 0 ? user.default_priority : 'Medium');
  const title = String(p.title).trim();
  if (!p.force) {
    const dup = await q("SELECT ticket_id FROM tickets WHERE raised_by_email = ? AND LOWER(TRIM(title)) = ? AND UPPER(status) <> 'CLOSED'",
      [normEmail(user.email), title.toLowerCase()]);
    if (dup.length) return { duplicate: true, existingTicketId: dup[0].ticket_id, message: 'You already have an open ticket with this title (' + dup[0].ticket_id + ').' };
  }
  const clusters = await q('SELECT * FROM clusters WHERE cluster_id = ?', [String(user.cluster_id)]);
  const cluster = clusters[0];
  const cbaEmail = cluster ? normEmail(cluster.cba_email) : '';
  const due = await slaDueDate(priority);
  const year = new Date().getFullYear();
  const seq = await nextId('TKT-' + year);
  const ticketId = 'TKT-' + year + '-' + String(seq).padStart(5, '0');
  const dp = ['Low', 'Medium', 'High'].indexOf(user.default_priority) >= 0 ? user.default_priority : 'Medium';
  await run('INSERT INTO tickets (ticket_id,title,description,category,priority,status,raised_by_email,raised_by_name,raised_by_phone,department,cluster_id,cba_email,analyst_email,approval_required,approval_status,approved_by,attachment_links,due_at,created_at,updated_at,resolved_at,closed_at,rating,feedback) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [ticketId, title, String(p.description).trim(), String(p.category || 'Other').trim(), priority, 'NEW',
     normEmail(user.email), user.name, user.phone || '', String(p.department || user.department || '').trim(),
     user.cluster_id || '', cbaEmail, '', 'FALSE', 'NONE', '', '', due, now(), now(), '', '', '', '']);
  let ticket = (await q('SELECT * FROM tickets WHERE ticket_id = ?', [ticketId]))[0];
  await log(ticketId, user, 'CREATED', '', priority, 'Ticket raised');
  await logActivity(user, 'TICKET_CREATE', ticketId);

  if (p.assignTo) {
    const assignee = await resolveAssignee(user, ticket, p.assignTo);
    await run("UPDATE tickets SET analyst_email = ?, status = 'ASSIGNED', updated_at = ? WHERE ticket_id = ?",
      [normEmail(assignee.email), now(), ticketId]);
    ticket = (await q('SELECT * FROM tickets WHERE ticket_id = ?', [ticketId]))[0];
    await log(ticketId, user, 'ASSIGNED', '', normEmail(assignee.email), 'Assigned on create');
    await logActivity(user, 'ASSIGN', ticketId + ' -> ' + assignee.email);
  }

  try {
    if (cbaEmail && cbaEmail !== normEmail(user.email)) await sendMail({ to: cbaEmail, tpl: 'newTicketToCba', vars: { ticketId, title, priority, category: ticket.category, requesterName: ticket.raised_by_name, requesterEmail: ticket.raised_by_email } });
    await sendMail({ to: normEmail(ticket.raised_by_email), tpl: 'ticketCreatedToUser', vars: { ticketId, title, priority, dueAt: ticket.due_at } });
    if (ticket.analyst_email && normEmail(ticket.analyst_email) !== normEmail(user.email)) await sendMail({ to: normEmail(ticket.analyst_email), tpl: 'assignedToAnalyst', vars: { ticketId, title, priority, requesterName: ticket.raised_by_name, dueAt: ticket.due_at, actorName: user.name } });
    if (ticket.analyst_email && normEmail(ticket.raised_by_email) !== normEmail(ticket.analyst_email)) await sendMail({ to: normEmail(ticket.raised_by_email), tpl: 'assignedToRequester', vars: { ticketId, title, analystEmail: ticket.analyst_email, requesterName: ticket.raised_by_name } });
  } catch (e) { /* non-fatal */ }
  return publicTicket(ticket);
}

async function list(user, f) {
  f = f || {};
  let rows = await q('SELECT * FROM tickets');
  const vis = [];
  for (const t of rows) { if (await canSee(user, t)) vis.push(t); }
  rows = vis;
  if (f.status) rows = rows.filter(t => String(t.status) === f.status);
  if (f.priority) rows = rows.filter(t => String(t.priority) === f.priority);
  if (f.clusterId && String(user.Role || user.role).toUpperCase() === 'ADMIN') rows = rows.filter(t => String(t.cluster_id) === String(f.clusterId));
  if (f.analyst) rows = rows.filter(t => normEmail(t.analyst_email) === normEmail(f.analyst));
  if (f.from) rows = rows.filter(t => toMs(t.created_at) >= toMs(f.from));
  if (f.to) rows = rows.filter(t => toMs(t.created_at) <= toMs(f.to));
  if (f.q) {
    const s = String(f.q).toLowerCase();
    rows = rows.filter(t => (t.ticket_id + ' ' + t.title + ' ' + t.description + ' ' + t.raised_by_name + ' ' + t.department).toLowerCase().indexOf(s) >= 0);
  }
  rows.sort((a, b) => toMs(b.updated_at || b.created_at) - toMs(a.updated_at || a.created_at));
  const total = rows.length;
  const page = Math.max(1, Number(f.page) || 1);
  const pageSize = Math.max(1, Number(f.pageSize) || 20);
  const start = (page - 1) * pageSize;
  const out = [];
  for (const t of rows.slice(start, start + pageSize)) out.push(await publicTicket(t));
  return { rows: out, total, page, pageSize };
}

async function get(user, p) {
  const ts = await q('SELECT * FROM tickets WHERE ticket_id = ?', [String(p.ticketId)]);
  const t = ts[0];
  if (!t) throw new Error('Ticket not found.');
  if (!(await canSee(user, t))) throw new Error('You do not have access to this ticket.');
  const logs = (await q('SELECT * FROM ticket_logs WHERE ticket_id = ? ORDER BY timestamp', [String(p.ticketId)]))
    .map(l => ({ action: l.action, byEmail: normEmail(l.by_email), byRole: l.by_role, oldValue: l.old_value, newValue: l.new_value, note: l.note, at: l.timestamp }));
  const comments = (await q('SELECT * FROM comments WHERE ticket_id = ? ORDER BY timestamp', [String(p.ticketId)]))
    .map(c => ({ commentId: c.comment_id, byEmail: normEmail(c.by_email), byName: c.by_name, text: c.text, at: c.timestamp }));
  const approvals = (await q('SELECT * FROM approvals WHERE ticket_id = ?', [String(p.ticketId)]))
    .map(a => ({ approvalId: a.approval_id, approverEmail: normEmail(a.approver_email), requestedBy: normEmail(a.requested_by_email), note: a.request_note, status: a.status, decisionNote: a.decision_note, requestedAt: a.requested_at, expiresAt: a.expires_at, decidedAt: a.decided_at }));
  const reassigns = (await q('SELECT * FROM reassign_requests WHERE ticket_id = ?', [String(p.ticketId)]))
    .map(r => ({ reqId: r.req_id, fromAnalyst: normEmail(r.from_analyst), toAnalyst: normEmail(r.to_analyst), reason: r.reason, status: r.status, decisionNote: r.decision_note, requestedAt: r.requested_at, decidedAt: r.decided_at }));
  return Object.assign(await publicTicket(t), { logs, comments, approvals, reassignRequests: reassigns });
}

async function assign(user, p) {
  const ts = await q('SELECT * FROM tickets WHERE ticket_id = ?', [String(p.ticketId)]);
  const t = ts[0];
  if (!t) throw new Error('Ticket not found.');
  if (!(await canSee(user, t))) throw new Error('This ticket is outside your cluster.');
  const st = String(t.status).toUpperCase();
  if (['CLOSED', 'RESOLVED'].indexOf(st) >= 0) throw new Error('Cannot assign a ' + st + ' ticket.');
  const assignee = await resolveAssignee(user, t, p.analystEmail);
  const old = t.analyst_email || '';
  await run("UPDATE tickets SET analyst_email = ?, status = 'ASSIGNED', updated_at = ? WHERE ticket_id = ?",
    [normEmail(assignee.email), now(), t.ticket_id]);
  await log(t.ticket_id, user, 'ASSIGNED', old, normEmail(assignee.email), p.note || '');
  await logActivity(user, 'ASSIGN', t.ticket_id + ' -> ' + assignee.email);
  const fresh = (await q('SELECT * FROM tickets WHERE ticket_id = ?', [t.ticket_id]))[0];
  try {
    if (normEmail(assignee.email) !== normEmail(user.email)) await sendMail({ to: normEmail(assignee.email), tpl: 'assignedToAnalyst', vars: { ticketId: t.ticket_id, title: t.title, priority: t.priority, requesterName: t.raised_by_name, dueAt: t.due_at, actorName: user.name } });
    if (normEmail(fresh.raised_by_email) !== normEmail(assignee.email)) await sendMail({ to: normEmail(fresh.raised_by_email), tpl: 'assignedToRequester', vars: { ticketId: t.ticket_id, title: t.title, analystEmail: fresh.analyst_email, requesterName: fresh.raised_by_name } });
  } catch (e) { /* non-fatal */ }
  return publicTicket(fresh);
}

async function myAnalysts(user) {
  const role = String(user.Role || user.role).toUpperCase();
  const clusters = {};
  (await q('SELECT * FROM clusters')).forEach(c => { clusters[String(c.cluster_id)] = c.name; });
  const users = await q("SELECT * FROM users WHERE UPPER(status)='ACTIVE'");
  const list = users.filter(u => {
    const r = String(u.role).toUpperCase();
    if (role === 'ADMIN') return r === 'ANALYST' || r === 'CBA';
    if (r !== 'ANALYST') return false;
    return String(u.cluster_id) === String(user.cluster_id);
  }).map(u => ({ email: normEmail(u.email), name: u.name, role: String(u.role).toUpperCase(), clusterId: u.cluster_id || '', clusterName: clusters[String(u.cluster_id)] || u.cluster_id || '' }));
  list.unshift({ email: normEmail(user.email), name: user.name + ' (me)', role, clusterId: user.cluster_id || '', clusterName: clusters[String(user.cluster_id)] || user.cluster_id || '', self: true });
  return list;
}

async function updateStatus(user, p) {
  const ts = await q('SELECT * FROM tickets WHERE ticket_id = ?', [String(p.ticketId)]);
  const t = ts[0];
  if (!t) throw new Error('Ticket not found.');
  if (!(await canSee(user, t))) throw new Error('Access denied.');
  const to = String(p.status || '').toUpperCase();
  const from = String(t.status || '').toUpperCase();
  if (TICKET_STATUSES.indexOf(to) === -1) throw new Error('Invalid status.');
  const role = String(user.Role || user.role).toUpperCase();
  if (role === 'ANALYST' && normEmail(t.analyst_email) !== normEmail(user.email)) throw new Error('This ticket is not assigned to you.');
  if (role === 'ANALYST' || role === 'CBA') {
    const allowed = { ASSIGNED: ['IN_PROGRESS'], IN_PROGRESS: ['ON_HOLD', 'RESOLVED'], ON_HOLD: ['IN_PROGRESS'], PENDING_APPROVAL: ['IN_PROGRESS'], REOPENED: ['IN_PROGRESS', 'ASSIGNED'], NEW: ['IN_PROGRESS'] };
    // A manager (the cluster's CBA) can resolve any open ticket directly —
    // assigned to someone else, or never started — bypassing the state machine.
    const directResolve = role === 'CBA' && to === 'RESOLVED' && from !== 'RESOLVED' && from !== 'CLOSED';
    if (!directResolve && (allowed[from] || []).indexOf(to) === -1) throw new Error('Cannot move from ' + from + ' to ' + to + '.');
  }
  if (to === 'RESOLVED') await run('UPDATE tickets SET status=?, updated_at=?, resolved_at=? WHERE ticket_id=?', [to, now(), now(), t.ticket_id]);
  else await run('UPDATE tickets SET status=?, updated_at=? WHERE ticket_id=?', [to, now(), t.ticket_id]);
  await log(t.ticket_id, user, 'STATUS_CHANGED', from, to, p.note || '');
  await logActivity(user, 'TICKET_UPDATE', t.ticket_id + ' -> ' + to);
  const fresh = (await q('SELECT * FROM tickets WHERE ticket_id = ?', [t.ticket_id]))[0];
  try {
    const recips = new Set([normEmail(fresh.raised_by_email), normEmail(fresh.analyst_email), normEmail(fresh.cba_email)].filter(Boolean));
    recips.delete(normEmail(user.email));
    for (const r of recips) await sendMail({ to: r, tpl: 'statusChange', vars: { ticketId: t.ticket_id, title: t.title, status: to, actorName: user.name } });
  } catch (e) { /* non-fatal */ }
  return publicTicket(fresh);
}

async function mustOwn(user, ticketId) {
  const ts = await q('SELECT * FROM tickets WHERE ticket_id = ?', [String(ticketId)]);
  const t = ts[0];
  if (!t) throw new Error('Ticket not found.');
  const role = String(user.Role || user.role).toUpperCase();
  const owner = normEmail(t.raised_by_email) === normEmail(user.email);
  if (role !== 'ADMIN' && !owner) throw new Error('Only the requester can do this.');
  return t;
}

async function close(user, p) {
  const ts = await q('SELECT * FROM tickets WHERE ticket_id = ?', [String(p.ticketId)]);
  const t = ts[0];
  if (!t) throw new Error('Ticket not found.');
  const role = String(user.Role || user.role).toUpperCase();
  const owner = normEmail(t.raised_by_email) === normEmail(user.email);
  // Requester, the cluster's manager (CBA) or any admin can close.
  if (!owner && role !== 'ADMIN' && role !== 'CBA') throw new Error('Only the requester, your manager or an admin can close this ticket.');
  if (!owner && role === 'CBA' && !(await canSee(user, t))) throw new Error('This ticket is outside your cluster.');
  const st = String(t.status).toUpperCase();
  if (st === 'CLOSED') throw new Error('This ticket is already closed.');
  await run("UPDATE tickets SET status='CLOSED', closed_at=?, updated_at=? WHERE ticket_id=?", [now(), now(), t.ticket_id]);
  await log(t.ticket_id, user, 'CLOSED', st, 'CLOSED', p.note || '');
  const fresh = (await q('SELECT * FROM tickets WHERE ticket_id = ?', [t.ticket_id]))[0];
  return publicTicket(fresh);
}

async function reopen(user, p) {
  const t = await mustOwn(user, p.ticketId);
  const st = String(t.status).toUpperCase();
  if (['RESOLVED', 'CLOSED'].indexOf(st) === -1) throw new Error('Only resolved/closed tickets can be reopened.');
  if (!p.reason || !String(p.reason).trim()) throw new Error('Please give a reason for reopening.');
  await run("UPDATE tickets SET status='REOPENED', closed_at='', resolved_at='', updated_at=? WHERE ticket_id=?", [now(), t.ticket_id]);
  await log(t.ticket_id, user, 'REOPENED', st, 'REOPENED', String(p.reason).trim());
  const fresh = (await q('SELECT * FROM tickets WHERE ticket_id = ?', [t.ticket_id]))[0];
  try {
    const recips = new Set([normEmail(fresh.raised_by_email), normEmail(fresh.analyst_email), normEmail(fresh.cba_email)].filter(Boolean));
    recips.delete(normEmail(user.email));
    for (const r of recips) await sendMail({ to: r, tpl: 'statusChange', vars: { ticketId: t.ticket_id, title: t.title, status: 'REOPENED', actorName: user.name } });
  } catch (e) { /* non-fatal */ }
  return publicTicket(fresh);
}

async function rate(user, p) {
  const t = await mustOwn(user, p.ticketId);
  if (String(t.status).toUpperCase() !== 'CLOSED') throw new Error('You can rate only closed tickets.');
  if (t.rating !== '' && t.rating != null) throw new Error('This ticket is already rated.');
  const rating = Number(p.rating);
  if (!(rating >= 1 && rating <= 5)) throw new Error('Rating must be between 1 and 5.');
  await run('UPDATE tickets SET rating=?, feedback=? WHERE ticket_id=?', [rating, String(p.feedback || '').trim(), t.ticket_id]);
  await log(t.ticket_id, user, 'RATED', '', String(rating), String(p.feedback || '').trim());
  return { rating };
}

async function addComment(user, p) {
  const ts = await q('SELECT * FROM tickets WHERE ticket_id = ?', [String(p.ticketId)]);
  const t = ts[0];
  if (!t) throw new Error('Ticket not found.');
  if (!(await canSee(user, t))) throw new Error('Access denied.');
  if (!p.text || !String(p.text).trim()) throw new Error('Comment cannot be empty.');
  await run('INSERT INTO comments (comment_id, ticket_id, by_email, by_name, text, timestamp) VALUES (?,?,?,?,?,?)',
    [randomToken().slice(0, 12), t.ticket_id, normEmail(user.email), user.name, String(p.text).trim(), now()]);
  await run('UPDATE tickets SET updated_at=? WHERE ticket_id=?', [now(), t.ticket_id]);
  await log(t.ticket_id, user, 'COMMENT', '', '', String(p.text).trim().slice(0, 120));
  await logActivity(user, 'COMMENT', t.ticket_id);
  try {
    const recips = new Set([normEmail(t.raised_by_email), normEmail(t.analyst_email), normEmail(t.cba_email)].filter(Boolean));
    recips.delete(normEmail(user.email));
    for (const r of recips) await sendMail({ to: r, tpl: 'comment', vars: { ticketId: t.ticket_id, actorName: user.name, text: String(p.text).trim() } });
  } catch (e) { /* non-fatal */ }
  return { commentId: 'ok' };
}

async function dashboard(user) {
  const role = String(user.Role || user.role).toUpperCase();
  const all = await q('SELECT * FROM tickets');
  const tickets = [];
  for (const t of all) { if (await canSee(user, t)) tickets.push(t); }
  const byStatus = {}, byPriority = {}, byCluster = {};
  let open = 0, closed = 0, unassigned = 0, mine = 0, overdue = 0;
  for (const t of tickets) {
    const st = String(t.status).toUpperCase();
    byStatus[st] = (byStatus[st] || 0) + 1;
    byPriority[t.priority] = (byPriority[t.priority] || 0) + 1;
    byCluster[t.cluster_id] = (byCluster[t.cluster_id] || 0) + 1;
    if (OPEN_STATES.indexOf(st) >= 0) open++; else if (st === 'CLOSED') closed++;
    if (!t.analyst_email) unassigned++;
    if (normEmail(t.analyst_email) === normEmail(user.email)) mine++;
    if (toMs(t.due_at) && Date.now() > toMs(t.due_at) && st !== 'CLOSED' && st !== 'RESOLVED') overdue++;
  }
  const recent = [];
  tickets.sort((a, b) => toMs(b.created_at) - toMs(a.created_at));
  for (const t of tickets.slice(0, 5)) recent.push(await publicTicket(t));
  const out = { total: tickets.length, open, closed, unassigned, assignedToMe: mine, overdue, byStatus, byPriority, byCluster, recent, role, clusterId: user.cluster_id || '' };
  if (role === 'CBA' || role === 'ADMIN') {
    const rr = await q("SELECT * FROM reassign_requests WHERE UPPER(status)='PENDING'");
    out.pendingReassignments = rr.filter(r => role === 'ADMIN' || normEmail(r.cba_email) === normEmail(user.email)).length;
    out.pendingApprovals = tickets.filter(t => String(t.approval_status).toUpperCase() === 'PENDING').length;
  }
  return out;
}

module.exports = { canSee, log, publicTicket, create, list, get, assign, myAnalysts, updateStatus, close, reopen, rate, addComment, dashboard, mustOwn, OPEN_STATES };
