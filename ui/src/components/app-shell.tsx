// The console shell — the MailKite dashboard's sidebar/header pattern,
// simplified for the self-hosted console (no teams, billing, or agent panel).
// Sidebar: brand, nav (capability-gated), theme toggle + disconnect.

import { useState, type ReactNode } from "react"
import { Globe, Inbox, KeyRound, Menu, Moon, Sun, Unplug, Webhook, X, ArrowUpRight } from "lucide-react"
import { Logo } from "@/components/logo"
import { Button } from "@/components/ui/button"
import { useTheme } from "@/lib/theme"
import { useConnection } from "@/providers/context"
import { cn } from "@/lib/utils"

export type NavKey = "domains" | "messages" | "credentials" | "webhooks"

const NAV: { key: NavKey; label: string; icon: typeof Globe }[] = [
  { key: "domains", label: "Domains", icon: Globe },
  { key: "messages", label: "Messages", icon: Inbox },
  { key: "credentials", label: "Credentials", icon: KeyRound },
  { key: "webhooks", label: "Webhooks & routes", icon: Webhook },
]

export function AppShell({
  active,
  onNavigate,
  children,
}: {
  active: NavKey
  onNavigate: (key: NavKey) => void
  children: ReactNode
}) {
  const { theme, toggle } = useTheme()
  const { connection, disconnect } = useConnection()
  const [mobileOpen, setMobileOpen] = useState(false)

  const nav = (
    <nav className="nav-scroll flex-1 overflow-y-auto p-3" aria-label="Main">
      <ul className="space-y-1">
        {NAV.map(({ key, label, icon: Icon }) => (
          <li key={key}>
            <button
              type="button"
              onClick={() => {
                onNavigate(key)
                setMobileOpen(false)
              }}
              aria-current={active === key ? "page" : undefined}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active === key
                  ? "bg-secondary font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              {label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )

  const footer = (
    <div className="border-t border-border p-3">
      <a
        href="https://mailkite.dev"
        target="_blank"
        rel="noreferrer"
        className="mb-2 flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        Don&rsquo;t want to run a server? MailKite Cloud <ArrowUpRight className="size-3" />
      </a>
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="truncate text-xs text-muted-foreground" title={connection?.config.baseUrl || "same origin"}>
          {connection ? "Local server" : "Not connected"}
        </span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={toggle} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}>
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
          <Button variant="ghost" size="icon" onClick={disconnect} aria-label="Disconnect from server" title="Disconnect">
            <Unplug className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )

  const brand = (
    <div className="flex items-center gap-2.5 border-b border-border px-4 py-4">
      <Logo className="size-5" />
      <span className="text-sm font-semibold tracking-tight">
        MailKite <span className="text-muted-foreground">Server</span>
      </span>
    </div>
  )

  return (
    <div className="brand-backdrop flex min-h-dvh bg-background">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-border bg-rail md:flex">
        {brand}
        {nav}
        {footer}
      </aside>

      {/* Mobile top bar + drawer */}
      <div className="fixed inset-x-0 top-0 z-40 flex items-center justify-between border-b border-border bg-background/90 px-4 py-3 backdrop-blur md:hidden">
        <div className="flex items-center gap-2">
          <Logo className="size-5" />
          <span className="text-sm font-semibold tracking-tight">MailKite Server</span>
        </div>
        <Button variant="ghost" size="icon" onClick={() => setMobileOpen(true)} aria-label="Open menu">
          <Menu className="size-5" />
        </Button>
      </div>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-border bg-rail">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <Logo className="size-5" />
                <span className="text-sm font-semibold">MailKite Server</span>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)} aria-label="Close menu">
                <X className="size-5" />
              </Button>
            </div>
            {nav}
            {footer}
          </div>
        </div>
      )}

      <main className="min-w-0 flex-1 px-4 pb-16 pt-16 md:px-8 md:pt-8">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  )
}
