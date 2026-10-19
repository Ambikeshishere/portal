const Auth = require('./auth');
const Tickets = require('./tickets');
const Approvals = require('./approvals');
const Reassign = require('./reassign');
const Admin = require('./admin');
const { normEmail } = require('./helpers');

const PUBLIC_API = {
  signup: p => Auth.signup(p),
  requestOtp: p => Auth.requestOtp(p),
  verifyOtp: p => Auth.verifyOtp(p),
  loginWithFirebase: p => Auth.loginWithFirebase(p),
  getClusters: () => Admin.publicClusters(),
  getApproval: p => Approvals.getInfo(p.t, p.a),
  decideApproval: p => Approvals.decide(p.t, p.a, p.decision, p.note)
};

const PRIVATE_API = {
  logout: { fn: (u, p) => Auth.logout(p.token), roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
  me: { fn: u => Auth.publicUser(u), roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
  createTicket: { fn: (u, p) => Tickets.create(u, p), roles: ['USER', 'CBA', 'ADMIN'] },
  listTickets: { fn: (u, p) => Tickets.list(u, p), roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
  getTicket: { fn: (u, p) => Tickets.get(u, p), roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
  addComment: { fn: (u, p) => Tickets.addComment(u, p), roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
  assignTicket: { fn: (u, p) => Tickets.assign(u, p), roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
  updateStatus: { fn: (u, p) => Tickets.updateStatus(u, p), roles: ['ANALYST', 'CBA', 'ADMIN'] },
  closeTicket: { fn: (u, p) => Tickets.close(u, p), roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
  reopenTicket: { fn: (u, p) => Tickets.reopen(u, p), roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
  rateTicket: { fn: (u, p) => Tickets.rate(u, p), roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
  myAnalysts: { fn: u => Tickets.myAnalysts(u), roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
  myActivity: { fn: (u, p) => Admin.myActivity(u, p), roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
  requestApproval: { fn: (u, p) => Approvals.request(u, p), roles: ['CBA', 'ADMIN'] },
  requestReassign: { fn: (u, p) => Reassign.request(u, p), roles: ['ANALYST', 'CBA', 'ADMIN'] },
  listReassign: { fn: u => Reassign.list(u), roles: ['CBA', 'ADMIN'] },
  decideReassign: { fn: (u, p) => Reassign.decide(u, p), roles: ['CBA', 'ADMIN'] },
  teamWorkload: { fn: u => Admin.teamWorkload(u), roles: ['CBA', 'ADMIN'] },
  clusterAnalysts: { fn: u => Admin.clusterAnalysts(u), roles: ['CBA', 'ADMIN'] },
  saveAnalyst: { fn: (u, p) => Admin.saveAnalyst(u, p), roles: ['CBA', 'ADMIN'] },
  removeAnalyst: { fn: (u, p) => Admin.removeAnalyst(u, p), roles: ['CBA', 'ADMIN'] },
  adminUsers: { fn: () => Admin.listUsers(), roles: ['ADMIN'] },
  adminSaveUser: { fn: (u, p) => Admin.saveUser(u, p), roles: ['ADMIN'] },
  adminClusters: { fn: () => Admin.listClusters(), roles: ['ADMIN'] },
  adminSaveCluster: { fn: (u, p) => Admin.saveCluster(u, p), roles: ['ADMIN'] },
  adminAnalytics: { fn: (u, p) => Admin.analytics(u, p), roles: ['ADMIN'] },
  adminActivity: { fn: (u, p) => Admin.activity(u, p), roles: ['ADMIN'] },
  adminMailQueue: { fn: (u, p) => Admin.mailQueue(u, p), roles: ['ADMIN'] },
  adminExportCsv: { fn: (u, p) => Admin.exportCsv(u, p), roles: ['ADMIN'] },
  dashboard: { fn: u => Tickets.dashboard(u), roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] }
};

/** Runs one API call. Always returns { ok, data|error }. */
async function handle(req) {
  const name = String((req && req.api) || '');
  const token = (req && req.token) || '';
  const payload = (req && req.payload) || {};
  try {
    const { ensureSetup } = require('./setup');
    await ensureSetup();
    if (PUBLIC_API[name]) return { ok: true, data: await PUBLIC_API[name](payload) };
    const route = PRIVATE_API[name];
    if (!route) throw new Error('Unknown API: ' + name);
    const user = await Auth.requireSession(token);
    const role = String(user.Role || user.role).toUpperCase();
    if (route.roles.indexOf(role) === -1) throw new Error('Not allowed for your role (' + role + ').');
    return { ok: true, data: await route.fn(user, payload) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

module.exports = { handle, PUBLIC_API, PRIVATE_API };
