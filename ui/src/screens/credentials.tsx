// Credentials — API keys (SMTP AUTH / relay) and IMAP app-passwords. New
// secrets are shown once, with copy; after that only their existence is listed.

import { useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { KeyRound, Mail, Plus } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/page-header"
import { ValueRow } from "@/components/code-block"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { errMsg } from "@/lib/format"
import { useProvider } from "@/providers/context"

const mask = (k: string) => (k.length > 14 ? `${k.slice(0, 12)}…${k.slice(-4)}` : k)

export function CredentialsScreen() {
  const provider = useProvider()
  const qc = useQueryClient()
  const creds = useQuery({ queryKey: ["credentials"], queryFn: () => provider.credentials() })

  const [newKey, setNewKey] = useState<string | null>(null)
  const [newPw, setNewPw] = useState<{ username: string; password: string } | null>(null)
  const [pwUser, setPwUser] = useState("")

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
    mutationFn: (username: string) => provider.createAppPassword(username),
    onSuccess: (password, username) => {
      setNewPw({ username, password })
      setPwUser("")
      qc.invalidateQueries({ queryKey: ["credentials"] })
      toast.success("App password created — copy it now, it's shown once")
    },
    onError: (e) => toast.error(errMsg(e)),
  })

  const submitPw = (e: FormEvent) => {
    e.preventDefault()
    const u = pwUser.trim().toLowerCase()
    if (!u.includes("@")) return toast.error("Use a full mailbox address, like you@yourdomain.com")
    createPw.mutate(u)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Credentials"
        description="API keys authenticate SMTP relay sends; app-passwords give a mail client or agent IMAP access."
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
          <CardTitle className="flex items-center gap-2"><Mail className="size-4 text-primary" /> IMAP app-passwords</CardTitle>
          <CardDescription>
            One per mailbox address. Use it as the password in Thunderbird, Apple Mail, or an agent&rsquo;s IMAP library —
            never your admin secret.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {newPw && <ValueRow label={`App password for ${newPw.username} — shown once`} value={newPw.password} />}
          {creds.data && creds.data.appPasswords.length > 0 && (
            <ul className="space-y-1.5">
              {creds.data.appPasswords.map((u) => (
                <li key={u} className="flex items-center gap-2 font-mono text-sm text-muted-foreground">
                  <Mail className="size-3.5" /> {u}
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={submitPw} className="flex gap-2">
            <Input
              placeholder="you@yourdomain.com"
              value={pwUser}
              onChange={(e) => setPwUser(e.target.value)}
              aria-label="Mailbox address for the app password"
              spellCheck={false}
              className="max-w-sm font-mono text-sm"
            />
            <Button type="submit" size="sm" className="h-9" disabled={createPw.isPending || !pwUser.trim()}>
              <Plus className="size-4" /> {createPw.isPending ? "Creating…" : "Create app password"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
