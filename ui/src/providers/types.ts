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
