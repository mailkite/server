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
