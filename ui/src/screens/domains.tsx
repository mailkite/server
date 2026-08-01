// Domains — list + add, with per-domain DNS records ready to copy. The records
// derive from a per-domain mail host (default mail.<domain>) the user can edit
// to match their VPS hostname.

import { useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, Globe, Plus } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/page-header"
import { ValueRow } from "@/components/code-block"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { errMsg } from "@/lib/format"
import { useProvider } from "@/providers/context"
import { cn } from "@/lib/utils"

function DnsRecords({ domain }: { domain: string }) {
  const [mailHost, setMailHost] = useState(`mail.${domain}`)
  return (
    <div className="space-y-2 border-t border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`host-${domain}`} className="text-xs font-medium text-muted-foreground">
          Mail host (this server&rsquo;s DNS name)
        </label>
        <Input
          id={`host-${domain}`}
          className="h-8 w-64 font-mono text-xs"
          value={mailHost}
          onChange={(e) => setMailHost(e.target.value)}
          spellCheck={false}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Add these records at your DNS provider, then point the edges&rsquo; <code className="font-mono">config/me</code> at{" "}
        <code className="font-mono">{mailHost}</code>. Set PTR (reverse DNS) on the server IP too — outbound
        deliverability suffers without it.
      </p>
      <div className="grid gap-2">
        <ValueRow label={`MX — ${domain}`} value={`10 ${mailHost}`} />
        <ValueRow label={`TXT (SPF) — ${domain}`} value={`v=spf1 a:${mailHost} -all`} />
        <ValueRow label={`TXT (DMARC) — _dmarc.${domain}`} value={`v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`} />
        <ValueRow label="IMAP host (clients + agents)" value={mailHost} />
        <ValueRow label="SMTP submission host" value={`${mailHost}:587`} />
      </div>
    </div>
  )
}

export function DomainsScreen() {
  const provider = useProvider()
  const qc = useQueryClient()
  const [draft, setDraft] = useState("")
  const [open, setOpen] = useState<string | null>(null)

  const domains = useQuery({ queryKey: ["domains"], queryFn: () => provider.domains() })
  const add = useMutation({
    mutationFn: (domain: string) => provider.addDomain(domain),
    onSuccess: (_, domain) => {
      setDraft("")
      setOpen(domain.toLowerCase())
      qc.invalidateQueries({ queryKey: ["domains"] })
      toast.success(`${domain.toLowerCase()} added — set its DNS records next`)
    },
    onError: (e) => toast.error(errMsg(e)),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const d = draft.trim().toLowerCase()
    if (!d) return
    add.mutate(d)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Domains"
        description="Every domain this server receives mail for. Add one, set its DNS, and mail lands here."
      />

      <form onSubmit={submit} className="flex gap-2">
        <Input
          placeholder="yourdomain.com"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Domain to add"
          spellCheck={false}
          className="max-w-sm font-mono text-sm"
        />
        <Button type="submit" disabled={add.isPending || !draft.trim()}>
          <Plus className="size-4" /> {add.isPending ? "Adding…" : "Add domain"}
        </Button>
      </form>

      {domains.isLoading ? (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Loading domains…</CardContent></Card>
      ) : domains.isError ? (
        <Card><CardContent className="p-8 text-center text-sm text-destructive">{errMsg(domains.error)}</CardContent></Card>
      ) : domains.data!.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-10 text-center">
            <Globe className="size-8 text-muted-foreground" />
            <p className="font-medium">No domains yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Add the first domain this server should receive mail for — you&rsquo;ll get its DNS records to copy.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {domains.data!.map((d) => (
            <Card key={d} className="overflow-hidden">
              <button
                type="button"
                onClick={() => setOpen(open === d ? null : d)}
                aria-expanded={open === d}
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex items-center gap-2.5 font-mono text-sm">
                  <Globe className="size-4 text-primary" /> {d}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  DNS records
                  <ChevronDown className={cn("size-4 transition-transform", open === d && "rotate-180")} />
                </span>
              </button>
              {open === d && <DnsRecords domain={d} />}
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
