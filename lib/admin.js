const { q, run, nextId } = require('./db');
const { normEmail, now, toMs } = require('./helpers');
const { ROLES, PRIORITIES, ADMIN_CLUSTER_ID, cfg, cfgNum } = require('./settings');
const { logActivity, killSessions, publicUser } = require('./auth');
const { sendMail } = require('./mail');

async function publicClusters() {
  const rows = await q("SELECT * FROM clusters WHERE UPPER(status)='ACTIVE' OR status IS NULL OR status=''");
  return rows.map(c => ({ clusterId: String(c.cluster_id), name: c.name }));
}

async function teamWorkload(user) {
  const role = String(user.Role || user.role).toUpperCase();
  const users = await q("SELECT * FROM users WHERE UPPER(role)='ANALYST'");
  const analysts = users.filter(u => role === 'ADMIN' || String(u.cluster_id) === String(user.cluster_id));
  const tickets = await q('SELECT * FROM tickets').then(rows => role === 'ADMIN' ? rows : rows.filter(t => String(t.cluster_id) === String(user.cluster_id)));
  const openStates = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED', 'PENDING_APPROVAL'];
  return analysts.map(a => {
    const mine = tickets.filter(t => normEmail(t.analyst_email) === normEmail(a.email));
    return { email: normEmail(a.email), name: a.name, clusterId: a.cluster_id, open: mine.filter(t => openStates.indexOf(String(t.status).toUpperCase()) >= 0).length, total: mine.length };
  }).sort((x, y) => y.open - x.open);
}

