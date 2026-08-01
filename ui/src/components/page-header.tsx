// The shared list-page header, ported from the MailKite dashboard — trimmed:
// the "</>" CodePanel button stays cloud-side (its samples lean on the cloud
// SDKs); here the right slot just takes the page's primary action.

import type { ReactNode } from "react"

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string
  description: ReactNode
  /** The primary action — a Button or link styled as one. */
  action?: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        <p className="mt-1 text-muted-foreground">{description}</p>
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  )
}
