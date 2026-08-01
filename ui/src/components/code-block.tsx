// Copy-paste-first code/DNS block. Fresh (the dashboard's CodePanel is a
// cloud-SDK slide-over; this console needs plain values with one-click copy —
// DNS records, env lines, secrets). Mono body, quiet chrome, copy affordance.

import { useState } from "react"
import { Check, Copy } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          toast.success(label ? `${label} copied` : "Copied")
          setTimeout(() => setCopied(false), 1500)
        } catch {
          toast.error("Couldn't copy — select the text instead")
        }
      }}
      aria-label={label ? `Copy ${label}` : "Copy"}
      className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
    </button>
  )
}

export function CodeBlock({ value, className }: { value: string; className?: string }) {
  return (
    <div className={cn("group relative rounded-md border border-border bg-rail", className)}>
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground">{value}</pre>
      <div className="absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <CopyButton value={value} />
      </div>
    </div>
  )
}

/** A labeled key/value row with copy — the DNS-record and secret-reveal unit. */
export function ValueRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-rail px-3 py-2">
      <div className="min-w-0">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={cn("truncate text-sm", mono && "font-mono text-[13px]")} title={value}>
          {value}
        </div>
      </div>
      <CopyButton value={value} label={label} />
    </div>
  )
}
