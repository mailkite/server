// Small shared formatters, ported from the MailKite dashboard (trimmed: no ApiError).

/** A timestamp in the browser's locale (date + time). */
export function when(ts: number | string) {
  return new Date(ts).toLocaleString()
}

/** Compact age for list rows — "now", "42m", "6h", "Tue", "4 Mar". */
export function shortWhen(ts: number | string) {
  const t = typeof ts === "string" ? Date.parse(ts) : ts
  const diff = Date.now() - t
  const min = Math.round(diff / 60_000)
  if (min < 1) return "now"
  if (min < 60) return `${min}m`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h`
  const d = new Date(t)
  if (diff < 7 * 86_400_000) return d.toLocaleDateString(undefined, { weekday: "short" })
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** Human byte size — B / KB / MB. */
export function bytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Best-effort message from an unknown thrown value. */
export function errMsg(e: unknown) {
  return (e as Error)?.message || "Something went wrong"
}
