// Docs: docs/dashboard/components/ui/card.md
import * as React from "react"
import { cn } from "@/lib/utils"

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("rounded-lg border border-border bg-card text-card-foreground shadow-sm", className)}
      {...props}
    />
  )
}

// gap-2 title→description and pb-6 give the header room to breathe above the body —
// the same rhythm as the onboarding card, so every overview card matches.
function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-2 p-5 pb-6", className)} {...props} />
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("font-semibold leading-none tracking-tight", className)} {...props} />
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("text-sm text-muted-foreground", className)} {...props} />
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("p-5 pt-0", className)} {...props} />
}

// Pinned to the bottom of the card and split from the body by a hairline. Pair with
// `flex flex-col` on Card and `flex-1` on CardContent so it stays at the end even when
// the body is short.
function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("mt-auto border-t border-border px-5 py-4", className)} {...props} />
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter }
