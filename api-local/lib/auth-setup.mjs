// Sign-in setup — docs/auth-setup.md
//
// A fresh install is open for exactly one moment (the first visitor claims it). This
// module ends that moment: the admin picks how sign-in is verified from then on, and
// the choice is only written once it has been PROVEN to work — an emailed code that
// came back, or a completed OAuth round trip. Everything unproven stays in
// auth_setup_pending, so "configured but broken" is not a representable state.
//
// Zero npm deps: fetch + node:crypto only.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { sendViaSmtp } from './smarthost.mjs';

export const METHODS = ['email_cloud', 'email_smtp', 'oauth_google', 'oauth_github'];
export const isEmailMethod = (m) => m === 'email_cloud' || m === 'email_smtp';
export const isOauthMethod = (m) => m === 'oauth_google' || m === 'oauth_github';

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
export const hashCode = sha;

/** Constant-time compare that tolerates unequal lengths. */
export function codeMatches(given, expectedHash) {
  const a = Buffer.from(sha(String(given ?? '')));
  const b = Buffer.from(String(expectedHash ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 6 digits, uniformly random — short enough to retype, rate-limited on verify. */
export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
export const newState = () => randomBytes(24).toString('base64url');

// ---- provider endpoints ---------------------------------------------------------
// Overridable so tests can stand up a stub provider (same trick as MAILKITE_SEND_URL).

export function providerEndpoints(provider, env = process.env) {
  const base = env.OAUTH_TEST_BASE_URL; // tests point every leg at one stub origin
  if (base) {
    return {
      authorize: `${base}/authorize`,
      token: `${base}/token`,
      userinfo: `${base}/userinfo`,
      scope: 'openid email',
    };
  }
  if (provider === 'google') {
    return {
      authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
      token: 'https://oauth2.googleapis.com/token',
      userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
      scope: 'openid email',
    };
  }
  return {
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    userinfo: 'https://api.github.com/user',
    emails: 'https://api.github.com/user/emails',
    scope: 'read:user user:email',
  };
}

export function authorizeUrl({ provider, clientId, redirectUri, state }, env = process.env) {
  const ep = providerEndpoints(provider, env);
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: ep.scope,
    state,
  });
  // Google needs an explicit prompt to reliably return an account chooser.
  if (provider === 'google') q.set('prompt', 'select_account');
  return `${ep.authorize}?${q}`;
}

/**
 * Exchange the authorization code and resolve the signed-in user's email address.
 * Throws with a readable reason; never returns an unverified address.
 */
export async function fetchOauthEmail({ provider, clientId, clientSecret, redirectUri, code }, env = process.env) {
  const ep = providerEndpoints(provider, env);
  const tokenRes = await fetch(ep.token, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed (${tokenRes.status})`);
  const tok = await tokenRes.json().catch(() => ({}));
  const accessToken = tok.access_token;
  if (!accessToken) throw new Error('provider returned no access token');

  const headers = { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'user-agent': 'mailkite-server' };
  const infoRes = await fetch(ep.userinfo, { headers });
  if (!infoRes.ok) throw new Error(`userinfo failed (${infoRes.status})`);
  const info = await infoRes.json().catch(() => ({}));

  let email = info.email;
  // GitHub omits a private primary address from /user; /user/emails carries it, and
  // only a verified one may be trusted as an identity.
  if (!email && ep.emails) {
    const listRes = await fetch(ep.emails, { headers });
    if (listRes.ok) {
      const list = await listRes.json().catch(() => []);
      const primary = Array.isArray(list) ? list.find((e) => e.primary && e.verified) : null;
      email = primary?.email;
    }
  }
  if (!email) throw new Error('provider did not return an email address');
  // Google reports whether the address is verified; refuse it when it isn't.
  if (info.email_verified === false) throw new Error('provider reports this email is unverified');
  return String(email).toLowerCase();
}

// ---- proving an email path ------------------------------------------------------

const CODE_SUBJECT = 'Your MailKite Server verification code';
const codeBody = (code) =>
  `Your MailKite Server sign-in setup code is:\n\n    ${code}\n\n` +
  `Enter it in the console to finish setup. It expires in 15 minutes.\n\n` +
  `If you didn't start this, someone with access to your console did — check your server.`;

/**
 * Send the verification code through the CANDIDATE config. Any failure propagates:
 * the caller must not persist a config whose send didn't work.
 */
export async function sendSetupCode({ method, settings, to, code, sendUrl }) {
  if (method === 'email_cloud') {
    const res = await fetch(sendUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${settings.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: settings.from, to, subject: CODE_SUBJECT, text: codeBody(code) }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`the send API rejected the key (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    return true;
  }
  if (method === 'email_smtp') {
    await sendViaSmtp(smtpCfg(settings), { from: settings.from, to, subject: CODE_SUBJECT, text: codeBody(code) });
    return true;
  }
  throw new Error(`not an email method: ${method}`);
}

/** Map stored SMTP settings onto the shape lib/smarthost.mjs expects. */
export function smtpCfg(s) {
  return {
    mode: 'smtp',
    host: s.host,
    port: Number(s.port) || 587,
    user: s.user || '',
    pass: s.pass || '',
    implicitTls: Number(s.port) === 465 || !!s.implicitTls,
  };
}

/** Strip every secret: what a GET may safely return. */
export function publicSettings(method, settings = {}) {
  if (method === 'email_cloud') return { from: settings.from || null, keySet: !!settings.key };
  if (method === 'email_smtp') {
    return { host: settings.host || null, port: settings.port || null, user: settings.user || null, from: settings.from || null, passwordSet: !!settings.pass };
  }
  if (isOauthMethod(method)) {
    return { provider: method === 'oauth_google' ? 'google' : 'github', clientId: settings.clientId || null, allowedEmails: settings.allowedEmails || [], clientSecretSet: !!settings.clientSecret };
  }
  return {};
}
