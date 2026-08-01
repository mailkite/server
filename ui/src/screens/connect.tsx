// Connect — the console's front door. Local: point at a backend-local and prove
// the secret works (one overview call) before entering. Cloud: honest
// coming-soon card that routes to MailKite Cloud today.

import { useState, type FormEvent } from "react"
import { useMutation } from "@tanstack/react-query"
import { ArrowUpRight, Server } from "lucide-react"
import { toast } from "sonner"
import { Logo } from "@/components/logo"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { errMsg } from "@/lib/format"
import { LocalProvider } from "@/providers/local"
import { useConnection } from "@/providers/context"

export function ConnectScreen() {
  const { connect } = useConnection()
  const [baseUrl, setBaseUrl] = useState("")
  const [secret, setSecret] = useState("")

  const test = useMutation({
    mutationFn: async () => {
      const provider = new LocalProvider({ baseUrl, secret })
      return provider.overview()
    },
    onSuccess: (o) => {
      connect({ provider: "local", config: { baseUrl, secret } })
      toast.success(`Connected — ${o.domains} domain${o.domains === 1 ? "" : "s"}, ${o.inbox.total} message${o.inbox.total === 1 ? "" : "s"}`)
    },
    onError: (e) => toast.error(errMsg(e)),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!secret.trim()) return toast.error("Paste the server's admin secret (HMAC_SECRET)")
    test.mutate()
  }

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background px-4">
      <div className="brand-glow pointer-events-none absolute inset-0" aria-hidden />
      <div className="grid-bg pointer-events-none absolute inset-0" aria-hidden />

      <div className="brand-backdrop relative w-full max-w-md">
        <div className="mb-8 flex items-center justify-center gap-3">
          <Logo className="size-8" />
          <div>
            <h1 className="text-xl font-bold tracking-tight">
              MailKite <span className="text-gradient">Server</span>
            </h1>
            <p className="text-xs text-muted-foreground">Your mail server, on a string to your code</p>
          </div>
        </div>

        <Card className="gradient-ring panel-lift">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Server className="size-4 text-primary" /> Connect to your server
            </CardTitle>
            <CardDescription>
              The console talks to backend-local&rsquo;s admin API. Paste the server&rsquo;s{" "}
              <code className="font-mono text-xs">HMAC_SECRET</code> to unlock it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-3">
              <div>
                <label htmlFor="server-url" className="mb-1 block text-xs font-medium text-muted-foreground">
                  Server URL
                </label>
                <Input
                  id="server-url"
                  placeholder="Same origin (leave empty)"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div>
                <label htmlFor="server-secret" className="mb-1 block text-xs font-medium text-muted-foreground">
                  Admin secret
                </label>
                <Input
                  id="server-secret"
                  type="password"
                  placeholder="The HMAC_SECRET backend-local runs with"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <Button type="submit" className="w-full" disabled={test.isPending}>
                {test.isPending ? "Checking…" : "Connect"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="mt-4 border-dashed">
          <CardContent className="flex items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">
                MailKite Cloud <span className="ml-1.5 rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">Console support coming soon</span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Skip the mail server entirely — hosted inbound, deliverability, and webhooks.
              </p>
            </div>
            <a
              href="https://mailkite.dev"
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1 text-sm text-primary hover:underline"
            >
              mailkite.dev <ArrowUpRight className="size-3.5" />
            </a>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
