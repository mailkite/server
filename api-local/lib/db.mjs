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
    user_id INTEGER NOT NULL REFERENCES users(id),
    webhook_url TEXT,                    -- inbound dispatch target (null = no webhook)
    webhook_secret TEXT                  -- signs the payload; generated with the URL
  );
  CREATE TABLE IF NOT EXISTS deliveries (  -- webhook attempts, retried by the scanner
    id INTEGER PRIMARY KEY,
    domain TEXT NOT NULL,
    url TEXT NOT NULL,
    payload TEXT NOT NULL,               -- exact JSON body (signature covers these bytes)
    status TEXT NOT NULL,                -- pending | delivered | failed
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt INTEGER NOT NULL,       -- epoch ms
    last_error TEXT,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(status, next_attempt);
  CREATE TABLE IF NOT EXISTS api_keys (
    key TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS app_passwords (   -- docs/app-passwords.md
    username TEXT NOT NULL,              -- a mailbox address, e.g. you@yourdomain.com
    hash TEXT NOT NULL,                  -- scrypt(secret): what actually verifies
    user_id INTEGER NOT NULL REFERENCES users(id),
    mailbox_id INTEGER                   -- reserved: per-address scoping (null = account-wide)
    -- domain / address / protocols / lookup / label / created_at / last_used_at are
    -- added by migrate() so installs that predate them upgrade in place.
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
    this.migrate();
  }

  /**
   * Additive column migrations. CREATE TABLE IF NOT EXISTS silently skips tables that
   * already exist, so columns added after an install shipped need ALTER TABLE — this
   * runs on every boot and is a no-op once applied.
   */
  migrate() {
    const cols = (table) => this.db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
    const domainCols = cols('domains');
    for (const [name, ddl] of [['webhook_url', 'TEXT'], ['webhook_secret', 'TEXT']]) {
      if (!domainCols.includes(name)) this.db.exec(`ALTER TABLE domains ADD COLUMN ${name} ${ddl}`);
    }
    this.migrateAppPasswords();
  }

  /**
   * App passwords gained scoping (domain + address pattern) and protocols. Existing
   * rows are backfilled from their `username`: address-scoped, imap-only — exactly the
   * behaviour they had. Their secrets can't be re-derived into a `lookup` hash, so
   * those stay NULL and are verified by the scan path in findAppPassword(); a
   * `mk_imap_` secret issued years ago keeps authenticating.
   */
  migrateAppPasswords() {
    const cols = this.db.prepare('PRAGMA table_info(app_passwords)').all().map((r) => r.name);
    for (const [name, ddl] of [
      ['domain', 'TEXT'], ['address', 'TEXT'], ['protocols', 'TEXT'],
      ['lookup', 'TEXT'], ['label', 'TEXT'], ['created_at', 'INTEGER'], ['last_used_at', 'INTEGER'],
    ]) {
      if (!cols.includes(name)) this.db.exec(`ALTER TABLE app_passwords ADD COLUMN ${name} ${ddl}`);
    }
    // UNIQUE can't be added by ALTER TABLE; a partial index does the same job and
    // leaves legacy rows (lookup NULL) out of the constraint.
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS app_passwords_lookup
                    ON app_passwords(lookup) WHERE lookup IS NOT NULL`);
    this.db.exec('CREATE INDEX IF NOT EXISTS app_passwords_domain ON app_passwords(domain)');
    // Backfill scope for rows written before the columns existed.
    for (const r of this.db.prepare(
      'SELECT rowid, username FROM app_passwords WHERE domain IS NULL OR address IS NULL').all()) {
      const at = String(r.username || '').lastIndexOf('@');
      if (at < 1) continue;
      this.db.prepare(
        `UPDATE app_passwords SET domain = ?, address = ?, protocols = COALESCE(protocols, 'imap'),
                created_at = COALESCE(created_at, ?) WHERE rowid = ?`)
        .run(r.username.slice(at + 1).toLowerCase(), r.username.slice(0, at).toLowerCase(), Date.now(), r.rowid);
    }
  }

  // --- accounts / credentials -------------------------------------------------

  addUser(name) {
    this.db.prepare('INSERT OR IGNORE INTO users(name) VALUES (?)').run(name);
    return this.db.prepare('SELECT id FROM users WHERE name = ?').get(name).id;
  }
  // INSERT OR IGNORE, not OR REPLACE: re-adding a domain must not silently drop its
  // webhook config.
  addDomain(domain, userId) {
    this.db.prepare('INSERT OR IGNORE INTO domains(domain, user_id) VALUES (?, ?)')
      .run(domain.toLowerCase(), userId);
    this.db.prepare('UPDATE domains SET user_id = ? WHERE domain = ?').run(userId, domain.toLowerCase());
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
  // --- app passwords (docs/app-passwords.md) ------------------------------------
  // (domain, address pattern) × protocols. Secrets are stored twice — sha256 for the
  // indexed lookup, scrypt for the actual verification — so authenticating a bearer is
  // one indexed read rather than a scrypt scan over every row.

  addAppPassword({ domain, address = '*', protocols = ['imap'], label = null, userId, secret }) {
    const raw = secret || 'mk_pw_' + randomBytes(24).toString('base64url');
    const salt = randomBytes(16);
    const hash = salt.toString('hex') + ':' + scryptSync(raw, salt, 32).toString('hex');
    const d = String(domain).toLowerCase();
    const a = String(address).toLowerCase();
    const protoCsv = [...new Set(protocols)].filter((p) => p === 'imap' || p === 'api').join(',');
    const r = this.db.prepare(
      `INSERT INTO app_passwords (username, hash, user_id, domain, address, protocols, lookup, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`${a}@${d}`, hash, userId, d, a, protoCsv, this.hashToken(raw), label, Date.now());
    return { id: Number(r.lastInsertRowid), secret: raw };
  }

  /** Listing never exposes secrets — only what a password covers and when it was used. */
  appPasswords(userId = null) {
    const sql = `SELECT rowid AS id, label, domain, address, protocols, created_at, last_used_at
                   FROM app_passwords ${userId == null ? '' : 'WHERE user_id = ?'} ORDER BY rowid DESC`;
    const rows = userId == null ? this.db.prepare(sql).all() : this.db.prepare(sql).all(userId);
    return rows.map((r) => ({ ...r, protocols: r.protocols ? r.protocols.split(',') : [] }));
  }
  deleteAppPassword(id) {
    return this.db.prepare('DELETE FROM app_passwords WHERE rowid = ?').run(id).changes > 0;
  }
  touchAppPassword(id) {
    this.db.prepare('UPDATE app_passwords SET last_used_at = ? WHERE rowid = ?').run(Date.now(), id);
  }

  /** Constant-time scrypt check against a stored `salt:hash`. */
  static verifyScrypt(secret, stored) {
    const [saltHex, hashHex] = String(stored).split(':');
    if (!saltHex || !hashHex) return false;
    const got = scryptSync(secret, Buffer.from(saltHex, 'hex'), 32);
    const want = Buffer.from(hashHex, 'hex');
    return got.length === want.length && timingSafeEqual(got, want);
  }

  /**
   * Resolve a secret to its row. New secrets hit the indexed lookup; pre-migration
   * ones (no lookup hash — typically `mk_imap_…`) fall back to a scan so they keep
   * working forever.
   */
  findAppPassword(secret) {
    if (!secret) return null;
    const row = this.db.prepare('SELECT rowid AS id, * FROM app_passwords WHERE lookup = ?')
      .get(this.hashToken(secret));
    if (row) return Store.verifyScrypt(secret, row.hash) ? row : null;
    for (const r of this.db.prepare('SELECT rowid AS id, * FROM app_passwords WHERE lookup IS NULL').all()) {
      if (Store.verifyScrypt(secret, r.hash)) return r;
    }
    return null;
  }

  // --- inbound webhooks ---------------------------------------------------------

  /** Set (or clear, with a falsy url) a domain's webhook. Returns {url, secret}. */
  setWebhook(domain, url) {
    const d = String(domain).toLowerCase();
    if (!url) {
      this.db.prepare('UPDATE domains SET webhook_url = NULL, webhook_secret = NULL WHERE domain = ?').run(d);
      return { url: null, secret: null };
    }
    const existing = this.db.prepare('SELECT webhook_secret FROM domains WHERE domain = ?').get(d);
    // Keep the secret stable across URL edits so receivers don't have to re-key.
    const secret = existing?.webhook_secret || 'whsec_' + randomBytes(24).toString('base64url');
    this.db.prepare('UPDATE domains SET webhook_url = ?, webhook_secret = ? WHERE domain = ?').run(url, secret, d);
    return { url, secret };
  }
  webhook(domain) {
    const r = this.db.prepare('SELECT webhook_url url, webhook_secret secret FROM domains WHERE domain = ?')
      .get(String(domain).toLowerCase());
    return r && r.url ? r : null;
  }
  webhooks() {
    return this.db.prepare(
      'SELECT domain, webhook_url url FROM domains WHERE webhook_url IS NOT NULL ORDER BY domain').all();
  }
  anyWebhook() { return this.db.prepare('SELECT COUNT(*) c FROM domains WHERE webhook_url IS NOT NULL').get().c > 0; }

  queueDelivery(domain, url, payload) {
    const now = Date.now();
    const r = this.db.prepare(
      `INSERT INTO deliveries(domain, url, payload, status, attempts, next_attempt, created, updated)
       VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`).run(domain, url, payload, now, now, now);
    return Number(r.lastInsertRowid);
  }
  dueDeliveries(limit = 20, now = Date.now()) {
    return this.db.prepare(
      `SELECT * FROM deliveries WHERE status = 'pending' AND next_attempt <= ?
         ORDER BY next_attempt LIMIT ?`).all(now, limit);
  }
  /** Record an attempt: delivered, or scheduled for retry / exhausted. */
  recordAttempt(id, { ok, error = null, backoffMs = null, maxed = false }) {
    const now = Date.now();
    if (ok) {
      this.db.prepare(
        `UPDATE deliveries SET status = 'delivered', attempts = attempts + 1, last_error = NULL, updated = ?
           WHERE id = ?`).run(now, id);
      return;
    }
    this.db.prepare(
      `UPDATE deliveries SET status = ?, attempts = attempts + 1, last_error = ?,
              next_attempt = ?, updated = ? WHERE id = ?`)
      .run(maxed ? 'failed' : 'pending', String(error).slice(0, 500), now + (backoffMs || 0), now, id);
  }
  deliveryStatus(domain = null, limit = 20) {
    const rows = domain
      ? this.db.prepare(
          `SELECT id, domain, url, status, attempts, next_attempt, last_error, created, updated
             FROM deliveries WHERE domain = ? ORDER BY id DESC LIMIT ?`).all(String(domain).toLowerCase(), limit)
      : this.db.prepare(
          `SELECT id, domain, url, status, attempts, next_attempt, last_error, created, updated
             FROM deliveries ORDER BY id DESC LIMIT ?`).all(limit);
    const counts = this.db.prepare(
      "SELECT status, COUNT(*) c FROM deliveries GROUP BY status").all()
      .reduce((a, r) => ({ ...a, [r.status]: r.c }), { pending: 0, delivered: 0, failed: 0 });
    return { recent: rows, counts };
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
  // Address-scoped reads for the mailbox REST routes: a key for hello@domain must not
  // see the rest of the account's mail. INBOX is scoped by the envelope recipient the
  // message was stored for; Sent by who sent it.
  static addressColumn(mailbox) { return mailbox === 'Sent' ? 'from_addr' : 'rcpt'; }

  listPagedForAddress(userId, mailbox, address, { limit = 50, beforeUid = null } = {}) {
    const col = Store.addressColumn(mailbox);
    const addr = String(address).toLowerCase();
    const sql = `SELECT uid, flags, internaldate, from_addr, to_addr, subject, size
                   FROM messages
                  WHERE user_id = ? AND mailbox = ? AND lower(${col}) = ?
                    ${beforeUid ? 'AND uid < ?' : ''}
                  ORDER BY uid DESC LIMIT ?`;
    return beforeUid
      ? this.db.prepare(sql).all(userId, mailbox, addr, beforeUid, limit)
      : this.db.prepare(sql).all(userId, mailbox, addr, limit);
  }
  rawForAddress(userId, mailbox, address, uid) {
    const col = Store.addressColumn(mailbox);
    const r = this.db.prepare(
      `SELECT blob FROM messages
        WHERE user_id = ? AND mailbox = ? AND uid = ? AND lower(${col}) = ?`)
      .get(userId, mailbox, uid, String(address).toLowerCase());
    return r ? this.getBlob(r.blob) : null;
  }
  setFlagsForAddress(userId, mailbox, address, uid, flags) {
    const col = Store.addressColumn(mailbox);
    return this.db.prepare(
      `UPDATE messages SET flags = ?
        WHERE user_id = ? AND mailbox = ? AND uid = ? AND lower(${col}) = ?`)
      .run(flags, userId, mailbox, uid, String(address).toLowerCase()).changes > 0;
  }

  apiKeys(userId) {
    return this.db.prepare('SELECT key FROM api_keys WHERE user_id = ?').all(userId).map((r) => r.key);
  }
  /** Legacy view: imap-capable passwords as addresses (`*@domain` when domain-wide). */
  appPasswordUsers(userId) {
    return this.db.prepare(
      `SELECT DISTINCT address || '@' || domain AS username FROM app_passwords
        WHERE user_id = ? AND instr(',' || COALESCE(protocols, 'imap') || ',', ',imap,') > 0
          AND domain IS NOT NULL ORDER BY username`).all(userId).map((r) => r.username);
  }

  // The IMAP read paths take the same optional address scope as the REST routes, so an
  // address-scoped app password sees the same mail through either protocol. `address`
  // null = account-wide (a `*` password, or a legacy account-wide session).
  status(userId, mailbox, address = null) {
    const box = this.mailbox(userId, mailbox);
    const col = Store.addressColumn(mailbox);
    const scope = address ? ` AND lower(${col}) = ?` : '';
    const args = address ? [userId, mailbox, String(address).toLowerCase()] : [userId, mailbox];
    const t = this.db.prepare(`SELECT COUNT(*) c FROM messages WHERE user_id = ? AND mailbox = ?${scope}`)
      .get(...args).c;
    const u = this.db.prepare(
      `SELECT COUNT(*) c FROM messages WHERE user_id = ? AND mailbox = ?${scope} AND instr(' '||flags||' ', ' Seen ') = 0`)
      .get(...args).c;
    return { total: t, unseen: u, uidvalidity: box.uidvalidity, uidnext: box.uidnext };
  }
  list(userId, mailbox, address = null) {
    const col = Store.addressColumn(mailbox);
    const scope = address ? ` AND lower(${col}) = ?` : '';
    const args = address ? [userId, mailbox, String(address).toLowerCase()] : [userId, mailbox];
    return this.db.prepare(
      `SELECT uid, flags, internaldate, from_addr, to_addr, subject
         FROM messages WHERE user_id = ? AND mailbox = ?${scope} ORDER BY uid`).all(...args);
  }
  raw(userId, mailbox, uid, address = null) {
    if (address) return this.rawForAddress(userId, mailbox, address, uid);
    const r = this.db.prepare('SELECT blob FROM messages WHERE user_id = ? AND mailbox = ? AND uid = ?')
      .get(userId, mailbox, uid);
    return r ? this.getBlob(r.blob) : null;
  }
  setFlags(userId, mailbox, uid, flags) {
    this.db.prepare('UPDATE messages SET flags = ? WHERE user_id = ? AND mailbox = ? AND uid = ?')
      .run(flags, userId, mailbox, uid);
  }
}
