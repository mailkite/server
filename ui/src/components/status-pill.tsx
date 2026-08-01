// Health pill, ported from the MailKite dashboard. The cloud-only WebhookStatus
// type is replaced by a local PillStatus so the component is self-contained.

export type PillStatus = {
  status: "ok" | "running" | "timeout" | "fail"
  message?: string
  at?: number
  consecutiveFailures?: number
  unhealthy?: boolean
}

// Compact relative time ("3m ago", "2d ago") for status timestamps.
function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

// `null` = never exercised yet. Hover shows the reason + when.
export function StatusPill({ status }: { status: PillStatus | null }) {
  if (!status) {
    return <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">Untested</span>
  }
  const fails = status.consecutiveFailures ?? 0
  const variant =
    status.status === "ok" ? { tone: "bg-primary/15 text-primary", dot: "bg-primary", label: "OK", pulse: false }
    : status.status === "running" ? { tone: "bg-amber-500/15 text-amber-600 dark:text-amber-400", dot: "bg-amber-500", label: "Running", pulse: true }
    : status.status === "timeout" ? { tone: "bg-amber-500/15 text-amber-600 dark:text-amber-400", dot: "bg-amber-500", label: "Timed out", pulse: false }
    : { tone: "bg-destructive/15 text-destructive", dot: "bg-destructive", label: status.unhealthy ? `Unhealthy ×${fails}` : "Failing", pulse: false }
  const detail = [status.message, status.at ? timeAgo(status.at) : null].filter(Boolean).join(" · ")
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${variant.tone}`} title={detail || undefined}>
      <span className={`size-1.5 rounded-full ${variant.dot} ${variant.pulse ? "animate-pulse" : ""}`} />
      {variant.label}
      {status.at && <span className="font-normal opacity-70">· {timeAgo(status.at)}</span>}
    </span>
  )
}
