// Smarthost outbound — how api-local gets mail to recipients it doesn't host.
//
// Self-hosting the *receiving* side is easy; self-hosting deliverable *sending* is
// the hard part (IP reputation, DKIM alignment, feedback loops). So api-local doesn't
// try to be an outbound MTA — it hands external recipients to something that already
// solves that:
//
//   SMARTHOST=cloud                          → POST to MailKite Cloud's /api/relay
//   SMARTHOST=smtp://user:pass@host:587      → relay to any SMTP smarthost (STARTTLS)
//   SMARTHOST=smtps://user:pass@host:465     → implicit TLS
//   (unset)                                  → external recipients are skipped + logged
//
// Zero npm deps: node:net + node:tls only.

import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const CLOUD_RELAY = process.env.MAILKITE_CLOUD_RELAY || 'https://api.mailkite.dev/api/relay';

/** Parse SMARTHOST (+ MAILKITE_SEND_KEY) into a config, or null when unset/invalid. */
export function parseSmarthost(env = process.env) {
  const spec = (env.SMARTHOST || '').trim();
  if (!spec) return null;
  if (spec === 'cloud') {
    if (!env.MAILKITE_SEND_KEY) {
      console.error('smarthost: SMARTHOST=cloud needs MAILKITE_SEND_KEY — outbound disabled');
      return null;
    }
    return { mode: 'cloud', sendKey: env.MAILKITE_SEND_KEY, url: env.MAILKITE_CLOUD_RELAY || CLOUD_RELAY };
  }
  let u;
  try { u = new URL(spec); } catch { console.error(`smarthost: unparseable SMARTHOST "${spec}" — outbound disabled`); return null; }
  if (u.protocol !== 'smtp:' && u.protocol !== 'smtps:') {
    console.error(`smarthost: unsupported scheme "${u.protocol}" (want cloud, smtp://, smtps://) — outbound disabled`);
    return null;
  }
  const implicitTls = u.protocol === 'smtps:';
  return {
    mode: 'smtp',
    host: u.hostname,
    port: Number(u.port) || (implicitTls ? 465 : 587),
    user: u.username ? decodeURIComponent(u.username) : '',
    pass: u.password ? decodeURIComponent(u.password) : '',
    implicitTls,
  };
}

/**
 * Hand the raw message to MailKite Cloud's relay endpoint — itself a contract
 * implementation, so this is api-local talking to another backend.
 *
 * NOTE: the cloud applies its own From-domain gate. The sending domain must be
 * verified on the *cloud account* that owns MAILKITE_SEND_KEY, not just here.
 */
async function relayViaCloud(cfg, raw, rcpts, { timeoutMs = 20000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.sendKey}`,
        'content-type': 'message/rfc822',
        'x-mailkite-rcpt': rcpts.join(','),
      },
      body: raw,
      signal: ac.signal,
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      let msg = `cloud relay ${res.status}`;
      try { const j = JSON.parse(body); if (j.error) msg = `${msg}: ${j.error}`; } catch { /* text body */ }
      throw new Error(msg);
    }
    return rcpts.length;
  } finally {
    clearTimeout(timer);
  }
}

/** Minimal SMTP client: EHLO → [STARTTLS → EHLO] → AUTH → MAIL/RCPT/DATA → QUIT. */
function relayViaSmtp(cfg, raw, rcpts, mailfrom, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let socket = cfg.implicitTls
      ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host })
      : netConnect({ host: cfg.host, port: cfg.port });
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => fail(new Error(`smtp: timeout after ${timeoutMs}ms`)), timeoutMs);

    const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); try { socket.destroy(); } catch { /* closed */ } resolve(v); };
    const fail = (e) => { if (settled) return; settled = true; clearTimeout(timer); try { socket.destroy(); } catch { /* closed */ } reject(e); };

    // A reply ends at the first line shaped "NNN " (space) — "NNN-" lines continue it.
    let awaiting = null;
    const pump = () => {
      if (!awaiting) return;
      const lines = buf.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const m = /^(\d{3})(?: (.*))?$/.exec(lines[i]);
        if (!m) continue;
        const reply = { code: Number(m[1]), text: lines.slice(0, i + 1).join('\n') };
        buf = lines.slice(i + 1).join('\r\n');
        const cb = awaiting; awaiting = null; cb(reply);
        return;
      }
    };
    const onData = (chunk) => { buf += chunk.toString('utf8'); pump(); };
    const attach = () => { socket.on('data', onData); socket.on('error', fail); };
    attach();

    const expect = (codes) => new Promise((res, rej) => {
      awaiting = (reply) => {
        if (codes.includes(reply.code)) res(reply);
        else rej(new Error(`smtp: expected ${codes.join('/')}, got ${reply.code} — ${reply.text.trim()}`));
      };
      pump(); // the reply may already be buffered
    });
    const send = (line) => new Promise((res) => socket.write(line + '\r\n', res));
    const cmd = async (line, codes) => { await send(line); return expect(codes); };

    (async () => {
      await expect([220]);
      let ehlo = await cmd(`EHLO ${cfg.heloName || 'mailkite-server'}`, [250]);

      if (!cfg.implicitTls && /STARTTLS/i.test(ehlo.text)) {
        await cmd('STARTTLS', [220]);
        socket.removeListener('data', onData);
        socket.removeListener('error', fail);
        socket = tlsConnect({ socket, servername: cfg.host });
        buf = '';
        attach();
        await new Promise((res, rej) => { socket.once('secureConnect', res); socket.once('error', rej); });
        ehlo = await cmd(`EHLO ${cfg.heloName || 'mailkite-server'}`, [250]);
      }

      if (cfg.user) {
        const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
        if (/AUTH[ =-][^\n]*PLAIN/i.test(ehlo.text)) {
          await cmd(`AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.pass}`)}`, [235]);
        } else {
          await cmd('AUTH LOGIN', [334]);
          await cmd(b64(cfg.user), [334]);
          await cmd(b64(cfg.pass), [235]);
        }
      }

      await cmd(`MAIL FROM:<${mailfrom}>`, [250]);
      for (const rcpt of rcpts) await cmd(`RCPT TO:<${rcpt}>`, [250, 251]);
      await cmd('DATA', [354]);
      // Dot-stuff and terminate. CRLF-normalize first: a bare-LF body would end the
      // message early or corrupt it on strict servers.
      const body = raw.toString('binary').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
      await send(body.endsWith('\r\n') ? body + '.' : body + '\r\n.');
      await expect([250]);
      await send('QUIT');
      done(rcpts.length);
    })().catch(fail);
  });
}

/**
 * Deliver `raw` to external recipients through the configured smarthost.
 * Returns { mode, relayed } — or throws with a human-readable reason.
 */
export async function relayExternal(cfg, raw, rcpts, mailfrom) {
  if (!cfg || !rcpts.length) return { mode: cfg ? cfg.mode : null, relayed: 0 };
  const relayed = cfg.mode === 'cloud'
    ? await relayViaCloud(cfg, raw, rcpts)
    : await relayViaSmtp(cfg, raw, rcpts, mailfrom);
  return { mode: cfg.mode, relayed };
}
