const { q, run } = require('./db');
const { normEmail, now, toMs } = require('./helpers');
const { cfgNum } = require('./settings');
const { sendBatch } = require('./mail');

const OPEN_STATES = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED', 'PENDING_APPROVAL'];

async function openTickets() {
  return (await q('SELECT * FROM tickets')).filter(t => OPEN_STATES.indexOf(String(t.status).toUpperCase()) >= 0);
}

/** Sends up to 25 queued mails via the Apps Script mail API. */
async function drainMailQueue() {
  const pending = (await q("SELECT * FROM mail_queue WHERE UPPER(status)='PENDING' ORDER BY id LIMIT 25"));
  if (!pending.length) return { sent: 0, failed: 0 };
  const mails = pending.map(r => ({ to: r.to, tpl: r.tpl, vars: JSON.parse(r.html_body || '{}'), replyTo: r.reply_to || undefined }));
  const res = await sendBatch(mails);
  const results = (res && res.ok && res.data && res.data.results) || [];
  let sent = 0, failed = 0;
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    const r = results[i] || { ok: !!(res && res.ok) };
    if (r.ok) { await run("UPDATE mail_queue SET status='SENT', attempts=attempts+1, sent_at=?, error='' WHERE id=?", [now(), p.id]); sent++; }
    else { await run("UPDATE mail_queue SET status='FAILED', attempts=attempts+1, error=? WHERE id=?", [r.error || 'send failed', p.id]); failed++; }
  }
  return { sent, failed };
}

async function dailyReminders() {
  const tickets = await openTickets();
  const unassignedByCba = {};
  tickets.forEach(t => {
    if (!t.analyst_email && t.cba_email) {
      const e = normEmail(t.cba_email);
      (unassignedByCba[e] = unassignedByCba[e] || []).push(t);
    }
  });
  const mails = [];
  Object.keys(unassignedByCba).forEach(cba => {
    const list = unassignedByCba[cba];
    mails.push({ to: cba, tpl: 'dailyUnassigned', vars: { count: list.length, items: list.map(t => ({ id: t.ticket_id, title: t.title, extra: t.priority })) } });
  });
  const byAnalyst = {};
  tickets.forEach(t => {
    if (t.analyst_email) { const e = normEmail(t.analyst_email); (byAnalyst[e] = byAnalyst[e] || []).push(t); }
  });
  Object.keys(byAnalyst).forEach(a => {
    const list = byAnalyst[a];
    mails.push({ to: a, tpl: 'dailyOpen', vars: { count: list.length, items: list.map(t => ({ id: t.ticket_id, title: t.title, extra: t.status })) } });
  });
  if (mails.length) await sendBatch(mails);
  return { digests: mails.length };
}

async function hourlySlaCheck() {
  const warnWindow = 4 * 3600000;
  const mails = [];
  const adminEmail = normEmail((await q("SELECT value FROM config WHERE key='ADMIN_EMAIL'"))[0]?.value || '');
  for (const t of await q('SELECT * FROM tickets')) {
    const st = String(t.status).toUpperCase();
    if (OPEN_STATES.indexOf(st) === -1) continue;
    const due = toMs(t.due_at);
    if (!due) continue;
    const remaining = due - Date.now();
    if (remaining < 0) {
      const to = [t.cba_email, adminEmail].filter(Boolean).join(',');
      mails.push({ to, tpl: 'overdue', vars: { ticketId: t.ticket_id, title: t.title, priority: t.priority, dueAt: t.due_at } });
    } else if (remaining < warnWindow && t.cba_email) {
      mails.push({ to: normEmail(t.cba_email), tpl: 'slaWarning', vars: { ticketId: t.ticket_id, title: t.title, priority: t.priority, dueAt: t.due_at } });
    }
  }
  if (mails.length) await sendBatch(mails);
  return { warnings: mails.length };
}

async function cleanupExpired() {
  const nowMs = Date.now();
  const otps = await q('SELECT * FROM otp');
  for (const o of otps) if (toMs(o.expires_at) < nowMs) await run('DELETE FROM otp WHERE id=?', [o.id]);
  const sess = await q('SELECT * FROM sessions');
  for (const s of sess) if (toMs(s.expires_at) < nowMs) await run('DELETE FROM sessions WHERE id=?', [s.id]);
  const apps = await q("SELECT * FROM approvals WHERE UPPER(status)='PENDING'");
  for (const a of apps) if (toMs(a.expires_at) < nowMs) await run("UPDATE approvals SET status='EXPIRED' WHERE id=?", [a.id]);
  const autoCloseDays = Number(await cfgNum('AUTO_CLOSE_DAYS'));
  const autoCloseMs = autoCloseDays * 86400000;
  const resolved = await q("SELECT * FROM tickets WHERE UPPER(status)='RESOLVED'");
  let closed = 0;
  for (const t of resolved) {
    if (toMs(t.resolved_at) && (nowMs - toMs(t.resolved_at)) > autoCloseMs) {
      await run("UPDATE tickets SET status='CLOSED', closed_at=?, updated_at=? WHERE id=?", [now(), now(), t.id]);
      closed++;
    }
  }
  return { closed };
}

module.exports = { drainMailQueue, dailyReminders, hourlySlaCheck, cleanupExpired };
