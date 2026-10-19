function now() {
  return new Date().toISOString();
}

function randomToken(len = 32) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function randomOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

function isEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));
}

function toMs(v) {
  if (!v) return 0;
  const d = new Date(v);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function addHours(d, h) {
  const dt = new Date(d);
  dt.setHours(dt.getHours() + h);
  return dt.toISOString();
}

function addDays(d, days) {
  const dt = new Date(d);
  dt.setDate(dt.getDate() + days);
  return dt.toISOString();
}

function fmtDateIST(v) {
  if (!v) return '-';
  try {
    const d = new Date(v);
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(d);
  } catch (e) { return String(v); }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

module.exports = {
  now,
  randomToken,
  randomOtp,
  normEmail,
  isEmail,
  toMs,
  addHours,
  addDays,
  fmtDateIST,
  safeJson
};
