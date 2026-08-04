// App root: Connect gate + a minimal hash router (#/domains, #/messages,
// #/credentials, #/webhooks). Deviation from the cloud dashboard's TanStack
// Router, noted in the README: four flat screens don't earn a route tree; the
// provider seam keeps screens portable if that changes.

import { Component, useEffect, useState, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { AlertTriangle, RefreshCw } from "lucide-react"
import { AppShell, type NavKey } from "@/components/app-shell"
import { Button } from "@/components/ui/button"
import { authStatus } from "@/providers/auth"
import { useConnection } from "@/providers/context"
import { SignInScreen } from "@/screens/connect"
import { LoginCallback } from "@/screens/login"
import { SetupScreen } from "@/screens/setup"
import { AuthSetupScreen } from "@/screens/auth-setup"
import { DomainsScreen } from "@/screens/domains"
import { MessagesScreen } from "@/screens/messages"
import { CredentialsScreen } from "@/screens/credentials"
import { WebhooksScreen } from "@/screens/webhooks"

const KEYS: NavKey[] = ["domains", "messages", "credentials", "webhooks"]

function readHash(): NavKey {
  const h = window.location.hash.replace(/^#\/?/, "")
  return (KEYS as string[]).includes(h) ? (h as NavKey) : "domains"
}

function useHashRoute(): [NavKey, (k: NavKey) => void] {
  const [route, setRoute] = useState<NavKey>(readHash)
  useEffect(() => {
    const onHash = () => setRoute(readHash())
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])
  return [route, (k) => { window.location.hash = `/${k}` }]
}

// Route-level error state — the dashboard's RouteErrorPage pattern, trimmed of
// its cloud-only stale-chunk detection.
class ScreenBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
        <div className="flex size-12 items-center justify-center rounded-full border border-border bg-card">
          <AlertTriangle className="size-6 text-muted-foreground" />
        </div>
        <h1 className="mt-5 text-xl font-semibold tracking-tight">Something went wrong</h1>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">This screen hit an unexpected error. Reloading usually clears it.</p>
        <pre className="mt-3 max-w-md overflow-x-auto rounded-md border border-border bg-muted/40 px-3 py-2 text-left font-mono text-xs text-muted-foreground">
          {this.state.error.message}
        </pre>
        <Button className="mt-6" onClick={() => window.location.reload()}>
          <RefreshCw className="size-4" /> Refresh page
        </Button>
      </div>
    )
  }
}

// Unclaimed install → first-run admin claim; otherwise the sign-in screen.
function UnauthedGate() {
  const setup = useQuery({ queryKey: ["auth-status"], queryFn: authStatus, staleTime: 0 })
  if (setup.isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <span className="text-sm text-muted-foreground">Loading…</span>
      </div>
    )
  }
  return setup.data?.needsSetup ? <SetupScreen /> : <SignInScreen />
}

export function App() {
  const { connection, status } = useConnection()
  const [route, navigate] = useHashRoute()
  // Claimed but no sign-in method yet: the console is gated on finishing setup, so the
  // window where knowing the admin address is enough lasts one session (docs/auth-setup.md).
  const auth = useQuery({ queryKey: ["auth-status"], queryFn: authStatus, staleTime: 0, enabled: !!connection })

  // Auth flows land on real paths (magic-link URLs survive # fragments better).
  const path = window.location.pathname
  if (path === "/login") return <LoginCallback />

  if (status === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <span className="text-sm text-muted-foreground">Loading…</span>
      </div>
    )
  }
  if (!connection) return <UnauthedGate />

  if (auth.data?.setupRequired) {
    return <AuthSetupScreen onDone={() => auth.refetch()} />
  }

  return (
    <AppShell active={route} onNavigate={navigate}>
      <ScreenBoundary key={route}>
        {route === "domains" && <DomainsScreen />}
        {route === "messages" && <MessagesScreen />}
        {route === "credentials" && <CredentialsScreen />}
        {route === "webhooks" && <WebhooksScreen />}
      </ScreenBoundary>
    </AppShell>
  )
}
