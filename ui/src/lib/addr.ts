// Email-address helpers, ported from the MailKite dashboard (subset).

/** The bare address out of `"Name <a@b>"` or `"a@b"`. */
export function bareAddr(s: string): string {
  const m = s.match(/<([^>]+)>/)
  return (m ? m[1] : s).trim()
}

/** A human label: display name when present, else the bare address. */
export function displayName(s: string): string {
  const name = s.replace(/<[^>]*>/, "").replace(/^["'\s]+|["'\s]+$/g, "")
  return name || bareAddr(s)
}
