// Console auth API (magic link + cookie sessions). Same-origin; every call
// carries the x-mailkite-ui header — the backend's CSRF gate for cookie auth.

const HDRS = { "x-mailkite-ui": "1", "content-type": "application/json" }

/**
 * The admin secret from the "Advanced" connect path, if that's how we're connected.
 * Setup runs before any cookie session exists on a scripted/loopback install, so these
 * calls must present the same credential the rest of the app uses — without it the
 * server correctly answers "not signed in" and setup is unreachable.
 */
function storedSecret(): string | null {
  try {
    const raw = localStorage.getItem("mk-server-conn")
    return raw ? (JSON.parse(raw)?.config?.secret ?? null) : null
  } catch {
    return null
  }
}

function authHeaders(): Record<string, string> {
  const secret = storedSecret()
  return secret ? { ...HDRS, authorization: `Bearer ${secret}` } : HDRS
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) })
}

/**
 * Ask for a sign-in link. The server always answers {ok:true} (no enumeration).
 * When it has no way to send mail, a known admin email is signed in immediately
 * instead — {signedIn:true} means we're already in.
 */
export async function requestLink(email: string): Promise<{ signedIn: boolean; email?: string }> {
  const res = await post("/api/auth/request-link", { email })
  const body = await res.json().catch(() => ({}) as { signedIn?: boolean; email?: string })
  return { signedIn: !!body.signedIn, email: body.email }
}

export async function verifyToken(token: string): Promise<string> {
  const res = await post("/api/auth/verify", { token })
  const body = await res.json().catch(() => ({}) as { email?: string; error?: string })
  if (!res.ok) throw new Error(body.error || "That sign-in link is invalid or expired.")
  return body.email as string
}

export type AuthMethod = "email_cloud" | "email_smtp" | "oauth_google" | "oauth_github"

export type AuthStatus = {
  /** Nobody has claimed this install yet — the first email entered becomes the admin. */
  needsSetup: boolean
  /** Claimed, but no sign-in method has been proven yet: the console gates on it. */
  setupRequired: boolean
  method: AuthMethod | null
  mailChannel: boolean
}

/** Drives routing and which sign-in the screen offers. Never carries credentials. */
export async function authStatus(): Promise<AuthStatus> {
  const fallback: AuthStatus = { needsSetup: false, setupRequired: false, method: null, mailChannel: true }
  try {
    const res = await fetch("/api/auth/status", { headers: authHeaders() })
    if (!res.ok) return fallback
    return { ...fallback, ...((await res.json()) as Partial<AuthStatus>) }
  } catch {
    return fallback
  }
}

export type SetupState = {
  state: "unclaimed" | "setup" | "complete"
  method: AuthMethod | null
  /** 'env' installs are configured by environment variables and can't be changed here. */
  source: "env" | "configured" | null
  verifiedAt: number | null
  settings: Record<string, unknown>
  pending: { kind: string; method: string; sentTo: string } | null
  adminEmail: string
}

export async function setupState(): Promise<SetupState> {
  const res = await fetch("/api/auth/setup-state", { headers: authHeaders() })
  if (!res.ok) throw new Error("Could not read setup state.")
  return (await res.json()) as SetupState
}

async function postOrThrow(path: string, body: unknown) {
  const res = await post(path, body)
  const data = await res.json().catch(() => ({}) as { error?: string })
  if (!res.ok) throw new Error(data.error || "That didn't work.")
  return data
}

export type SmtpFields = { host: string; port: string; user: string; pass: string; from: string }

/** Send the verification code through the candidate config. Throws if it can't send. */
export async function startEmailSetup(input: { mode: "cloud"; key: string; from: string } | { mode: "smtp"; smtp: SmtpFields }) {
  const body = input.mode === "cloud"
    ? { mode: "cloud", key: input.key, from: input.from }
    : { mode: "smtp", smtp: { ...input.smtp, port: Number(input.smtp.port) || 587 } }
  return postOrThrow("/api/auth/setup/email", body) as Promise<{ sent: boolean; to: string }>
}

export async function verifyEmailSetup(code: string) {
  return postOrThrow("/api/auth/setup/email/verify", { code }) as Promise<{ method: AuthMethod }>
}

export async function startOauthSetup(input: {
  provider: "google" | "github"; clientId: string; clientSecret: string; allowedEmails: string[]
}) {
  return postOrThrow("/api/auth/setup/oauth", input) as Promise<{ authorizeUrl: string }>
}

export async function completeSetup(email: string): Promise<string> {
  const res = await post("/api/auth/setup", { email })
  const body = await res.json().catch(() => ({}) as { email?: string; error?: string })
  if (!res.ok) throw new Error(body.error || "Setup failed.")
  return body.email as string
}

/** Who the session cookie says we are, or null. */
export async function whoami(): Promise<string | null> {
  try {
    const res = await fetch("/api/auth/me", { headers: authHeaders() })
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

/** Token from a /login#token=… URL. */
export function tokenFromHash(): string | null {
  const m = window.location.hash.match(/token=([^&]+)/)
  return m ? decodeURIComponent(m[1]) : null
}
