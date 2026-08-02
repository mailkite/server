// `local` driver — api-local's admin API (/api/admin/*). Same-origin in
// production (api-local serves ui/dist); the Vite dev server proxies /api.
//
// Auth: cookie session by default (magic-link sign-in; the x-mailkite-ui header
// is the backend's CSRF gate). Advanced mode still accepts the admin secret as a
// Bearer for scripted/loopback use. A 401 on any call announces itself via the
// "mk:unauthorized" window event so the app can return to sign-in.

import {
  NotImplemented,
  ProviderError,
  type Capabilities,
  type MailProvider,
  type Mailbox,
  type MessagePage,
  type Overview,
} from "./types"

export type LocalConfig = { baseUrl: string; secret?: string }

export class LocalProvider implements MailProvider {
  readonly name = "Local server"
  private cfg: LocalConfig

  constructor(cfg: LocalConfig) {
    this.cfg = { ...cfg, baseUrl: cfg.baseUrl.replace(/\/+$/, "") }
  }

  private async call(path: string, init?: RequestInit): Promise<Response> {
    let res: Response
    try {
      res = await fetch(this.cfg.baseUrl + path, {
        ...init,
        headers: {
          "x-mailkite-ui": "1",
          ...(this.cfg.secret ? { authorization: `Bearer ${this.cfg.secret}` } : {}),
          ...(init?.body ? { "content-type": "application/json" } : {}),
          ...init?.headers,
        },
      })
    } catch {
      throw new ProviderError(0, "Can't reach the server — is api-local running?")
    }
    if (!res.ok) {
      if (res.status === 401 && !this.cfg.secret) window.dispatchEvent(new Event("mk:unauthorized"))
      const body = await res.json().catch(() => ({}) as { error?: string })
      throw new ProviderError(res.status, body.error || `Request failed (${res.status})`)
    }
    return res
  }

  async overview(): Promise<Overview> {
    return (await this.call("/api/admin/overview")).json()
  }
  async capabilities(): Promise<Capabilities> {
    return (await this.overview()).capabilities
  }
  async domains(): Promise<string[]> {
    const { domains } = await (await this.call("/api/admin/domains")).json()
    return domains
  }
  async addDomain(domain: string): Promise<void> {
    await this.call("/api/admin/domains", { method: "POST", body: JSON.stringify({ domain }) })
  }
  async messages(mailbox: Mailbox, opts?: { limit?: number; before?: number }): Promise<MessagePage> {
    const q = new URLSearchParams({ mailbox })
    if (opts?.limit) q.set("limit", String(opts.limit))
    if (opts?.before) q.set("before", String(opts.before))
    return (await this.call(`/api/admin/messages?${q}`)).json()
  }
  async rawMessage(mailbox: Mailbox, uid: number): Promise<string> {
    return (await this.call(`/api/admin/raw?mailbox=${mailbox}&uid=${uid}`)).text()
  }
  async credentials(): Promise<{ apiKeys: string[]; appPasswords: string[] }> {
    return (await this.call("/api/admin/credentials")).json()
  }
  async createKey(): Promise<string> {
    const { key } = await (await this.call("/api/admin/keys", { method: "POST", body: "{}" })).json()
    return key
  }
  async createAppPassword(username: string): Promise<string> {
    const { password } = await (
      await this.call("/api/admin/app-passwords", { method: "POST", body: JSON.stringify({ username }) })
    ).json()
    return password
  }

  /** v1 has no webhook config surface — capabilities() already reports it. */
  static readonly notImplemented = NotImplemented
}
