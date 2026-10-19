const https = require('https');
const http = require('http');
const { URL } = require('url');
const config = require('./config');

function postJson(urlStr, body) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const data = JSON.stringify(body);
      const isHttps = u.protocol === 'https:';
      const lib = isHttps ? https : http;
      const opts = {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        },
        timeout: 30000
      };
      const req = lib.request(opts, (res) => {
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); } catch (e) { resolve({ ok: false, error: 'bad json' }); }
        });
      });
      req.on('error', (e) => resolve({ ok: false, error: String(e) }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
      req.write(data);
      req.end();
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

async function sendBatch(mails, baseUrl) {
  if (!mails || !mails.length) return { ok: true, data: { sent: 0, failed: 0, results: [] } };
  const payload = {
    key: config.MAIL_KEY,
    base: baseUrl || config.PORTAL_BASE_URL,
    mails
  };
  return await postJson(config.MAIL_SCRIPT_URL, payload);
}

async function sendMail({ to, tpl, vars, replyTo, baseUrl }) {
  const r = await sendBatch([{ to, tpl, vars, replyTo }], baseUrl);
  if (r && r.ok) return r.data.results[0] || { ok: true };
  return { ok: false, error: (r && r.error) || 'send failed' };
}

module.exports = { sendBatch, sendMail };
