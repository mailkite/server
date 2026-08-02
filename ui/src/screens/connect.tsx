// Sign in — the web console's front door. Default: email → magic link (no secrets
// to paste or store). Advanced: the old admin-secret path for scripted or
// loopback setups. Cloud: honest coming-soon card that routes to MailKite Cloud.

import { useState, type FormEvent } from "react"
import { useMutation } from "@tanstack/react-query"
import { ArrowUpRight, ChevronDown, MailCheck, Send } from "lucide-react"
import { toast } from "sonner"
import { Logo } from "@/components/logo"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { errMsg } from "@/lib/format"
import { requestLink } from "@/providers/auth"
import { LocalProvider } from "@/providers/local"
import { useConnection } from "@/providers/context"
import { cn } from "@/lib/utils"

function MagicLinkForm() {
  const [email, setEmail] = useState("")
  const [sentTo, setSentTo] = useState<string | null>(null)

  const send = useMutation({
    mutationFn: () => requestLink(email.trim()),
    onSuccess: () => setSentTo(email.trim()),
    onError: (e) => toast.error(errMsg(e)),
  })

  if (sentTo) {
    return (
      <div className="space-y-3 text-center">
        <div className="mx-auto flex size-11 items-center justify-center rounded-full border border-border bg-secondary">
          <MailCheck className="size-5 text-primary" />
        </div>
        <p className="text-sm font-medium">Check your email</p>
        <p className="text-sm text-muted-foreground">
          If <span className="font-mono text-xs">{sentTo}</span> is an admin here, a sign-in link is on
          its way. It works once and expires in 15 minutes.
        </p>
        <p className="text-xs text-muted-foreground">
          Server not sending email yet? The link is printed in its log:{" "}
          <code className="font-mono">journalctl -u mailkite-backend | grep magic-link</code>
        </p>
        <Button variant="ghost" size="sm" onClick={() => setSentTo(null)}>
          Use a different email
        </Button>
      </div>
    )
  }

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault()
        if (email.trim()) send.mutate()
      }}
      className="space-y-3"
    >
      <div>
        <label htmlFor="signin-email" className="mb-1 block text-xs font-medium text-muted-foreground">
          Admin email
        </label>
        <Input
          id="signin-email"
          type="email"
          placeholder="you@yourdomain.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          autoFocus
        />
      </div>
      <Button type="submit" className="w-full" disabled={send.isPending || !email.trim()}>
        <Send className="size-4" /> {send.isPending ? "Sending…" : "Email me a sign-in link"}
      </Button>
    </form>
  )
}

function AdvancedSecretForm() {
  const { connectWithSecret } = useConnection()
  const [open, setOpen] = useState(false)
  const [baseUrl, setBaseUrl] = useState("")
  const [secret, setSecret] = useState("")

  const test = useMutation({
    mutationFn: async () => new LocalProvider({ baseUrl, secret }).overview(),
    onSuccess: (o) => {
      connectWithSecret({ baseUrl, secret })
      toast.success(`Connected — ${o.domains} domain${o.domains === 1 ? "" : "s"}, ${o.inbox.total} message${o.inbox.total === 1 ? "" : "s"}`)
    },
    onError: (e) => toast.error(errMsg(e)),
  })

  return (
    <div className="border-t border-border pt-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Advanced: connect with the admin secret
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault()
            if (!secret.trim()) return toast.error("Paste the server's admin secret (HMAC_SECRET)")
            test.mutate()
          }}
          className="mt-3 space-y-3"
        >
          <Input
            aria-label="Server URL"
            placeholder="Server URL — same origin if empty"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <Input
            aria-label="Admin secret"
            type="password"
            placeholder="The HMAC_SECRET api-local runs with"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="off"
          />
          <Button type="submit" variant="secondary" className="w-full" disabled={test.isPending}>
            {test.isPending ? "Checking…" : "Connect with secret"}
          </Button>
        </form>
      )}
    </div>
  )
}

export function SignInScreen() {
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
            <CardTitle>Sign in</CardTitle>
            <CardDescription>Enter your admin email and we&rsquo;ll send a one-time sign-in link.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <MagicLinkForm />
            <AdvancedSecretForm />
          </CardContent>
        </Card>

        <Card className="mt-4 border-dashed">
          <CardContent className="flex items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">
                MailKite Cloud <span className="ml-1.5 rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">web console support coming soon</span>
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
