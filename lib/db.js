const { createClient } = require('@libsql/client');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { now } = require('./helpers');

let client = null;

function getClient() {
  if (client) return client;
  client = createClient({ url: config.DB_URL, authToken: config.DB_AUTH_TOKEN });
  return client;
}

/** Run a statement, return rows. */
async function q(sql, args = []) {
  const c = getClient();
  const r = await c.execute({ sql, args });
  return r.rows || [];
}

/** Run a statement, return info (rowsAffected, lastInsertRowid). */
async function run(sql, args = []) {
  const c = getClient();
  return await c.execute({ sql, args });
}

async function init() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const stmts = sql.split(';').map(s => s.trim()).filter(Boolean);
  for (const s of stmts) {
    try { await run(s); } catch (e) { /* ignore */ }
  }
}

/** Next sequential id like the old Db.nextId. key e.g. 'TKT-2026', 'U', 'CL'. */
async function nextId(key) {
  await run("INSERT OR IGNORE INTO counters (key, value, updated_at) VALUES (?, 0, ?)", [key, now()]);
  await run("UPDATE counters SET value = value + 1, updated_at = ? WHERE key = ?", [now(), key]);
  const rows = await q("SELECT value FROM counters WHERE key = ?", [key]);
  return Number(rows[0] && rows[0].value) || 1;
}

module.exports = { getClient, init, q, run, nextId };
