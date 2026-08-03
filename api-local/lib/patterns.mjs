// Address pattern matching — the shared "which addresses does this apply to?" rule.
//
// Used by app passwords (docs/app-passwords.md) and available to any future routing
// feature, so one grammar covers both: a pattern is a local-part glob within one
// domain. `*` matches any run of characters (including none).
//
//   *            every address on the domain
//   hello        exactly hello@domain
//   support-*    support-anything@domain
//   *-agent      anything-agent@domain
//   ticket+*     ticket+anything@domain  (plus-addressing falls out of the glob)
//
// A pattern may also be written in full-address form (`*@domain`, `hello@domain`) —
// MailKite Cloud's route patterns look like that, so accepting both keeps one mental
// model across the two. The domain in that form must equal the domain being matched.
//
// Local parts are compared case-insensitively (the practical convention every mail
// host follows, and what the rest of this codebase already assumes by lowercasing
// addresses on the way in). Domains must match exactly.

/** Split an address into a lowercased { local, domain }; nulls if it isn't one. */
export function splitAddress(address) {
  const s = String(address || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at < 1 || at === s.length - 1) return { local: null, domain: null };
  return { local: s.slice(0, at), domain: s.slice(at + 1) };
}

/** Escape regex metacharacters, leaving `*` for the caller to translate. */
const escapeLiteral = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does `address` fall inside (`pattern`, `domain`)?
 *
 * @param {string} pattern  local-part glob, or a full `local@domain` form
 * @param {string} address  the concrete address being tested
 * @param {string} domain   the domain the pattern is scoped to
 */
export function matchesAddress(pattern, address, domain) {
  const scope = String(domain || '').trim().toLowerCase();
  const { local, domain: addrDomain } = splitAddress(address);
  if (!local || !addrDomain || !scope) return false;
  if (addrDomain !== scope) return false; // never match across domains

  let localPattern = String(pattern || '').trim().toLowerCase();
  if (!localPattern) return false;
  if (localPattern.includes('@')) {
    // Full-address form: the domain half must be this scope, then glob the local half.
    const at = localPattern.lastIndexOf('@');
    const patternDomain = localPattern.slice(at + 1);
    if (patternDomain !== scope) return false;
    localPattern = localPattern.slice(0, at);
    if (!localPattern) return false;
  }

  if (localPattern === '*') return true;
  if (!localPattern.includes('*')) return localPattern === local;

  const rx = new RegExp(`^${localPattern.split('*').map(escapeLiteral).join('.*')}$`);
  return rx.test(local);
}

/**
 * Validate a pattern for storage. Returns the normalized local-part form, or null
 * when it can't be stored (empty, or a full-address form naming another domain).
 */
export function normalizePattern(pattern, domain) {
  let p = String(pattern || '').trim().toLowerCase();
  if (!p) return null;
  if (p.includes('@')) {
    const at = p.lastIndexOf('@');
    if (p.slice(at + 1) !== String(domain || '').trim().toLowerCase()) return null;
    p = p.slice(0, at);
  }
  if (!p) return null;
  // Anything else is a legal glob; whitespace inside an address is not.
  return /\s/.test(p) ? null : p;
}
