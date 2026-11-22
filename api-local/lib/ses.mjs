// Amazon SES outbound — hand raw MIME to SES's SendRawEmail API, signed with the
// account's ordinary AWS access key pair. No SMTP credentials to derive, no second
// credential system: the same key that can call the AWS API can send.
//
// This deliberately does not try to be an MTA. It is one more implementation of the
// smarthost seam (see smarthost.mjs): SES owns IP reputation, DKIM signing and
// feedback loops, which is the part self-hosting should not reimplement.
//
// Docs: api-local/README.md § Outbound (smarthost), docs/ses-outbound.md

import { signV4, rfc3986 } from './sigv4.mjs';

const DEFAULT_REGION = 'us-east-1';
// Region names only (`us-east-1`, `eu-west-2`, `us-gov-west-1`). A region ends up in
// both the endpoint hostname and the signing scope, so anything stranger is a typo
// that would otherwise surface as an opaque `SignatureDoesNotMatch`.
const REGION_RE = /^[a-z]{2}(-[a-z0-9]+)+$/;
const API_VERSION = '2010-12-01';

const firstEnv = (env, ...names) => {
  for (const name of names) {
    const value = String(env[name] ?? '').trim();
    if (value) return value;
  }
  return '';
};

/**
 * Parse the SES env into a smarthost config, or null (with a reason on stderr) when
 * it is unusable. Same contract as the other modes: null means "no outbound path",
 * never a half-configured sender that fails per message.
 *
 * @param {Record<string,string|undefined>} [env]
 * @param {string} [specRegion] Region from `SMARTHOST=ses://<region>`, wins over env.
 */
export function parseSesConfig(env = process.env, specRegion = '') {
  const region = String(
    specRegion || firstEnv(env, 'SES_REGION', 'AWS_REGION', 'AWS_DEFAULT_REGION') || DEFAULT_REGION,
  ).trim();
  if (!REGION_RE.test(region)) {
    console.error(`smarthost: "${region}" is not an AWS region — outbound disabled`);
    return null;
  }

  const accessKeyId = firstEnv(env, 'SES_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID');
  const secretAccessKey = firstEnv(env, 'SES_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY');
  if (!accessKeyId || !secretAccessKey) {
    console.error('smarthost: SMARTHOST=ses needs SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY '
      + '(AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY also work) — outbound disabled');
    return null;
  }

  const url = String(env.MAILKITE_SES_ENDPOINT || `https://email.${region}.amazonaws.com/`).trim();
  let endpoint;
  try {
    endpoint = new URL(url);
  } catch {
    console.error(`smarthost: MAILKITE_SES_ENDPOINT "${url}" is not a URL — outbound disabled`);
    return null;
  }

  // The request carries a signature over the secret, so plaintext is a credential leak.
  // Loopback stays allowed: that is how the tests run without an AWS account.
  if (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
    console.error('smarthost: MAILKITE_SES_ENDPOINT must be https (http is allowed only for loopback) — outbound disabled');
    return null;
  }

  return {
    mode: 'ses',
    region,
    host: endpoint.host,
    url,
    accessKeyId,
    secretAccessKey,
    // Temporary credentials (an assumed role, SSO) carry a session token; long-lived
    // IAM keys do not. Empty string means "none", so signing can skip the header.
    sessionToken: firstEnv(env, 'SES_SESSION_TOKEN', 'AWS_SESSION_TOKEN') || '',
  };
}

/**
 * The Query-API form body for SendRawEmail.
 *
 * `Destinations` is the envelope and is authoritative — that is what keeps Bcc blind
 * (Bcc appears only here, never as a header) and what lets a relayed message keep its
 * own To/Cc untouched. `Source` is the envelope sender, mirroring SMTP MAIL FROM.
 */
export function sesBody(raw, rcpts, mailfrom = '') {
  const params = [
    ['Action', 'SendRawEmail'],
    ['Version', API_VERSION],
    ...(mailfrom ? [['Source', mailfrom]] : []),
    ...rcpts.map((rcpt, i) => [`Destinations.member.${i + 1}`, rcpt]),
    ['RawMessage.Data', Buffer.from(raw).toString('base64')],
  ];
  return params.map(([name, value]) => `${rfc3986(name)}=${rfc3986(value)}`).join('&');
}

const decodeXml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const trim = (s, n = 300) => {
  const t = decodeXml(String(s || '')).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** SES answers 2xx with XML; a failure carries `<Error><Code>` + `<Message>`. */
function parseResponse(status, text) {
  const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
  const message = /<Message>([^<]*)<\/Message>/.exec(text)?.[1];
  if (status < 200 || status >= 300) {
    const detail = [code, message && trim(message)].filter(Boolean).join(' — ');
    const err = new Error(`ses ${status}${detail ? `: ${detail}` : ''}`);
    err.status = status;
    if (code) err.sesCode = trim(code, 80);
    return { error: err };
  }
  return { messageId: /<MessageId>([^<]+)<\/MessageId>/.exec(text)?.[1] || null };
}

/**
 * POST the raw message to SES. Resolves `{ messageId }` on 2xx; throws an Error whose
 * message is safe to log and whose `sesCode`/`status` let errors.mjs say something a
 * person can act on. No retries here on purpose: the submission edge turns a failure
 * into a tempfail, so retrying inside would double-send on a timeout.
 */
export async function relayViaSes(cfg, raw, rcpts, mailfrom, { timeoutMs = 30000, now = new Date() } = {}) {
  const url = new URL(cfg.url);
  const body = sesBody(raw, rcpts, mailfrom);
  const { headers } = signV4({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    payload: body,
    region: cfg.region,
    service: 'ses',
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    sessionToken: cfg.sessionToken,
    now,
  });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  let text;
  try {
    res = await fetch(url, { method: 'POST', headers, body, signal: ac.signal });
    text = await res.text().catch(() => '');
  } catch (e) {
    throw transportFailure(e, cfg.host, timeoutMs);
  } finally {
    clearTimeout(timer);
  }

  const parsed = parseResponse(res.status, text);
  if (parsed.error) throw parsed.error;
  return { messageId: parsed.messageId };
}

/** Turn a network/abort exception into a message errors.mjs can classify. */
function transportFailure(e, host, timeoutMs) {
  if (e?.name === 'AbortError') {
    return new Error(`ses: timeout after ${timeoutMs}ms waiting for ${host}`);
  }
  const cause = e?.cause instanceof Error ? e.cause : e;
  const err = new Error(`ses: could not reach ${host} — ${cause?.message || e?.message || e}`);
  // Keep the errno (ECONNREFUSED, ENOTFOUND, …) so transportError maps it, not the wrapper.
  if (cause?.code) err.code = cause.code;
  return err;
}
