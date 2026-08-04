// Just enough MIME to *read* a message. api-local stores and serves raw RFC822 — the
// list gives us envelope fields, but the reading view needs the body, so the parsing
// happens here rather than adding a parsed-message endpoint to the contract.
//
// Scope is deliberate: headers, encoded-words, one level of multipart, and the two
// transfer encodings that actually appear (base64, quoted-printable). Anything it can't
// decode falls back to showing the text as-is — a reading view should degrade to
// "slightly wrong text", never to a blank pane.

export type ParsedMessage = {
  /** Lowercased header name → unfolded value (later duplicates joined with ", "). */
  headers: Record<string, string>
  /** The whole header block, verbatim, for the details view. */
  headerBlock: string
  text: string | null
  html: string | null
}

const decodeBase64 = (s: string, charset: string): string => {
  try {
    const bin = atob(s.replace(/\s+/g, ""))
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    return new TextDecoder(charset || "utf-8").decode(bytes)
  } catch {
    return s
  }
}

const decodeQuotedPrintable = (s: string, charset: string): string => {
  // Soft line breaks first, then hex escapes — order matters, "=\r\n" is not an escape.
  const unfolded = s.replace(/=\r?\n/g, "")
  const bytes: number[] = []
  for (let i = 0; i < unfolded.length; i++) {
    if (unfolded[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(unfolded.slice(i + 1, i + 3))) {
      bytes.push(parseInt(unfolded.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      // Latin-1 pass-through: any multi-byte char was already =XX-escaped.
      bytes.push(unfolded.charCodeAt(i) & 0xff)
    }
  }
  try {
    return new TextDecoder(charset || "utf-8").decode(Uint8Array.from(bytes))
  } catch {
    return unfolded
  }
}

/** RFC2047 encoded-words, as they appear in Subject/From. */
export function decodeWords(value: string): string {
  if (!value) return ""
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset: string, enc: string, data: string) =>
    /b/i.test(enc)
      ? decodeBase64(data, charset)
      // In encoded-words specifically, "_" means space.
      : decodeQuotedPrintable(data.replace(/_/g, " "), charset),
  )
}

function splitHeaders(raw: string): { headerBlock: string; body: string } {
  const i = raw.search(/\r?\n\r?\n/)
  if (i === -1) return { headerBlock: raw, body: "" }
  const gap = raw.slice(i).match(/^\r?\n\r?\n/)![0]
  return { headerBlock: raw.slice(0, i), body: raw.slice(i + gap.length) }
}

function parseHeaders(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  let last = ""
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && last) {
      out[last] += " " + line.trim() // folded continuation
      continue
    }
    const m = line.match(/^([!-9;-~]+):[ \t]*(.*)$/)
    if (!m) continue
    const name = m[1].toLowerCase()
    out[name] = out[name] ? `${out[name]}, ${m[2]}` : m[2]
    last = name
  }
  return out
}

const paramOf = (headerValue: string, key: string): string => {
  const m = new RegExp(`${key}\\s*=\\s*"?([^";\\s]+)"?`, "i").exec(headerValue || "")
  return m ? m[1] : ""
}

function decodeBody(body: string, encoding: string, charset: string): string {
  const enc = (encoding || "").trim().toLowerCase()
  if (enc === "base64") return decodeBase64(body, charset)
  if (enc === "quoted-printable") return decodeQuotedPrintable(body, charset)
  return body
}

/** Parse a raw RFC822 message into what a reading view needs. */
export function parseMessage(raw: string): ParsedMessage {
  const { headerBlock, body } = splitHeaders(raw)
  const headers = parseHeaders(headerBlock)
  const contentType = headers["content-type"] || "text/plain"
  const boundary = paramOf(contentType, "boundary")

  if (!/^multipart\//i.test(contentType) || !boundary) {
    const decoded = decodeBody(body, headers["content-transfer-encoding"], paramOf(contentType, "charset"))
    const isHtml = /^text\/html/i.test(contentType)
    return { headers, headerBlock, text: isHtml ? null : decoded, html: isHtml ? decoded : null }
  }

  // One level is enough for what this server sends; a nested multipart/related inside
  // an alternative still yields its text part, which is what the reader wants.
  let text: string | null = null
  let html: string | null = null
  for (const part of body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?\\r?\\n?`))) {
    if (!part.trim()) continue
    const p = splitHeaders(part)
    const ph = parseHeaders(p.headerBlock)
    const ct = ph["content-type"] || ""
    if (!/^text\//i.test(ct)) continue
    const decoded = decodeBody(p.body, ph["content-transfer-encoding"], paramOf(ct, "charset")).replace(/\r?\n$/, "")
    if (/^text\/html/i.test(ct)) html ??= decoded
    else text ??= decoded
  }
  return { headers, headerBlock, text, html }
}
