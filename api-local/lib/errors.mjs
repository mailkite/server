// Turning a failure into something an admin can act on.
//
// The raw cause (an upstream JSON body, a Node errno, an SMTP reply code) belongs in the
// server log, not in front of a person trying to finish setup. Each mapping answers two
// questions: what went wrong, and what to do about it. Anything unrecognised falls back
// to a plain sentence plus its detail — never a stack trace or a dumped payload.

/** @typedef {{ error: string, code: string, detail?: string }} FriendlyError */

const CLOUD = {
  401: {
    code: 'bad_key',
    error: 'MailKite Cloud rejected that API key. Copy a full key (starting mk_live_) from app.mailkite.dev → API keys.',
  },
  403: {
    code: 'from_not_verified',
    error: 'MailKite Cloud accepted the key but refused the From address. It must be on a domain verified in that cloud account.',
  },
  404: { code: 'send_endpoint', error: "The send endpoint wasn't found. Check the send URL if you overrode it." },
  422: { code: 'rejected', error: 'MailKite Cloud rejected the message — the From address or recipient looks invalid.' },
  429: { code: 'rate_limited', error: 'MailKite Cloud is rate-limiting this account. Wait a minute and try again.' },
};

// The status alone is ambiguous — the cloud answers 404 both for a path that doesn't
// exist and for a From domain the account doesn't own. Its machine code disambiguates,
// so read that first and only fall back to the status.
const CLOUD_CODES = {
  domain_not_owned: {
    code: 'from_not_verified',
    error: "That From address isn't on a domain verified in your MailKite Cloud account. Add and verify the domain at app.mailkite.dev → Domains, or use an address on one you already have.",
  },
  from_domain: {
    code: 'from_not_verified',
    error: 'MailKite Cloud refused that From address — its domain must be verified on the account the key belongs to.',
  },
  bad_key: { code: 'bad_key', error: 'MailKite Cloud rejected that API key. Copy a full key (starting mk_live_) from app.mailkite.dev → API keys.' },
  email_not_verified: { code: 'account_unverified', error: 'That cloud account has not verified its email address yet, so it cannot send.' },
  suppressed: { code: 'suppressed', error: 'The recipient is on that account\'s suppression list, so the cloud refused to send.' },
};

/** Map a cloud send failure (HTTP status + body) to something actionable. */
export function cloudSendError(status, body = '') {
  let upstream = null;
  try { upstream = JSON.parse(body); } catch { /* not JSON — fall back to status */ }
  const byCode = upstream?.code && CLOUD_CODES[upstream.code];
  if (byCode) return { ...byCode, detail: trim(body) };
  const hit = CLOUD[status];
  if (hit) return { ...hit, detail: trim(body) };
  if (status >= 500) {
    return {
      code: 'provider_down',
      error: `MailKite Cloud returned an error (${status}). This is upstream — try again shortly.`,
      detail: trim(body),
    };
  }
  return { code: 'send_failed', error: `The send API refused the request (${status}).`, detail: trim(body) };
}

/** Map a network/SMTP-level exception to something actionable. */
export function transportError(e, { host, port } = {}) {
  const msg = String(e?.message || e);
  const where = host ? `${host}:${port ?? 587}` : 'the send API';
  const errno = e?.code || '';

  if (errno === 'ECONNREFUSED') {
    return { code: 'connect_refused', error: `Nothing accepted a connection at ${where}. Check the host and port.`, detail: msg };
  }
  if (errno === 'ENOTFOUND' || errno === 'EAI_AGAIN') {
    return { code: 'dns', error: `Couldn't resolve ${host || 'the send host'}. Check the hostname and this server's DNS.`, detail: msg };
  }
  if (errno === 'ETIMEDOUT' || /timed? ?out/i.test(msg)) {
    return { code: 'timeout', error: `Timed out connecting to ${where}. A firewall may be blocking outbound mail on that port.`, detail: msg };
  }
  if (/certificate|self[- ]signed|CERT_|TLS/i.test(msg)) {
    return { code: 'tls', error: `The TLS handshake with ${where} failed — its certificate wasn't accepted.`, detail: msg };
  }
  // SMTP replies the client surfaces verbatim: 535 auth, 550/553 sender refused, 4xx busy.
  const smtp = msg.match(/\b([45]\d\d)\b/);
  if (smtp) {
    const codeNum = smtp[1];
    if (codeNum === '535' || /auth/i.test(msg)) {
      return { code: 'smtp_auth', error: `${where} rejected those credentials (535). Check the username and password.`, detail: msg };
    }
    if (codeNum === '550' || codeNum === '553') {
      return { code: 'smtp_sender', error: `${where} refused the From address (${codeNum}). It usually must match the authenticated account.`, detail: msg };
    }
    if (codeNum.startsWith('4')) {
      return { code: 'smtp_busy', error: `${where} asked us to retry later (${codeNum}).`, detail: msg };
    }
    return { code: 'smtp_rejected', error: `${where} rejected the message (${codeNum}).`, detail: msg };
  }
  return { code: 'send_failed', error: `Couldn't reach ${where}.`, detail: msg };
}

const trim = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > 300 ? t.slice(0, 300) + '…' : t;
};
