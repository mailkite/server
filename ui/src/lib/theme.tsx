// Docs: docs/dashboard/lib/theme.md
import { createContext, useContext, useEffect, useState, type ReactNode } from "react"

// Light/dark theming on the same contract as the marketing site: a `data-theme`
// attribute on <html> drives the CSS token overrides (see index.css). The initial
// value is set pre-paint by the inline script in index.html; this provider takes
// it from there, then persists changes to localStorage so it survives reloads.

export type Theme = "light" | "dark"

function readInitialTheme(): Theme {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.dataset.theme
    if (attr === "light" || attr === "dark") return attr
  }
  return "dark"
}

const ThemeContext = createContext<{
  theme: Theme
  setTheme: (theme: Theme) => void
  toggle: () => void
}>({ theme: "dark", setTheme: () => {}, toggle: () => {} })

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readInitialTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem("theme", theme)
    } catch {
      // Private mode / storage disabled — the attribute still applies this session.
    }
  }, [theme])

  const toggle = () => setTheme((prev) => (prev === "light" ? "dark" : "light"))

  return <ThemeContext.Provider value={{ theme, setTheme, toggle }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  return useContext(ThemeContext)
}
