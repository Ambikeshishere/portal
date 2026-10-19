CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT UNIQUE,
  name TEXT, email TEXT UNIQUE, phone TEXT, department TEXT,
  default_priority TEXT, role TEXT, cluster_id TEXT, reports_to TEXT,
  status TEXT, created_at TEXT, last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster_id TEXT UNIQUE, name TEXT, cba_email TEXT, status TEXT
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT UNIQUE, title TEXT, description TEXT, category TEXT,
  priority TEXT, status TEXT, raised_by_email TEXT, raised_by_name TEXT,
  raised_by_phone TEXT, department TEXT, cluster_id TEXT, cba_email TEXT,
  analyst_email TEXT, approval_required TEXT, approval_status TEXT,
  approved_by TEXT, attachment_links TEXT, due_at TEXT, created_at TEXT,
  updated_at TEXT, resolved_at TEXT, closed_at TEXT, rating TEXT, feedback TEXT
);
CREATE TABLE IF NOT EXISTS ticket_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_id TEXT, ticket_id TEXT, action TEXT, by_email TEXT, by_role TEXT,
  old_value TEXT, new_value TEXT, note TEXT, timestamp TEXT
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id TEXT, ticket_id TEXT, by_email TEXT, by_name TEXT, text TEXT, timestamp TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id TEXT, ticket_id TEXT, requested_by_email TEXT, approver_email TEXT,
  token_hash TEXT, status TEXT, request_note TEXT, decision_note TEXT,
  requested_at TEXT, expires_at TEXT, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS reassign_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  req_id TEXT, ticket_id TEXT, from_analyst TEXT, to_analyst TEXT, reason TEXT,
  status TEXT, cba_email TEXT, decision_note TEXT, requested_at TEXT, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS otp (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT, code TEXT, expires_at TEXT, attempts INTEGER, created_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE, email TEXT, role TEXT, created_at TEXT, expires_at TEXT, last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT, email TEXT, role TEXT, event TEXT, meta TEXT
);
CREATE TABLE IF NOT EXISTS mail_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id TEXT, "to" TEXT, subject TEXT, html_body TEXT, reply_to TEXT,
  status TEXT, attempts INTEGER, created_at TEXT, sent_at TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY, value TEXT
);
CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY, value INTEGER, updated_at TEXT
);