async function listUsers() {
  const rows = await q('SELECT * FROM users');
  return rows.map(u => ({ userId: u.user_id, name: u.name || '', email: normEmail(u.email), phone: u.phone || '', department: u.department || '', defaultPriority: u.default_priority || 'Medium', role: String(u.role || 'USER').toUpperCase(), clusterId: u.cluster_id || '', reportsTo: normEmail(u.reports_to), status: String(u.status || 'ACTIVE').toUpperCase(), createdAt: u.created_at || '', lastLoginAt: u.last_login_at || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function saveUser(user, p) {
  const u = p.user || {};
  const email = normEmail(u.email);
  if (!email) throw new Error('Email is required.');
  const role = String(u.role || 'USER').toUpperCase();
  if ([ROLES.USER, ROLES.CBA, ROLES.ANALYST, ROLES.ADMIN].indexOf(role) === -1) throw new Error('Invalid role.');
  const status = String(u.status || 'ACTIVE').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
  const existing = (await q('SELECT * FROM users WHERE email = ?', [email]))[0];
  if (existing) {
    const roleChanged = String(existing.role).toUpperCase() !== role;
    const statusChanged = String(existing.status || 'ACTIVE').toUpperCase() !== status;
    await run('UPDATE users SET name=?, phone=?, department=?, default_priority=?, role=?, cluster_id=?, reports_to=?, status=? WHERE id=?',
      [u.name || existing.name, u.phone !== undefined ? u.phone : existing.phone, u.department !== undefined ? u.department : existing.department,
       PRIORITIES.indexOf(u.defaultPriority) >= 0 ? u.defaultPriority : existing.default_priority, role,
       u.clusterId !== undefined ? u.clusterId : existing.cluster_id, u.reportsTo !== undefined ? normEmail(u.reportsTo) : existing.reports_to, status, existing.id]);
    if (roleChanged || statusChanged) await killSessions(email);
    await logActivity(user, 'USER_UPDATED', email + ' (' + role + ')');
    return { email, updated: true };
  }
  if (!u.name) throw new Error('Name is required for a new user.');
  const seq = await nextId('U');
  const userId = 'U-' + String(seq).padStart(5, '0');
  await run('INSERT INTO users (user_id,name,email,phone,department,default_priority,role,cluster_id,reports_to,status,created_at,last_login_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [userId, u.name, email, u.phone || '', u.department || '', PRIORITIES.indexOf(u.defaultPriority) >= 0 ? u.defaultPriority : 'Medium', role, u.clusterId || '', normEmail(u.reportsTo), status, now(), '']);
  await logActivity(user, 'USER_CREATED', email + ' (' + role + ')');
  try { await sendMail({ to: email, tpl: 'welcome', vars: { name: u.name } }); } catch (e) { /* non-fatal */ }
  return { email, created: true };
}

async function clusterAnalysts(user) {
  const role = String(user.Role || user.role).toUpperCase();
  const rows = await q("SELECT * FROM users WHERE UPPER(role)='ANALYST'");
  return rows.filter(u => role === 'ADMIN' || String(u.cluster_id) === String(user.cluster_id))
    .map(u => ({ email: normEmail(u.email), name: u.name || '', phone: u.phone || '', department: u.department || '', clusterId: u.cluster_id || '', reportsTo: normEmail(u.reports_to), status: String(u.status || 'ACTIVE').toUpperCase(), lastLoginAt: u.last_login_at || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function saveAnalyst(user, p) {
  const a = p.analyst || {};
  const email = normEmail(a.email);
  if (!email) throw new Error('Email is required.');
  const actorRole = String(user.Role || user.role).toUpperCase();
  const clusterId = actorRole === 'ADMIN' ? String(a.clusterId || user.cluster_id || ADMIN_CLUSTER_ID) : String(user.cluster_id);
  if (!clusterId) throw new Error('You are not assigned to a cluster yet.');
  const status = String(a.status || 'ACTIVE').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
  const existing = (await q('SELECT * FROM users WHERE email = ?', [email]))[0];
  if (existing) {
    if (String(existing.role).toUpperCase() !== 'ANALYST') throw new Error('That email belongs to a ' + String(existing.role).toUpperCase() + ', not an analyst.');
    if (actorRole !== 'ADMIN' && String(existing.cluster_id) !== String(user.cluster_id)) throw new Error('That analyst is not in your cluster.');
    const statusChanged = String(existing.status || 'ACTIVE').toUpperCase() !== status;
    await run('UPDATE users SET name=?, phone=?, department=?, cluster_id=?, reports_to=?, status=? WHERE id=?',
      [a.name || existing.name, a.phone !== undefined ? a.phone : existing.phone, a.department !== undefined ? a.department : existing.department, clusterId, a.reportsTo !== undefined ? normEmail(a.reportsTo) : existing.reports_to, status, existing.id]);
    if (statusChanged) await killSessions(email);
    await logActivity(user, 'ANALYST_UPDATED', email + ' (' + clusterId + ')');
    return { email, updated: true };
  }
  if (!a.name || !String(a.name).trim()) throw new Error('Name is required for a new analyst.');
  const seq = await nextId('U');
  const userId = 'U-' + String(seq).padStart(5, '0');
  await run('INSERT INTO users (user_id,name,email,phone,department,default_priority,role,cluster_id,reports_to,status,created_at,last_login_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [userId, String(a.name).trim(), email, a.phone || '', a.department || '', 'Medium', ROLES.ANALYST, clusterId, normEmail(a.reportsTo) || normEmail(user.email), status, now(), '']);
  await logActivity(user, 'ANALYST_CREATED', email + ' (' + clusterId + ')');
  try { await sendMail({ to: email, tpl: 'welcome', vars: { name: String(a.name).trim() } }); } catch (e) { /* non-fatal */ }
  return { email, created: true };
}

async function removeAnalyst(user, p) {
  const email = normEmail(p.email);
  if (!email) throw new Error('Email is required.');
  const target = (await q('SELECT * FROM users WHERE email = ?', [email]))[0];
  if (!target) throw new Error('Analyst not found.');
  if (String(target.role).toUpperCase() !== 'ANALYST') throw new Error('That user is not an analyst.');
  const actorRole = String(user.Role || user.role).toUpperCase();
  if (actorRole !== 'ADMIN' && String(target.cluster_id) !== String(user.cluster_id)) throw new Error('That analyst is not in your cluster.');
  await run("UPDATE users SET status='INACTIVE' WHERE id=?", [target.id]);
  await killSessions(email);
  await logActivity(user, 'ANALYST_REMOVED', email);
  return { email, removed: true };
}

async function listClusters() {
  const rows = await q('SELECT * FROM clusters');
  return rows.map(c => ({ clusterId: String(c.cluster_id), name: c.name, cbaEmail: normEmail(c.cba_email), status: String(c.status || 'ACTIVE').toUpperCase() }));
}

async function saveCluster(user, p) {
  const c = p.cluster || {};
  const id = String(c.clusterId || '').trim();
  const name = String(c.name || '').trim();
  if (!name) throw new Error('Cluster name is required.');
  const cbaEmail = normEmail(c.cbaEmail);
  const status = String(c.status || 'ACTIVE').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
  if (id) {
    const existing = (await q('SELECT * FROM clusters WHERE cluster_id = ?', [id]))[0];
    if (!existing) throw new Error('Cluster not found.');
    await run('UPDATE clusters SET name=?, cba_email=?, status=? WHERE id=?', [name, cbaEmail, status, existing.id]);
    await logActivity(user, 'CLUSTER_UPDATED', id);
    return { clusterId: id, updated: true };
  }
  const seq = await nextId('CL');
  const newId = 'CL-' + String(seq).padStart(5, '0');
  await run('INSERT INTO clusters (cluster_id, name, cba_email, status) VALUES (?,?,?,?)', [newId, name, cbaEmail, status]);
  await logActivity(user, 'CLUSTER_CREATED', newId);
  return { clusterId: newId, created: true };
}

function dayKey(v) {
  const ms = toMs(v);
  if (!ms) return '';
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function rangeMs(p) {
  p = p || {};
  const to = p.to ? toMs(p.to) : Date.now();
  const from = p.from ? toMs(p.from) : to - (Number(p.days) || 30) * 86400000;
  return { from, to, days: Math.round((to - from) / 86400000) };
}

function rankActivity(events, users) {
  const stats = {};
  const bucket = (email, name, role) => {
    email = normEmail(email);
    if (!stats[email]) stats[email] = { email, name: name || '', role: role || '', logins: 0, totalActions: 0, ticketsCreated: 0, comments: 0, lastActive: '', byEvent: {} };
    if (name && !stats[email].name) stats[email].name = name;
    if (role && !stats[email].role) stats[email].role = String(role).toUpperCase();
    return stats[email];
  };
  users.forEach(u => bucket(u.email, u.name, u.role));
  events.forEach(a => {
    const s = bucket(a.email, '', a.role);
    s.totalActions++;
    const ev = String(a.event || '').toUpperCase();
    s.byEvent[ev] = (s.byEvent[ev] || 0) + 1;
    if (ev === 'LOGIN') s.logins++;
    if (ev === 'TICKET_CREATE') s.ticketsCreated++;
    if (ev === 'COMMENT') s.comments++;
    const at = toMs(a.timestamp);
    if (at && (!s.lastActive || at > toMs(s.lastActive))) s.lastActive = a.timestamp;
  });
  return Object.keys(stats).map(k => stats[k]).sort((a, b) => b.totalActions - a.totalActions);
}

async function analytics(user, p) {
  const range = rangeMs(p);
  const allT = await q('SELECT * FROM tickets');
  const tickets = allT.filter(t => toMs(t.created_at) >= range.from && toMs(t.created_at) <= range.to);
  const logs = (await q('SELECT * FROM ticket_logs')).filter(l => toMs(l.timestamp) >= range.from && toMs(l.timestamp) <= range.to);
  const users = await q('SELECT * FROM users');
  const byStatus = {}, byPriority = {}, byCluster = {}, byCategory = {}, trend = {};
  let overdue = 0, resolved = 0;
  tickets.forEach(t => {
    const st = String(t.status).toUpperCase();
    byStatus[st] = (byStatus[st] || 0) + 1;
    byPriority[t.priority] = (byPriority[t.priority] || 0) + 1;
    byCluster[t.cluster_id || '—'] = (byCluster[t.cluster_id || '—'] || 0) + 1;
    byCategory[t.category || 'Other'] = (byCategory[t.category || 'Other'] || 0) + 1;
    const day = dayKey(t.created_at);
    if (day) trend[day] = (trend[day] || 0) + 1;
    if (st === 'RESOLVED' || st === 'CLOSED') resolved++;
    if (t.due_at && toMs(t.due_at) < Date.now() && st !== 'CLOSED' && st !== 'RESOLVED') overdue++;
  });
  const assignMs = {};
  logs.forEach(l => { if (String(l.action) === 'ASSIGNED') assignMs[l.ticket_id] = toMs(l.timestamp); });
  const createdMs = {};
  allT.forEach(t => { createdMs[t.ticket_id] = toMs(t.created_at); });
  const firstAssignByCba = {}, resolveByAnalyst = {}, ratingByAnalyst = {};
  tickets.forEach(t => {
    const aMs = toMs(t.created_at);
    if (assignMs[t.ticket_id] && aMs) { const cba = t.cba_email || '—'; firstAssignByCba[cba] = firstAssignByCba[cba] || { totalHrs: 0, count: 0 }; firstAssignByCba[cba].totalHrs += (assignMs[t.ticket_id] - aMs) / 3600000; firstAssignByCba[cba].count++; }
    if (t.resolved_at && aMs) { const an = normEmail(t.analyst_email) || '—'; resolveByAnalyst[an] = resolveByAnalyst[an] || { totalHrs: 0, count: 0 }; resolveByAnalyst[an].totalHrs += (toMs(t.resolved_at) - aMs) / 3600000; resolveByAnalyst[an].count++; }
    if (t.rating) { const an2 = normEmail(t.analyst_email) || '—'; ratingByAnalyst[an2] = ratingByAnalyst[an2] || { total: 0, count: 0 }; ratingByAnalyst[an2].total += Number(t.rating); ratingByAnalyst[an2].count++; }
  });
  const avgHours = obj => { const out = {}; Object.keys(obj).forEach(k => { out[k] = obj[k].count ? Math.round((obj[k].totalHrs / obj[k].count) * 10) / 10 : 0; }); return out; };
  const avgRating = obj => { const out = {}; Object.keys(obj).forEach(k => { out[k] = obj[k].count ? Math.round((obj[k].total / obj[k].count) * 10) / 10 : 0; }); return out; };
  const activity = (await q('SELECT * FROM activity_log')).filter(a => toMs(a.timestamp) >= range.from && toMs(a.timestamp) <= range.to);
  const active = rankActivity(activity, users);
  const inactive = users.filter(u => { if (String(u.status).toUpperCase() !== 'ACTIVE') return true; const last = toMs(u.last_login_at); return last && (Date.now() - last) > 15 * 86400000; }).map(u => ({ name: u.name, email: normEmail(u.email), role: String(u.role).toUpperCase(), lastLoginAt: u.last_login_at || '' }));
  return { range: { from: range.from, to: range.to, days: range.days }, totals: { total: tickets.length, resolved, overdue, open: tickets.length - resolved }, byStatus, byPriority, byCluster, byCategory, trend, avgFirstAssignHrsByCba: avgHours(firstAssignByCba), avgResolveHrsByAnalyst: avgHours(resolveByAnalyst), avgRatingByAnalyst: avgRating(ratingByAnalyst), mostActive: active, inactiveMembers: inactive, lastLogins: users.map(u => ({ name: u.name, email: normEmail(u.email), role: String(u.role).toUpperCase(), lastLoginAt: u.last_login_at || '' })).sort((a, b) => toMs(b.lastLoginAt) - toMs(a.lastLoginAt)) };
}

async function activity(user, p) {
  const range = rangeMs(p);
  const events = (await q('SELECT * FROM activity_log')).filter(a => toMs(a.timestamp) >= range.from && toMs(a.timestamp) <= range.to);
  return { range, users: rankActivity(events, await q('SELECT * FROM users')) };
}

async function myActivity(user, p) {
  const days = Math.min(Number((p && p.days) || 365), 400);
  const email = normEmail(user.email);
  const from = Date.now() - days * 86400000;
  const events = (await q('SELECT * FROM activity_log')).filter(a => normEmail(a.email) === email && toMs(a.timestamp) >= from);
  const byDay = {}, byEvent = {};
  events.forEach(a => { const k = dayKey(a.timestamp); if (k) byDay[k] = (byDay[k] || 0) + 1; const ev = String(a.event || '').toUpperCase(); byEvent[ev] = (byEvent[ev] || 0) + 1; });
  const recent = events.slice().sort((a, b) => toMs(b.timestamp) - toMs(a.timestamp)).slice(0, 25).map(a => ({ at: a.timestamp, event: String(a.event || '').toUpperCase(), meta: a.meta || '' }));
  const keys = Object.keys(byDay).sort();
  let longest = 0, runLen = 0, prev = null;
  keys.forEach(k => { runLen = (prev && (toMs(k) - toMs(prev)) === 86400000) ? runLen + 1 : 1; if (runLen > longest) longest = runLen; prev = k; });
  let cur = 0, d = new Date();
  if (!byDay[dayKey(d)]) d = new Date(d.getTime() - 86400000);
  while (byDay[dayKey(d)]) { cur++; d = new Date(d.getTime() - 86400000); }
  return { email, name: user.name || '', role: String(user.role || '').toUpperCase(), today: dayKey(now()), total: events.length, activeDays: keys.length, days: byDay, byEvent, recent, streak: { current: cur, longest } };
}

async function mailQueue(user, p) {
  const limit = Math.min(Number((p && p.limit) || 20), 100);
  const all = await q('SELECT * FROM mail_queue');
  const rows = all.slice(-limit).map(r => ({ queueId: r.queue_id, to: r.to, subject: r.subject, status: r.status, attempts: r.attempts, createdAt: r.created_at, sentAt: r.sent_at, error: r.error }));
  return { enabled: true, pending: all.filter(r => String(r.status || 'PENDING').toUpperCase() === 'PENDING').length, total: all.length, drainTriggerInstalled: true, rows };
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const cell = v => { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return headers.join(',') + '\n' + rows.map(r => headers.map(h => cell(r[h])).join(',')).join('\n');
}

async function exportCsv(user, p) {
  const type = String(p.type || 'tickets');
  if (type === 'logs') { const rows = (await q('SELECT * FROM ticket_logs')).map(l => ({ TicketID: l.ticket_id, Action: l.action, ByEmail: l.by_email, ByRole: l.by_role, OldValue: l.old_value, NewValue: l.new_value, Note: l.note, Timestamp: l.timestamp })); return { filename: 'ticket-logs.csv', csv: toCsv(rows) }; }
  if (type === 'activity') { const acts = (await q('SELECT * FROM activity_log')).map(a => ({ Timestamp: a.timestamp, Email: a.email, Role: a.role, Event: a.event, Meta: a.meta })); return { filename: 'activity-log.csv', csv: toCsv(acts) }; }
  const tickets = (await q('SELECT * FROM tickets')).map(t => ({ TicketID: t.ticket_id, Title: t.title, Category: t.category, Priority: t.priority, Status: t.status, RaisedBy: t.raised_by_email, ClusterID: t.cluster_id, Analyst: t.analyst_email, DueAt: t.due_at, CreatedAt: t.created_at, ResolvedAt: t.resolved_at, ClosedAt: t.closed_at, Rating: t.rating }));
  return { filename: 'tickets.csv', csv: toCsv(tickets) };
}

module.exports = { publicClusters, teamWorkload, listUsers, saveUser, clusterAnalysts, saveAnalyst, removeAnalyst, listClusters, saveCluster, analytics, activity, myActivity, mailQueue, exportCsv };
