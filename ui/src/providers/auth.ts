// Console auth API (magic link + cookie sessions). Same-origin; every call
// carries the x-mailkite-ui header — the backend's CSRF gate for cookie auth.

const HDRS = { "x-mailkite-ui": "1", "content-type": "application/json" }

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, { method: "POST", headers: HDRS, body: JSON.stringify(body) })
}

/** Fire-and-forget by design: the server always answers {ok:true} (no enumeration). */
export async function requestLink(email: string): Promise<void> {
  await post("/api/auth/request-link", { email })
}

export async function verifyToken(token: string): Promise<string> {
  const res = await post("/api/auth/verify", { token })
  const body = await res.json().catch(() => ({}) as { email?: string; error?: string })
  if (!res.ok) throw new Error(body.error || "That sign-in link is invalid or expired.")
  return body.email as string
}

export async function completeSetup(token: string, email: string): Promise<string> {
  const res = await post("/api/auth/setup", { token, email })
  const body = await res.json().catch(() => ({}) as { email?: string; error?: string })
  if (!res.ok) throw new Error(body.error || "Setup failed.")
  return body.email as string
}

/** Who the session cookie says we are, or null. */
export async function whoami(): Promise<string | null> {
  try {
    const res = await fetch("/api/auth/me", { headers: { "x-mailkite-ui": "1" } })
    if (!res.ok) return null
    const { email } = await res.json()
    return email ?? null
  } catch {
    return null
  }
}

export async function logout(): Promise<void> {
  await post("/api/auth/logout", {}).catch(() => {})
}

/** Token from a /login#token=… or /setup#token=… URL. */
export function tokenFromHash(): string | null {
  const m = window.location.hash.match(/token=([^&]+)/)
  return m ? decodeURIComponent(m[1]) : null
}
