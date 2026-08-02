// Connection state. Two ways in: a cookie session (magic-link sign-in — the
// default; nothing sensitive touches localStorage) or an explicit admin secret
// ("Advanced", persisted in localStorage for scripted/loopback setups).

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { logout, whoami } from "./auth"
import { LocalProvider, type LocalConfig } from "./local"
import type { MailProvider } from "./types"

const STORAGE_KEY = "mk-server-conn"

export type Connection =
  | { provider: "local"; mode: "cookie"; email: string; config: LocalConfig }
  | { provider: "local"; mode: "secret"; config: LocalConfig }

function readSecretConnection(): Connection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { provider?: string; config?: LocalConfig }
    if (parsed.provider === "local" && parsed.config?.baseUrl != null && parsed.config?.secret) {
      return { provider: "local", mode: "secret", config: parsed.config }
    }
    return null
  } catch {
    return null
  }
}

const Ctx = createContext<{
  status: "loading" | "ready"
  connection: Connection | null
  provider: MailProvider | null
  connectWithSecret: (config: LocalConfig) => void
  signedIn: (email: string) => void
  disconnect: () => void
}>({ status: "loading", connection: null, provider: null, connectWithSecret: () => {}, signedIn: () => {}, disconnect: () => {} })

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<"loading" | "ready">("loading")
  const [connection, setConnection] = useState<Connection | null>(null)

  // Boot: an existing cookie session wins; a stored secret is the fallback.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const email = await whoami()
      if (cancelled) return
      if (email) setConnection({ provider: "local", mode: "cookie", email, config: { baseUrl: "" } })
      else setConnection(readSecretConnection())
      setStatus("ready")
    })()
    return () => { cancelled = true }
  }, [])

  const connectWithSecret = useCallback((config: LocalConfig) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ provider: "local", config }))
    } catch {
      // Private mode — the session still works, it just won't survive a reload.
    }
    setConnection({ provider: "local", mode: "secret", config })
  }, [])

  const signedIn = useCallback((email: string) => {
    setConnection({ provider: "local", mode: "cookie", email, config: { baseUrl: "" } })
    setStatus("ready")
  }, [])

  const disconnect = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // ignore
    }
    if (connection?.mode === "cookie") void logout()
    setConnection(null)
  }, [connection])

  // A cookie session that expires mid-use sends every screen back to sign-in.
  useEffect(() => {
    const onUnauthorized = () => setConnection((c) => (c?.mode === "cookie" ? null : c))
    window.addEventListener("mk:unauthorized", onUnauthorized)
    return () => window.removeEventListener("mk:unauthorized", onUnauthorized)
  }, [])

  const provider = useMemo<MailProvider | null>(
    () => (connection ? new LocalProvider(connection.config) : null),
    [connection],
  )

  return (
    <Ctx.Provider value={{ status, connection, provider, connectWithSecret, signedIn, disconnect }}>
      {children}
    </Ctx.Provider>
  )
}

export function useConnection() {
  return useContext(Ctx)
}

/** The active provider — only call from screens rendered behind the sign-in gate. */
export function useProvider(): MailProvider {
  const { provider } = useContext(Ctx)
  if (!provider) throw new Error("useProvider called with no active connection")
  return provider
}
