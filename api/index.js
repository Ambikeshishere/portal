const { handle } = require('../lib/routes');
const { ensureSetup } = require('../lib/setup');
const config = require('../lib/config');
const jobs = require('../lib/jobs');

let inited = false;
async function ensure() { if (!inited) { await ensureSetup(); inited = true; } }

function send(res, obj, status = 200, ct = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
  res.end(ct.indexOf('javascript') >= 0 ? obj : JSON.stringify(obj));
}

function parseBody(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => resolve(d));
  });
}

function cbWrap(res, cb, obj) {
  if (cb && /^[A-Za-z_$][\w$]*$/.test(cb)) return send(res, cb + '(' + JSON.stringify(obj) + ');', 200, 'application/javascript; charset=utf-8');
  send(res, obj);
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, { ok: true });
  const u = new URL(req.url, 'http://localhost');
  const path = u.pathname;

  // Cron endpoints (guarded by x-cron-secret)
  if (path.startsWith('/api/cron/')) {
    const job = path.split('/api/cron/')[1];
    const secret = req.headers['x-cron-secret'] || u.searchParams.get('secret');
    if (secret !== config.CRON_SECRET) return send(res, { ok: false, error: 'unauthorized' }, 401);
    await ensure();
    const map = { drain: jobs.drainMailQueue, reminders: jobs.dailyReminders, sla: jobs.hourlySlaCheck, cleanup: jobs.cleanupExpired };
    const fn = map[job];
    if (!fn) return send(res, { ok: false, error: 'unknown job' }, 404);
    try { return send(res, { ok: true, data: await fn() }); }
    catch (e) { return send(res, { ok: false, error: String(e) }); }
  }

  if (path === '/api/health') return send(res, { ok: true, data: { status: 'ok' } });

  await ensure();
  const cb = u.searchParams.get('callback');
  let reqObj = {};
  if (req.method === 'GET') {
    const api = u.searchParams.get('api');
    if (!api) return cbWrap(res, cb, { ok: false, error: 'Missing api' });
    let payload = {};
    try { payload = u.searchParams.get('payload') ? JSON.parse(u.searchParams.get('payload')) : {}; } catch (e) {}
    reqObj = { api, token: u.searchParams.get('token') || '', payload };
  } else {
    const raw = await parseBody(req);
    try { reqObj = JSON.parse(raw || '{}'); } catch (e) { return cbWrap(res, cb, { ok: false, error: 'Malformed request body.' }); }
  }
  const result = await handle(reqObj);
  cbWrap(res, cb, result);
};
