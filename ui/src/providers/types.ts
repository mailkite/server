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
  inbox: MailboxStatus
  sent: MailboxStatus
  capabilities: Capabilities
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
  credentials(): Promise<{ apiKeys: string[]; appPasswords: string[] }>
  createKey(): Promise<string>
  createAppPassword(username: string): Promise<string>
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
