// `cloud` driver — MailKite Cloud. EXPERIMENTAL STUB in v1: the Connect screen
// presents Cloud as "coming soon" and never constructs this driver. It exists so
// the provider seam is real from day one; the methods refuse honestly rather
// than fabricating endpoints. The full driver lands with the cloud read API.

import {
  NotImplemented,
  type Capabilities,
  type MailProvider,
  type MessagePage,
  type Overview,
} from "./types"

export class CloudProvider implements MailProvider {
  readonly name = "MailKite Cloud"

  async capabilities(): Promise<Capabilities> {
    // What the cloud actually offers — used only for the roadmap card copy.
    return { inbound: true, imap: true, outboundLocal: true, outboundInternet: true, webhooks: true, routes: true }
  }
  async overview(): Promise<Overview> {
    throw new NotImplemented("MailKite Cloud connection")
  }
  async domains(): Promise<string[]> {
    throw new NotImplemented("MailKite Cloud connection")
  }
  async addDomain(): Promise<void> {
    throw new NotImplemented("MailKite Cloud connection")
  }
  async messages(): Promise<MessagePage> {
    throw new NotImplemented("MailKite Cloud connection")
  }
  async rawMessage(): Promise<string> {
    throw new NotImplemented("MailKite Cloud connection")
  }
  async credentials(): Promise<{ apiKeys: string[]; appPasswords: string[] }> {
    throw new NotImplemented("MailKite Cloud connection")
  }
  async createKey(): Promise<string> {
    throw new NotImplemented("MailKite Cloud connection")
  }
  async createAppPassword(): Promise<string> {
    throw new NotImplemented("MailKite Cloud connection")
  }
}
