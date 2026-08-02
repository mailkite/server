// SQLite storage for the reference backend. Zero npm deps: node:sqlite (Node >= 22.5).
// Raw RFC822 bodies live as files under <dataDir>/blobs/ (content-addressed by sha256);
// everything else is rows.

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS domains (
    domain TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS api_keys (
    key TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS app_passwords (
    username TEXT NOT NULL,              -- a mailbox address, e.g. you@yourdomain.com
    hash TEXT NOT NULL,                  -- scrypt(password)
    user_id INTEGER NOT NULL REFERENCES users(id),
    mailbox_id INTEGER                   -- reserved: per-address scoping (null = account-wide)
  );
  CREATE TABLE IF NOT EXISTS mailboxes (
    user_id INTEGER NOT NULL,
    mailbox TEXT NOT NULL,               -- 'INBOX' | 'Sent'
    uidvalidity INTEGER NOT NULL,
    uidnext INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, mailbox)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    mailbox TEXT NOT NULL,
    uid INTEGER NOT NULL,
    flags TEXT NOT NULL DEFAULT '',      -- backslash-less, space-separated ("Seen Flagged")
    internaldate TEXT NOT NULL,          -- ISO-8601
    from_addr TEXT, to_addr TEXT, subject TEXT,
    mailfrom TEXT, rcpt TEXT,            -- envelope
    spf TEXT, dkim TEXT, dmarc TEXT, spam TEXT, spam_verdict TEXT,
    size INTEGER NOT NULL,
    blob TEXT NOT NULL                   -- sha256 filename under blobs/
  );
  CREATE UNIQUE INDEX IF NOT EXISTS msg_uid ON messages(user_id, mailbox, uid);
  CREATE TABLE IF NOT EXISTS auth_fails (           -- IMAP brute-force lockout, per IP
    ip TEXT PRIMARY KEY, count INTEGER NOT NULL, last INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_users (          -- who may sign in to the console
    email TEXT PRIMARY KEY, added INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS login_tokens (         -- magic-link tokens (hashed, single-use)
    token_hash TEXT PRIMARY KEY, email TEXT NOT NULL,
    expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (             -- console sessions (hashed cookie tokens)
    token_hash TEXT PRIMARY KEY, email TEXT NOT NULL,
    created INTEGER NOT NULL, last_seen INTEGER NOT NULL
  );
`;

export class Store {
  constructor(dataDir) {
    mkdirSync(join(dataDir, 'blobs'), { recursive: true });
    this.dataDir = dataDir;
    this.db = new DatabaseSync(join(dataDir, 'mail.db'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.db.exec(SCHEMA);
  }

  // --- accounts / credentials -------------------------------------------------

  addUser(name) {
    this.db.prepare('INSERT OR IGNORE INTO users(name) VALUES (?)').run(name);
    return this.db.prepare('SELECT id FROM users WHERE name = ?').get(name).id;
  }
  addDomain(domain, userId) {
    this.db.prepare('INSERT OR REPLACE INTO domains(domain, user_id) VALUES (?, ?)')
      .run(domain.toLowerCase(), userId);
  }
  domains() {
    return this.db.prepare('SELECT domain FROM domains ORDER BY domain').all().map((r) => r.domain);
  }
  userForDomain(domain) {
    const r = this.db.prepare('SELECT user_id FROM domains WHERE domain = ?').get(domain.toLowerCase());
    return r ? r.user_id : null;
  }
  addApiKey(userId, key = 'mk_local_' + randomBytes(24).toString('base64url')) {
    this.db.prepare('INSERT OR REPLACE INTO api_keys(key, user_id) VALUES (?, ?)').run(key, userId);
    return key;
  }
  userForApiKey(key) {
    const r = this.db.prepare('SELECT user_id FROM api_keys WHERE key = ?').get(key);
    return r ? r.user_id : null;
  }
  addAppPassword(username, userId, password = 'mk_imap_' + randomBytes(18).toString('base64url')) {
    const salt = randomBytes(16);
    const hash = salt.toString('hex') + ':' + scryptSync(password, salt, 32).toString('hex');
    this.db.prepare('INSERT INTO app_passwords(username, hash, user_id) VALUES (?, ?, ?)')
      .run(username.toLowerCase(), hash, userId);
    return password;
  }
  checkAppPassword(username, password) {
    const rows = this.db.prepare('SELECT hash, user_id, mailbox_id FROM app_passwords WHERE username = ?')
      .all(username.toLowerCase());
    for (const r of rows) {
      const [saltHex, hashHex] = r.hash.split(':');
      const got = scryptSync(password, Buffer.from(saltHex, 'hex'), 32);
      if (timingSafeEqual(got, Buffer.from(hashHex, 'hex'))) {
        return { userId: r.user_id, mailboxId: r.mailbox_id ?? null, domain: username.split('@')[1] || '' };
      }
    }
    return null;
  }

  // --- IMAP lockout (per IP, not per user) -------------------------------------

  authFail(ip) {
    if (!ip) return;
    this.db.prepare(`INSERT INTO auth_fails(ip, count, last) VALUES (?, 1, ?)
      ON CONFLICT(ip) DO UPDATE SET count = count + 1, last = excluded.last`).run(ip, Date.now());
  }
  lockedOut(ip, max = 20, windowMs = 15 * 60 * 1000) {
    if (!ip) return false;
    const r = this.db.prepare('SELECT count, last FROM auth_fails WHERE ip = ?').get(ip);
    if (!r) return false;
    if (Date.now() - r.last > windowMs) {
      this.db.prepare('DELETE FROM auth_fails WHERE ip = ?').run(ip);
      return false;
    }
    return r.count >= max;
  }
  authOk(ip) { if (ip) this.db.prepare('DELETE FROM auth_fails WHERE ip = ?').run(ip); }

  // --- console auth: admin users, magic-link tokens, sessions -------------------
  // Raw tokens never touch disk — only sha256 hashes are stored, so a copied
  // database can't be replayed into a session.

  hashToken(raw) { return createHash('sha256').update(String(raw)).digest('hex'); }

  addAdminUser(email) {
    this.db.prepare('INSERT OR IGNORE INTO admin_users(email, added) VALUES (?, ?)')
      .run(email.toLowerCase(), Date.now());
  }
  isAdminUser(email) {
    return !!this.db.prepare('SELECT 1 FROM admin_users WHERE email = ?')
      .get(String(email || '').toLowerCase());
  }
  adminUserCount() { return this.db.prepare('SELECT COUNT(*) c FROM admin_users').get().c; }
  /** Recovery from a squatted first-visitor claim: wipe admins + sessions, seed anew. */
  resetAdmin(email) {
    this.db.prepare('DELETE FROM admin_users').run();
    this.db.prepare('DELETE FROM sessions').run();
    this.addAdminUser(email);
  }

  createLoginToken(email, ttlMs = 15 * 60 * 1000) {
    const raw = 'mk_login_' + randomBytes(24).toString('base64url');
    this.db.prepare('INSERT INTO login_tokens(token_hash, email, expires, used) VALUES (?, ?, ?, 0)')
      .run(this.hashToken(raw), email.toLowerCase(), Date.now() + ttlMs);
    return raw;
  }
  /** Single-use: returns the email once, null on unknown/expired/already-used. */
  consumeLoginToken(raw) {
    const h = this.hashToken(raw);
    const r = this.db.prepare('SELECT email, expires, used FROM login_tokens WHERE token_hash = ?').get(h);
    if (!r || r.used || Date.now() > r.expires) return null;
    this.db.prepare('UPDATE login_tokens SET used = 1 WHERE token_hash = ?').run(h);
    return r.email;
  }

  createSession(email) {
    const raw = 'mk_sess_' + randomBytes(32).toString('base64url');
    const now = Date.now();
    this.db.prepare('INSERT INTO sessions(token_hash, email, created, last_seen) VALUES (?, ?, ?, ?)')
      .run(this.hashToken(raw), email.toLowerCase(), now, now);
    return raw;
  }
  /** Rolling 30-day validity: any use inside the window extends it. */
  sessionEmail(raw, maxIdleMs = 30 * 24 * 60 * 60 * 1000) {
    if (!raw) return null;
    const h = this.hashToken(raw);
    const r = this.db.prepare('SELECT email, last_seen FROM sessions WHERE token_hash = ?').get(h);
    if (!r) return null;
    if (Date.now() - r.last_seen > maxIdleMs) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h);
      return null;
    }
    this.db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(Date.now(), h);
    return r.email;
  }
  deleteSession(raw) {
    if (raw) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(this.hashToken(raw));
  }

  // --- mailboxes / messages -----------------------------------------------------

  mailbox(userId, mailbox) {
    let r = this.db.prepare('SELECT * FROM mailboxes WHERE user_id = ? AND mailbox = ?').get(userId, mailbox);
    if (!r) {
      // uidvalidity: creation time in seconds — stable for the mailbox's life.
      this.db.prepare('INSERT INTO mailboxes(user_id, mailbox, uidvalidity, uidnext) VALUES (?, ?, ?, 1)')
        .run(userId, mailbox, Math.floor(Date.now() / 1000));
      r = this.db.prepare('SELECT * FROM mailboxes WHERE user_id = ? AND mailbox = ?').get(userId, mailbox);
    }
    return r;
  }

  putBlob(raw) {
    const name = createHash('sha256').update(raw).digest('hex');
    const path = join(this.dataDir, 'blobs', name);
    if (!existsSync(path)) writeFileSync(path, raw);
    return name;
  }
  getBlob(name) {
    try { return readFileSync(join(this.dataDir, 'blobs', name)); } catch { return null; }
  }

  /** Content hash of a raw message — the blobs/ filename putBlob() will use. */
  static hashRaw(raw) { return createHash('sha256').update(raw).digest('hex'); }

  /** Ingest idempotency: has this exact message already been stored for this recipient? */
  messageExists(userId, mailbox, blob, rcpt) {
    return !!this.db.prepare(
      'SELECT 1 FROM messages WHERE user_id = ? AND mailbox = ? AND blob = ? AND rcpt = ? LIMIT 1')
      .get(userId, mailbox, blob, rcpt);
  }

  storeMessage(userId, mailbox, raw, meta) {
    const box = this.mailbox(userId, mailbox);
    const uid = box.uidnext;
    this.db.prepare('UPDATE mailboxes SET uidnext = uidnext + 1 WHERE user_id = ? AND mailbox = ?')
      .run(userId, mailbox);
    const blob = this.putBlob(raw);
    this.db.prepare(`INSERT INTO messages
        (user_id, mailbox, uid, flags, internaldate, from_addr, to_addr, subject,
         mailfrom, rcpt, spf, dkim, dmarc, spam, spam_verdict, size, blob)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(userId, mailbox, uid, meta.flags || '', new Date().toISOString(),
        meta.from_addr || null, meta.to_addr || null, meta.subject || null,
        meta.mailfrom || null, meta.rcpt || null,
        meta.spf || null, meta.dkim || null, meta.dmarc || null,
        meta.spam || null, meta.spam_verdict || null, raw.length, blob);
    return uid;
  }

  // Single-tenant convenience for the admin API / UI: one implicit account.
  defaultUser() { return this.addUser('default'); }

  listPaged(userId, mailbox, { limit = 50, beforeUid = null } = {}) {
    const rows = beforeUid
      ? this.db.prepare(
          `SELECT uid, flags, internaldate, from_addr, to_addr, subject, size
             FROM messages WHERE user_id = ? AND mailbox = ? AND uid < ?
             ORDER BY uid DESC LIMIT ?`).all(userId, mailbox, beforeUid, limit)
      : this.db.prepare(
          `SELECT uid, flags, internaldate, from_addr, to_addr, subject, size
             FROM messages WHERE user_id = ? AND mailbox = ?
             ORDER BY uid DESC LIMIT ?`).all(userId, mailbox, limit);
    return rows;
  }
  apiKeys(userId) {
    return this.db.prepare('SELECT key FROM api_keys WHERE user_id = ?').all(userId).map((r) => r.key);
  }
  appPasswordUsers(userId) {
    return this.db.prepare('SELECT DISTINCT username FROM app_passwords WHERE user_id = ?')
      .all(userId).map((r) => r.username);
  }

  status(userId, mailbox) {
    const box = this.mailbox(userId, mailbox);
    const t = this.db.prepare('SELECT COUNT(*) c FROM messages WHERE user_id = ? AND mailbox = ?')
      .get(userId, mailbox).c;
    const u = this.db.prepare(
      "SELECT COUNT(*) c FROM messages WHERE user_id = ? AND mailbox = ? AND instr(' '||flags||' ', ' Seen ') = 0")
      .get(userId, mailbox).c;
    return { total: t, unseen: u, uidvalidity: box.uidvalidity, uidnext: box.uidnext };
  }
  list(userId, mailbox) {
    return this.db.prepare(
      `SELECT uid, flags, internaldate, from_addr, to_addr, subject
         FROM messages WHERE user_id = ? AND mailbox = ? ORDER BY uid`).all(userId, mailbox);
  }
  raw(userId, mailbox, uid) {
    const r = this.db.prepare('SELECT blob FROM messages WHERE user_id = ? AND mailbox = ? AND uid = ?')
      .get(userId, mailbox, uid);
    return r ? this.getBlob(r.blob) : null;
  }
  setFlags(userId, mailbox, uid, flags) {
    this.db.prepare('UPDATE messages SET flags = ? WHERE user_id = ? AND mailbox = ? AND uid = ?')
      .run(flags, userId, mailbox, uid);
  }
}
