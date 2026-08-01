// Connection state: which provider the console is talking to, persisted in
// localStorage ("mk-server-conn"). No connection → the Connect screen.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import { LocalProvider, type LocalConfig } from "./local"
import type { MailProvider } from "./types"

const STORAGE_KEY = "mk-server-conn"

export type Connection = { provider: "local"; config: LocalConfig }

function readConnection(): Connection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Connection
    if (parsed.provider === "local" && parsed.config?.baseUrl != null && parsed.config?.secret) return parsed
    return null
  } catch {
    return null
  }
}

const Ctx = createContext<{
  connection: Connection | null
  provider: MailProvider | null
  connect: (c: Connection) => void
  disconnect: () => void
}>({ connection: null, provider: null, connect: () => {}, disconnect: () => {} })

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<Connection | null>(readConnection)

  const connect = useCallback((c: Connection) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(c))
    } catch {
      // Private mode — the session still works, it just won't survive a reload.
    }
    setConnection(c)
  }, [])

  const disconnect = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // ignore
    }
    setConnection(null)
  }, [])

  const provider = useMemo<MailProvider | null>(
    () => (connection ? new LocalProvider(connection.config) : null),
    [connection],
  )

  return <Ctx.Provider value={{ connection, provider, connect, disconnect }}>{children}</Ctx.Provider>
}

export function useConnection() {
  return useContext(Ctx)
}

/** The active provider — only call from screens rendered behind the Connect gate. */
export function useProvider(): MailProvider {
  const { provider } = useContext(Ctx)
  if (!provider) throw new Error("useProvider called with no active connection")
  return provider
}
