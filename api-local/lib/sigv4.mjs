// AWS Signature Version 4 for a single signed request.
//
// Exactly what an SES `SendRawEmail` call needs — one method, one path, no query
// string, a sha256 payload and a short list of headers — and nothing more. Kept
// separate from the SES request shape so the signing algorithm can be checked against
// AWS's published test vectors without a network or an AWS account.
//
// Zero dependencies: node:crypto only.
//
// Docs: docs/ses-outbound.md

import { createHash, createHmac } from 'node:crypto';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/**
 * RFC3986 percent-encoding. SigV4 requires `!'()*` escaped; `encodeURIComponent`
 * leaves them alone, which produces a signature the service will reject.
 */
export const rfc3986 = (v) => encodeURIComponent(String(v))
  .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** `2026-11-22T12:34:56.789Z` → `20261122T123456Z` (the `x-amz-date` form). */
export function amzDate(date = new Date()) {
  return date.toISOString().replace(/[-:]|\.\d{3}/g, '');
}

/** SigV4 compares header values trimmed with runs of whitespace collapsed. */
const normalize = (v) => String(v).trim().replace(/\s+/g, ' ');

/**
 * Sign a request and return the header set to actually send.
 *
 * @param {object} o
 * @param {string} [o.method] HTTP verb (POST for SES).
 * @param {URL} o.url          Absolute URL; its host is signed as `host`.
 * @param {Record<string,string>} [o.headers] Headers to sign (e.g. content-type).
 * @param {string|Buffer} o.payload Body exactly as it will be sent.
 * @param {string} o.region     AWS region, e.g. `us-east-1`.
 * @param {string} o.service    AWS service name, `ses`.
 * @param {string} o.accessKeyId
 * @param {string} o.secretAccessKey
 * @param {string} [o.sessionToken] STS/role token; signed as `x-amz-security-token`.
 * @param {Date} [o.now]        Clock override (tests).
 * @returns {{ headers: Record<string,string>, amzDate: string, signedHeaders: string, signature: string }}
 */
export function signV4({
  method = 'POST', url, headers = {}, payload = '', region, service,
  accessKeyId, secretAccessKey, sessionToken, now = new Date(),
}) {
  for (const [name, value] of Object.entries({ url, region, service, accessKeyId, secretAccessKey })) {
    if (!value) throw new Error(`sigv4: ${name} is required`);
  }

  const stamp = amzDate(now);
  const day = stamp.slice(0, 8);

  // Sign host + x-amz-date unconditionally, plus whatever the caller needs covered.
  const toSign = {
    ...headers,
    host: url.host,
    'x-amz-date': stamp,
    ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}),
  };

  // Lowercase keys for the canonical form: SigV4 sorts and signs lowercase names, and a
  // duplicated spelling (`Content-Type` + `content-type`) must collapse to one line.
  const normalized = {};
  for (const [name, value] of Object.entries(toSign)) normalized[name.toLowerCase()] = normalize(value);

  const names = Object.keys(normalized).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map((name) => `${name}:${normalized[name]}\n`).join('');

  const canonicalRequest = [
    method.toUpperCase(),
    url.pathname || '/',
    url.search.replace(/^\?/, ''),
    canonicalHeaders,
    signedHeaders,
    sha256Hex(payload),
  ].join('\n');

  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    stamp,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${secretAccessKey}`, day);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    headers: {
      ...toSign,
      authorization: `${ALGORITHM} Credential=${accessKeyId}/${scope}, `
        + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    amzDate: stamp,
    signedHeaders,
    signature,
  };
}
