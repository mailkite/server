// Webhooks & routes — capability-gated. backend-local v1 stores mail for IMAP
// but doesn't dispatch webhooks yet; this screen says so honestly and shows
// where the capability exists today (MailKite Cloud) — the funnel, in-product.

import { useQuery } from "@tanstack/react-query"
import { ArrowUpRight, Webhook } from "lucide-react"
import { PageHeader } from "@/components/page-header"
import { Card, CardContent } from "@/components/ui/card"
import { useProvider } from "@/providers/context"

export function WebhooksScreen() {
  const provider = useProvider()
  const caps = useQuery({ queryKey: ["capabilities"], queryFn: () => provider.capabilities() })

  if (caps.data?.webhooks) {
    // A future driver (or a backend-local that grew dispatch) unlocks the real screen.
    return (
      <div className="space-y-6">
        <PageHeader title="Webhooks & routes" description="Deliver inbound mail to your code." />
        <Card><CardContent className="p-8 text-sm text-muted-foreground">Webhook configuration UI lands with the first backend that reports this capability.</CardContent></Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Webhooks & routes"
        description="Deliver inbound mail to your code the moment it arrives."
      />
      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
          <div className="flex size-12 items-center justify-center rounded-full border border-border bg-rail">
            <Webhook className="size-6 text-muted-foreground" />
          </div>
          <p className="font-medium">Not in the local backend yet</p>
          <p className="max-w-md text-sm text-muted-foreground">
            backend-local stores inbound mail for IMAP today; webhook dispatch is on the roadmap
            (<a href="https://github.com/mailkite/server" target="_blank" rel="noreferrer" className="text-primary hover:underline">follow along</a>).
            MailKite Cloud does this now — receive email as a webhook, with retries, signing, and delivery logs.
          </p>
          <a
            href="https://mailkite.dev"
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            Receive email as a webhook on MailKite Cloud <ArrowUpRight className="size-4" />
          </a>
        </CardContent>
      </Card>
    </div>
  )
}
