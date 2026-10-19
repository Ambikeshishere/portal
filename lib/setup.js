const { q, run, nextId } = require('./db');
const { normEmail, now } = require('./helpers');
const { DEFAULT_CONFIG, ADMIN_CLUSTER_ID, ADMIN_CLUSTER_NAME, ROLES, invalidateCfg } = require('./settings');

const SETUP_VERSION = 1;
let inited = false;

async function seedConfig() {
  const existing = {};
  (await q('SELECT key FROM config')).forEach(r => { existing[String(r.key)] = true; });
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (existing[k]) continue;
    const v = DEFAULT_CONFIG[k];
    await run('INSERT INTO config (key, value) VALUES (?, ?)', [k, String(v)]);
  }
  invalidateCfg();
}

async function seedAdminCluster() {
  const existing = (await q('SELECT id FROM clusters WHERE cluster_id = ?', [ADMIN_CLUSTER_ID]))[0];
  if (existing) return existing;
  const { cfg } = require('./settings');
  await run('INSERT INTO clusters (cluster_id, name, cba_email, status) VALUES (?,?,?,?)',
    [ADMIN_CLUSTER_ID, ADMIN_CLUSTER_NAME, normEmail(await cfg('ADMIN_EMAIL')), 'ACTIVE']);
}

async function seedAdmin() {
  const { cfg } = require('./settings');
  const email = normEmail(await cfg('ADMIN_EMAIL'));
  const existing = (await q('SELECT * FROM users WHERE email = ?', [email]))[0];
  if (existing) {
    if (String(existing.cluster_id) !== ADMIN_CLUSTER_ID) await run('UPDATE users SET cluster_id = ? WHERE id = ?', [ADMIN_CLUSTER_ID, existing.id]);
    return existing;
  }
  const seq = await nextId('U');
  const userId = 'U-' + String(seq).padStart(5, '0');
  await run('INSERT INTO users (user_id,name,email,phone,department,default_priority,role,cluster_id,reports_to,status,created_at,last_login_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [userId, 'Ambikesh Srivastava', email, '', 'Analytics', 'Medium', ROLES.ADMIN, ADMIN_CLUSTER_ID, '', 'ACTIVE', now(), '']);
}

/** Runs once per process: schema + seeds. Safe to call on every request. */
async function ensureSetup() {
  if (inited) return;
  const { init } = require('./db');
  await init();
  const ver = (await q("SELECT value FROM config WHERE key='SETUP_VERSION'"))[0];
  if (ver && String(ver.value) === String(SETUP_VERSION)) { inited = true; return; }
  await seedConfig();
  await seedAdminCluster();
  await seedAdmin();
  await run("INSERT INTO config (key, value) VALUES ('SETUP_VERSION', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [String(SETUP_VERSION)]);
  invalidateCfg();
  inited = true;
}

module.exports = { ensureSetup };
