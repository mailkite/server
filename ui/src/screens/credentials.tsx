// Credentials — API keys (SMTP AUTH / relay) and app passwords (mailbox access over
// IMAP and/or the mailbox API). New secrets are shown once, with copy; after that
// only what they cover is listed. See docs/app-passwords.md.

import { useEffect, useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { KeyRound, Mail, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/page-header"
import { ValueRow } from "@/components/code-block"
import { useConfirm } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { errMsg } from "@/lib/format"
import { useProvider } from "@/providers/context"
import type { AppPassword } from "@/providers/types"

const mask = (k: string) => (k.length > 14 ? `${k.slice(0, 12)}…${k.slice(-4)}` : k)
const ACCESS = [
  { id: "imap", label: "IMAP", hint: "mail clients" },
  { id: "api", label: "API", hint: "agents, scripts" },
] as const
const when = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString() : "never used")

function scopeOf(p: AppPassword) {
  return `${p.address}@${p.domain}`
}

export function CredentialsScreen() {
  const provider = useProvider()
  const qc = useQueryClient()
  const confirm = useConfirm()

  const creds = useQuery({ queryKey: ["credentials"], queryFn: () => provider.credentials() })
  const domains = useQuery({ queryKey: ["domains"], queryFn: () => provider.domains() })
  const passwords = useQuery({ queryKey: ["app-passwords"], queryFn: () => provider.appPasswords() })

  const [newKey, setNewKey] = useState<string | null>(null)
  const [newSecret, setNewSecret] = useState<{ scope: string; secret: string } | null>(null)

  const [domain, setDomain] = useState("")
  const [address, setAddress] = useState("*")
  const [label, setLabel] = useState("")
  const [access, setAccess] = useState<("imap" | "api")[]>(["imap"])

  // Default the dropdown to the first hosted domain once they load.
  useEffect(() => {
    if (!domain && domains.data?.length) setDomain(domains.data[0])
  }, [domains.data, domain])

  const createKey = useMutation({
    mutationFn: () => provider.createKey(),
    onSuccess: (key) => {
      setNewKey(key)
      qc.invalidateQueries({ queryKey: ["credentials"] })
      toast.success("API key created — copy it now, it's shown once")
    },
    onError: (e) => toast.error(errMsg(e)),
  })

  const createPw = useMutation({
    mutationFn: () =>
      provider.createAppPassword({ domain, address: address.trim() || "*", protocols: access, label: label.trim() || null }),
    onSuccess: (created) => {
      setNewSecret({ scope: `${created.address}@${created.domain}`, secret: created.secret })
      setLabel("")
      setAddress("*")
      qc.invalidateQueries({ queryKey: ["app-passwords"] })
      qc.invalidateQueries({ queryKey: ["credentials"] })
      toast.success("App password created — copy it now, it's shown once")
    },
    onError: (e) => toast.error(errMsg(e)),
  })

  const remove = useMutation({
    mutationFn: (id: number) => provider.deleteAppPassword(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app-passwords"] })
      qc.invalidateQueries({ queryKey: ["credentials"] })
      toast.success("App password revoked")
    },
    onError: (e) => toast.error(errMsg(e)),
  })

  const submitPw = (e: FormEvent) => {
    e.preventDefault()
    if (!domain) return toast.error("Add a domain first — an app password always covers one domain")
    if (!access.length) return toast.error("Pick at least one kind of access")
    createPw.mutate()
  }

  const revoke = async (p: AppPassword) => {
    const ok = await confirm({
      title: `Revoke the app password for ${scopeOf(p)}?`,
      description: "Anything signing in with it — a mail client, an agent — stops working immediately.",
      confirmText: "Revoke",
      destructive: true,
    })
    if (ok) remove.mutate(p.id)
  }

  const toggle = (id: "imap" | "api") =>
    setAccess((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))

  return (
    <div className="space-y-6">
      <PageHeader
        title="Credentials"
        description="API keys authenticate SMTP relay sends; app passwords give a mail client, an app, or an agent access to a mailbox."
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><KeyRound className="size-4 text-primary" /> API keys</CardTitle>
          <CardDescription>
            The password for SMTP AUTH on the submission edge (:587/:465), and the Bearer for relay sends.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {newKey && <ValueRow label="New API key — shown once" value={newKey} />}
          {creds.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : creds.isError ? (
            <p className="text-sm text-destructive">{errMsg(creds.error)}</p>
          ) : creds.data!.apiKeys.length === 0 && !newKey ? (
            <p className="text-sm text-muted-foreground">No keys yet — create one to let an app send through this server.</p>
          ) : (
            <ul className="space-y-1.5">
              {creds.data?.apiKeys.map((k) => (
                <li key={k} className="flex items-center gap-2 font-mono text-sm text-muted-foreground">
                  <KeyRound className="size-3.5" /> {mask(k)}
                </li>
              ))}
            </ul>
          )}
          <Button size="sm" onClick={() => createKey.mutate()} disabled={createKey.isPending}>
            <Plus className="size-4" /> {createKey.isPending ? "Creating…" : "Create API key"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Mail className="size-4 text-primary" /> App passwords</CardTitle>
          <CardDescription>
            Give a mail client, an app, or an agent access to one mailbox — or every address on a domain.
            Never hand out your admin secret.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {newSecret && (
            <ValueRow label={`App password for ${newSecret.scope} — shown once`} value={newSecret.secret} />
          )}

          {passwords.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : passwords.isError ? (
            <p className="text-sm text-destructive">{errMsg(passwords.error)}</p>
          ) : passwords.data!.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              None yet — create one below to sign in from Thunderbird, Apple Mail, or an agent.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {passwords.data!.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm">{scopeOf(p)}</p>
                    <p className="text-xs text-muted-foreground">
                      {p.protocols.map((x) => x.toUpperCase()).join(" + ") || "no access"}
                      {p.label ? ` · ${p.label}` : ""} · last used {when(p.last_used_at)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => revoke(p)}
                    disabled={remove.isPending}
                    aria-label={`Revoke the app password for ${scopeOf(p)}`}
                  >
                    <Trash2 className="size-4" /> Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={submitPw} className="grid gap-3 rounded-md border border-border bg-accent/20 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="pw-domain" className="text-xs font-medium text-muted-foreground">Domain</label>
                <Select value={domain} onValueChange={setDomain} disabled={!domains.data?.length}>
                  <SelectTrigger id="pw-domain" className="font-mono text-sm">
                    <SelectValue placeholder={domains.data?.length ? "Pick a domain" : "Add a domain first"} />
                  </SelectTrigger>
                  <SelectContent>
                    {domains.data?.map((d) => (
                      <SelectItem key={d} value={d} className="font-mono">{d}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="pw-address" className="text-xs font-medium text-muted-foreground">Address</label>
                <Input
                  id="pw-address"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  spellCheck={false}
                  className="font-mono text-sm"
                  placeholder="*"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              <code className="font-mono">*</code> covers every address on the domain;{" "}
              <code className="font-mono">hello</code> just that one;{" "}
              <code className="font-mono">support-*</code> and <code className="font-mono">*-agent</code> match a family.
            </p>

            <div className="grid gap-3 sm:grid-cols-2">
              <fieldset className="space-y-1.5">
                <legend className="text-xs font-medium text-muted-foreground">Access</legend>
                <div className="flex gap-4">
                  {ACCESS.map((a) => (
                    <label key={a.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={access.includes(a.id)}
                        onChange={() => toggle(a.id)}
                        className="size-4 accent-primary"
                      />
                      {a.label}
                      <span className="text-xs text-muted-foreground">({a.hint})</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="space-y-1.5">
                <label htmlFor="pw-label" className="text-xs font-medium text-muted-foreground">Label (optional)</label>
                <Input
                  id="pw-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="text-sm"
                  placeholder="support inbox agent"
                />
              </div>
            </div>

            <div>
              <Button type="submit" size="sm" disabled={createPw.isPending || !domain || !access.length}>
                <Plus className="size-4" /> {createPw.isPending ? "Creating…" : "Create app password"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
