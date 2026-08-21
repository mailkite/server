// Minimal RFC822 header extraction — just enough for the IMAP list fields
// (from_addr, to_addr, subject). Full MIME parsing is deliberately out of scope:
// IMAP clients parse the raw message themselves; these fields only feed list views
// and the pre-raw fallback envelope.

/** Extract unfolded top-level headers from raw RFC822 bytes. */
export function headers(raw) {
  const text = raw.toString('latin1');
  const end = text.search(/\r?\n\r?\n/);
  const head = end === -1 ? text : text.slice(0, end);
  const out = {};
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      // continuation of the previous header
      if (out.__last) out[out.__last] += ' ' + line.trim();
      continue;
    }
    const m = line.match(/^([!-9;-~]+):\s*(.*)$/);
    if (!m) continue;
    const name = m[1].toLowerCase();
    out[name] = out[name] ? out[name] + ', ' + m[2] : m[2];
    out.__last = name;
  }
  delete out.__last;
  return out;
}

/** "Display Name <a@b.c>" | "a@b.c (comment)" → "a@b.c" (first address only). */
export function firstAddress(value) {
  if (!value) return '';
  const angle = value.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (angle) return angle[1];
  const bare = value.match(/([^\s,;<>"]+@[^\s,;<>"]+)/);
  return bare ? bare[1] : '';
}

/**
 * Best-effort plain-text body, for the one consumer that has to read mail rather than
 * just file it: an `agent` route handing the message to a model (docs/routes.md).
 *
 * Full MIME parsing stays out of scope (no dependencies, and IMAP clients parse the raw
 * themselves). This walks multipart bodies for the first text/plain part, decodes the two
 * transfer encodings that actually occur, and otherwise returns the body as-is. A model
 * tolerates imperfect text; what matters is never throwing on malformed mail.
 */
export function textBody(raw) {
  const text = raw.toString('latin1');
  const split = text.search(/\r?\n\r?\n/);
  const head = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? '' : text.slice(split).replace(/^\r?\n\r?\n/, '');
  const h = headers(Buffer.from(head, 'latin1'));
  const ctype = h['content-type'] || '';

  const decode = (part, encoding, charset) => {
    const enc = String(encoding || '').toLowerCase().trim();
    let buf;
    if (enc === 'base64') buf = Buffer.from(part.replace(/\s+/g, ''), 'base64');
    else if (enc === 'quoted-printable') {
      buf = Buffer.from(part.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g,
        (_m, x) => String.fromCharCode(parseInt(x, 16))), 'latin1');
    } else buf = Buffer.from(part, 'latin1');
    try { return new TextDecoder(charset || 'utf-8').decode(buf); } catch { return buf.toString('utf8'); }
  };
  const charsetOf = (ct) => (ct.match(/charset="?([^";\s]+)"?/i) || [])[1];

  const boundary = (ctype.match(/boundary="?([^";]+)"?/i) || [])[1];
  if (/^multipart\//i.test(ctype) && boundary) {
    for (const part of body.split(`--${boundary}`)) {
      const at = part.search(/\r?\n\r?\n/);
      if (at === -1) continue;
      const ph = headers(Buffer.from(part.slice(0, at), 'latin1'));
      const pct = ph['content-type'] || 'text/plain';
      if (!/^text\/plain/i.test(pct)) continue;
      return decode(part.slice(at).replace(/^\r?\n\r?\n/, ''),
        ph['content-transfer-encoding'], charsetOf(pct)).trim();
    }
    return ''; // html-only mail: nothing plain to hand over
  }
  return decode(body, h['content-transfer-encoding'], charsetOf(ctype)).trim();
}

/**
 * The text/html twin of textBody(), for the message-detail endpoint (docs/v1.md): walk
 * multipart bodies for the first text/html part, or a bare text/html body, and decode
 * the two transfer encodings that actually occur. Returns null when there is no HTML
 * part — the caller falls back to the plain text.
 */
export function htmlBody(raw) {
  const text = raw.toString('latin1');
  const split = text.search(/\r?\n\r?\n/);
  const body = split === -1 ? '' : text.slice(split).replace(/^\r?\n\r?\n/, '');
  const h = headers(raw);
  const ctype = h['content-type'] || '';

  const decode = (part, encoding, charset) => {
    const enc = String(encoding || '').toLowerCase().trim();
    let buf;
    if (enc === 'base64') buf = Buffer.from(part.replace(/\s+/g, ''), 'base64');
    else if (enc === 'quoted-printable') {
      buf = Buffer.from(part.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g,
        (_m, x) => String.fromCharCode(parseInt(x, 16))), 'latin1');
    } else buf = Buffer.from(part, 'latin1');
    try { return new TextDecoder(charset || 'utf-8').decode(buf); } catch { return buf.toString('utf8'); }
  };
  const charsetOf = (ct) => (ct.match(/charset="?([^";\s]+)"?/i) || [])[1];

  const boundary = (ctype.match(/boundary="?([^";]+)"?/i) || [])[1];
  if (/^multipart\//i.test(ctype) && boundary) {
    for (const part of body.split(`--${boundary}`)) {
      const at = part.search(/\r?\n\r?\n/);
      if (at === -1) continue;
      const ph = headers(Buffer.from(part.slice(0, at), 'latin1'));
      const pct = ph['content-type'] || 'text/plain';
      if (!/^text\/html/i.test(pct)) continue;
      return decode(part.slice(at).replace(/^\r?\n\r?\n/, ''),
        ph['content-transfer-encoding'], charsetOf(pct)).trim();
    }
    return null; // multipart with no HTML part
  }
  return /^text\/html/i.test(ctype)
    ? decode(body, h['content-transfer-encoding'], charsetOf(ctype)).trim()
    : null;
}

/** Decode a (single) RFC2047 encoded-word subject, best effort. */
export function subject(value) {
  if (!value) return '';
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, cs, enc, data) => {
    try {
      const buf = /b/i.test(enc)
        ? Buffer.from(data, 'base64')
        : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      return new TextDecoder(cs.toLowerCase()).decode(buf);
    } catch { return data; }
  }).trim();
}
