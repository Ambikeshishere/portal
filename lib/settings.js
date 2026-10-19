const { toMs, addHours } = require('./helpers');

const ROLES = { USER: 'USER', CBA: 'CBA', ANALYST: 'ANALYST', ADMIN: 'ADMIN' };
const ADMIN_CLUSTER_ID = 'CL-ADMIN';
const ADMIN_CLUSTER_NAME = 'Admin';
const TICKET_STATUSES = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_APPROVAL', 'ON_HOLD', 'RESOLVED', 'CLOSED', 'REOPENED'];
const PRIORITIES = ['Low', 'Medium', 'High'];

const DEFAULT_CONFIG = {
  APP_NAME: 'PW Analytics Ticket Portal',
  ADMIN_EMAIL: 'ambikesh.srivastava@pw.live',
  PORTAL_URL: '',
  ALLOWED_DOMAIN: 'pw.live',
  OTP_EXPIRY_MIN: '5',
  OTP_MAX_ATTEMPTS: '3',
  OTP_RESEND_SEC: '60',
  SESSION_HOURS: '12',
  SLA_HIGH_HRS: '24',
  SLA_MED_HRS: '72',
  SLA_LOW_HRS: '168',
  APPROVAL_EXPIRY_HRS: '72',
  AUTO_CLOSE_DAYS: '3',
  SALT: 'CHANGE-ME-please-set-a-random-salt'
};

let cfgCache = null;
let cfgAt = 0;

/** Loads Config table (cached 5 min). Falls back to defaults. */
async function allCfg() {
  const nowMs = Date.now();
  if (cfgCache && nowMs - cfgAt < 300000) return cfgCache;
  const { q } = require('./db');
  const map = {};
  try {
    const rows = await q('SELECT key, value FROM config');
    rows.forEach(r => { map[String(r.key)] = String(r.value); });
  } catch (e) { /* table not ready */ }
  cfgCache = map;
  cfgAt = nowMs;
  return map;
}

function invalidateCfg() { cfgCache = null; cfgAt = 0; }

async function cfg(key) {
  const map = await allCfg();
  return map[key] !== undefined ? map[key] : DEFAULT_CONFIG[key];
}

async function cfgNum(key) {
  const v = Number(await cfg(key));
  return isNaN(v) ? Number(DEFAULT_CONFIG[key]) : v;
}

async function setCfg(key, value) {
  const { run } = require('./db');
  await run('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(value)]);
  invalidateCfg();
  return true;
}

/** SLA due date (ISO) for a priority, from `from` (default now). */
async function slaDueDate(priority, from) {
  const base = from ? new Date(from) : new Date();
  const hrs = priority === 'High' ? await cfgNum('SLA_HIGH_HRS')
    : priority === 'Low' ? await cfgNum('SLA_LOW_HRS')
    : await cfgNum('SLA_MED_HRS');
  return new Date(base.getTime() + hrs * 3600000).toISOString();
}

module.exports = {
  ROLES, ADMIN_CLUSTER_ID, ADMIN_CLUSTER_NAME, TICKET_STATUSES, PRIORITIES,
  DEFAULT_CONFIG, cfg, cfgNum, setCfg, allCfg, invalidateCfg, slaDueDate
};
