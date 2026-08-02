// Webhooks — one delivery target per domain, plus recent delivery attempts.
// api-local signs every payload and retries with backoff; this screen is where you
// set the URL, copy the signing secret, and see what happened.

import { useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertCircle, ArrowUpRight, CheckCircle2, Clock, Webhook } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/page-header"
import { ValueRow } from "@/components/code-block"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { errMsg } from "@/lib/format"
import { useProvider } from "@/providers/context"
import type { Delivery } from "@/providers/types"

const STATUS_ICON = {
  delivered: <CheckCircle2 className="size-4 text-emerald-400" aria-hidden />,
  pending: <Clock className="size-4 text-amber-400" aria-hidden />,
  failed: <AlertCircle className="size-4 text-destructive" aria-hidden />,
}

function DomainWebhook({ domain }: { domain: string }) {
  const provider = useProvider()
  const qc = useQueryClient()
  const hook = useQuery({ queryKey: ["webhook", domain], queryFn: () => provider.webhook(domain) })
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? hook.data?.url ?? ""

  const save = useMutation({
    mutationFn: (url: string) => provider.setWebhook(domain, url),
    onSuccess: (saved) => {
      setDraft(null)
      qc.invalidateQueries({ queryKey: ["webhook", domain] })
      qc.invalidateQueries({ queryKey: ["webhook-status"] })
      toast.success(saved.url ? `Webhook saved for ${domain}` : `Webhook removed for ${domain}`)
    },
    onError: (e) => toast.error(errMsg(e)),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate(value.trim())
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <form onSubmit={submit} className="space-y-2">
          <label htmlFor={`hook-${domain}`} className="font-mono text-sm">
            {domain}
          </label>
          <div className="flex flex-wrap gap-2">
            <Input
              id={`hook-${domain}`}
              type="url"
              inputMode="url"
              placeholder="https://your-app.example/inbound"
              value={value}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="min-w-0 flex-1 font-mono text-xs"
            />
            <Button type="submit" disabled={save.isPending || value.trim() === (hook.data?.url ?? "")}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {hook.data?.url
              ? "Every inbound message for this domain is POSTed here. Clear the field and save to stop."
              : "Add a URL to receive inbound mail as JSON. Leave empty to keep mail readable over IMAP only."}
          </p>
        </form>

        {hook.data?.secret && (
          <ValueRow label="Signing secret (verify x-mailkite-signature)" value={hook.data.secret} />
        )}
      </CardContent>
    </Card>
  )
}

function Deliveries({ rows }: { rows: Delivery[] }) {
  if (!rows.length) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-muted-foreground">
          No deliveries yet — they appear here the moment mail arrives for a domain with a webhook.
        </CardContent>
      </Card>
    )
  }
  return (
    <Card>
      <CardContent className="p-0">
        <ul className="divide-y divide-border">
          {rows.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
              {STATUS_ICON[d.status]}
              <span className="font-mono text-xs">{d.domain}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{d.url}</span>
              <span className="text-xs text-muted-foreground">
                {d.attempts} {d.attempts === 1 ? "attempt" : "attempts"}
              </span>
              {d.last_error && (
                <span className="w-full truncate text-xs text-destructive sm:w-auto">{d.last_error}</span>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

export function WebhooksScreen() {
  const provider = useProvider()
  const caps = useQuery({ queryKey: ["capabilities"], queryFn: () => provider.capabilities() })
  const domains = useQuery({ queryKey: ["domains"], queryFn: () => provider.domains() })
  const status = useQuery({
    queryKey: ["webhook-status"],
    queryFn: () => provider.webhookStatus(),
    refetchInterval: 10_000,
    enabled: caps.data?.webhooks === true,
  })

  if (caps.isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Webhooks" description="Deliver inbound mail to your code." />
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Loading…</CardContent></Card>
      </div>
    )
  }

  // A provider whose backend can't dispatch says so, and points at one that can.
  if (!caps.data?.webhooks) {
    return (
      <div className="space-y-6">
        <PageHeader title="Webhooks" description="Deliver inbound mail to your code the moment it arrives." />
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <div className="flex size-12 items-center justify-center rounded-full border border-border bg-rail">
              <Webhook className="size-6 text-muted-foreground" aria-hidden />
            </div>
            <p className="font-medium">Not available on this backend</p>
            <p className="max-w-md text-sm text-muted-foreground">
              This backend stores inbound mail for IMAP but doesn&rsquo;t dispatch webhooks.
              MailKite Cloud does — with retries, signing, and delivery logs.
            </p>
            <a
              href="https://mailkite.dev"
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
            >
              Receive email as a webhook on MailKite Cloud <ArrowUpRight className="size-4" aria-hidden />
            </a>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Webhooks"
        description="Deliver inbound mail to your code the moment it arrives. Payloads are signed and retried."
      />

      {domains.isLoading ? (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Loading domains…</CardContent></Card>
      ) : domains.isError ? (
        <Card><CardContent className="p-8 text-center text-sm text-destructive">{errMsg(domains.error)}</CardContent></Card>
      ) : !domains.data?.length ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-10 text-center">
            <Webhook className="size-8 text-muted-foreground" aria-hidden />
            <p className="font-medium">No domains yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Add a domain first — each one gets its own webhook target.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {domains.data.map((d) => (
            <DomainWebhook key={d} domain={d} />
          ))}
        </div>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-sm font-medium">Recent deliveries</h2>
          {status.data && (
            <p className="text-xs text-muted-foreground">
              {status.data.counts.delivered} delivered · {status.data.counts.pending} pending ·{" "}
              {status.data.counts.failed} failed
            </p>
          )}
        </div>
        {status.isError ? (
          <Card><CardContent className="p-8 text-center text-sm text-destructive">{errMsg(status.error)}</CardContent></Card>
        ) : (
          <Deliveries rows={status.data?.recent ?? []} />
        )}
      </section>
    </div>
  )
}
