// The UI's provider contract — every screen talks to a MailProvider, never to a
// backend directly. Mirrors the repo's backend philosophy: the same screens work
// against api-local (self-hosted) or MailKite Cloud, and `capabilities()`
// gates what a driver's backend can honestly claim.

export type Mailbox = "INBOX" | "Sent"

export type Capabilities = {
  inbound: boolean
  imap: boolean
  outboundLocal: boolean
  outboundInternet: boolean
  webhooks: boolean
  routes: boolean
}

export type MessageRow = {
  uid: number
  flags: string // backslash-less, space-separated ("Seen Flagged")
  internaldate: string
  from_addr: string | null
  to_addr: string | null
  subject: string | null
  size: number
}

export type MessagePage = { messages: MessageRow[]; nextBefore: number | null }

export type MailboxStatus = { total: number; unseen: number }

export type Overview = {
  domains: number
  /** This server's public IPv4, detected from the hostname you're browsing. */
  publicIp: string | null
  inbox: MailboxStatus
  sent: MailboxStatus
  capabilities: Capabilities
}

/** An app password: what it covers (docs/app-passwords.md) — never the secret itself. */
export type AppPassword = {
  id: number
  label: string | null
  domain: string
  /** Local-part pattern: "*" (whole domain), "hello", "support-*", "*-agent". */
  address: string
  protocols: ("imap" | "api")[]
  created_at: number | null
  last_used_at: number | null
  /** Masked hint for the list; null when the secret can no longer be shown. */
  masked?: string | null
  canReveal?: boolean
}

export type NewAppPassword = {
  domain: string
  address: string
  protocols: ("imap" | "api")[]
  label?: string | null
}

/** A message composed in the console. Bcc is envelope-only — never a header. */
export type Compose = {
  from: string
  to: string
  cc?: string
  bcc?: string
  subject: string
  text: string
}

/** What actually happened to a composed message — the console reports this verbatim. */
export type SendResult = {
  stored: boolean
  messageId: string
  localDelivered: number
  external: number
  smarthost: "cloud" | "smtp" | null
  relayed: number
}

export type WebhookConfig = { domain: string; url: string | null; secret?: string | null }

export type Delivery = {
  id: number
  domain: string
  url: string
  status: "pending" | "delivered" | "failed"
  attempts: number
  next_attempt: number
  last_error: string | null
  created: number
  updated: number
}

export type WebhookStatus = {
  recent: Delivery[]
  counts: { pending: number; delivered: number; failed: number }
}

/** What a route does with a matching message (docs/routes.md). */
export type RouteAction = "webhook" | "forward" | "agent"

/**
 * One address-level rule. The AI key is deliberately absent: it goes in on create and is
 * never readable back, so `hasAiKey` is all the console ever knows about it.
 */
export type Route = {
  id: number
  domain: string
  /** Local-part pattern, same grammar as an app password's: "*", "support", "ticket+*". */
  match_pattern: string
  action: RouteAction
  /** webhook: the URL. forward: the address. agent: unused. */
  destination: string | null
  /** webhook only — this route's own signing secret. */
  webhook_secret: string | null
  agent_prompt: string | null
  agent_forward_to: string[]
  ai_provider: string | null
  ai_base_url: string | null
  ai_model: string | null
  hasAiKey: boolean
  active: boolean
  created_at: number
}

/** A provider the backend can call for `agent` routes, as advertised by the backend. */
export type AiProvider = {
  id: string
  label: string
  /** Absent for `custom`, which needs one supplied. */
  baseUrl?: string
  defaultModel: string
}

export type NewRoute = {
  domain: string
  matchPattern: string
  action: RouteAction
  destination?: string | null
  agentPrompt?: string | null
  agentForwardTo?: string[] | null
  aiProvider?: string | null
  aiApiKey?: string | null
  aiBaseUrl?: string | null
  aiModel?: string | null
}

export interface MailProvider {
  /** Short label for the header ("Local server", "MailKite Cloud"). */
  readonly name: string
  overview(): Promise<Overview>
  capabilities(): Promise<Capabilities>
  domains(): Promise<string[]>
  addDomain(domain: string): Promise<void>
  messages(mailbox: Mailbox, opts?: { limit?: number; before?: number }): Promise<MessagePage>
  rawMessage(mailbox: Mailbox, uid: number): Promise<string>
  /** Compose and send — the same pipeline the submission edge feeds. */
  send(message: Compose): Promise<SendResult>
  credentials(): Promise<{ apiKeys: string[]; appPasswords: string[] }>
  createKey(): Promise<string>
  /** App passwords — mailbox access for a mail client, an app, or an agent. */
  appPasswords(): Promise<AppPassword[]>
  createAppPassword(spec: NewAppPassword): Promise<{ secret: string } & AppPassword>
  /** Show a stored secret again (admin-only, one at a time). */
  revealAppPassword(id: number): Promise<string>
  /** Edit what a password covers. The domain is fixed at creation. */
  updateAppPassword(id: number, patch: Partial<Pick<NewAppPassword, "label" | "address" | "protocols">>): Promise<AppPassword>
  /** New secret; the old one stops working immediately. */
  rotateAppPassword(id: number): Promise<string>
  deleteAppPassword(id: number): Promise<void>
  /** Inbound webhook config — one target per domain. */
  webhooks(): Promise<WebhookConfig[]>
  webhook(domain: string): Promise<WebhookConfig>
  /** Empty url clears the webhook. Returns the (stable) signing secret when set. */
  setWebhook(domain: string, url: string): Promise<WebhookConfig>
  webhookStatus(domain?: string): Promise<WebhookStatus>
  /** Routes — address-level inbound rules (docs/routes.md), with the AI providers on offer. */
  routes(): Promise<{ routes: Route[]; providers: AiProvider[] }>
  createRoute(spec: NewRoute): Promise<Route>
  /** Partial edit. Domain and action are fixed at creation; omitting aiApiKey keeps the stored one. */
  updateRoute(id: number, patch: Partial<NewRoute> & { active?: boolean }): Promise<Route>
  /** New signing secret for a webhook route; the old one stops verifying immediately. */
  rotateRouteSecret(id: number): Promise<string>
  deleteRoute(id: number): Promise<void>
}

export class ProviderError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export class NotImplemented extends ProviderError {
  constructor(what: string) {
    super(501, `${what} is not available on this provider yet`)
  }
}
