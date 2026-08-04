// Finish sign-in setup (docs/auth-setup.md). Claiming the install grants exactly one
// session; before the console is useful for anything else the admin chooses how future
// sign-ins are verified — and the choice only sticks once the server has proven it
// works: a code that came back, or a completed OAuth round trip.

import { useState, type FormEvent } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { KeyRound, Mail, Server, ShieldCheck } from "lucide-react"
import { toast } from "sonner"
import { Logo } from "@/components/logo"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { errMsg } from "@/lib/format"
import { setupState, startEmailSetup, startOauthSetup, verifyEmailSetup, type SmtpFields } from "@/providers/auth"

type Choice = "cloud" | "smtp" | "oauth"

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background px-4 py-10">
      <div className="brand-glow pointer-events-none absolute inset-0" aria-hidden />
      <div className="grid-bg pointer-events-none absolute inset-0" aria-hidden />
      <div className="brand-backdrop relative w-full max-w-lg">
        <div className="mb-8 flex items-center justify-center gap-3">
          <Logo className="size-8" />
          <h1 className="text-xl font-bold tracking-tight">
            MailKite <span className="text-gradient">Server</span>
          </h1>
        </div>
        {children}
      </div>
    </div>
  )
}

function Tab({ active, onClick, icon: Icon, children }: {
  active: boolean; onClick: () => void; icon: typeof Mail; children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex flex-1 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "border-primary/60 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-4" /> {children}
    </button>
  )
}

export function AuthSetupScreen({ onDone }: { onDone: () => void }) {
  const state = useQuery({ queryKey: ["setup-state"], queryFn: setupState, staleTime: 0 })
  const [choice, setChoice] = useState<Choice>("cloud")
  const [key, setKey] = useState("")
  const [from, setFrom] = useState("")
  const [smtp, setSmtp] = useState<SmtpFields>({ host: "", port: "587", user: "", pass: "", from: "" })
  const [provider, setProvider] = useState<"google" | "github">("google")
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [allowed, setAllowed] = useState("")
  const [code, setCode] = useState("")
  const [sentTo, setSentTo] = useState<string | null>(null)

  const send = useMutation({
    mutationFn: () => (choice === "cloud"
      ? startEmailSetup({ mode: "cloud", key: key.trim(), from: from.trim() })
      : startEmailSetup({ mode: "smtp", smtp })),
    onSuccess: (r) => {
      setSentTo(r.to)
      toast.success(`Code sent to ${r.to}`)
    },
    onError: (e) => toast.error(errMsg(e)),
  })

  const verify = useMutation({
    mutationFn: () => verifyEmailSetup(code.trim()),
    onSuccess: () => {
      toast.success("Sign-in is set up — future sign-ins use an emailed link")
      onDone()
    },
    onError: (e) => toast.error(errMsg(e)),
  })

  const oauth = useMutation({
    mutationFn: () => startOauthSetup({
      provider,
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      allowedEmails: allowed.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
    }),
    onSuccess: (r) => { window.location.href = r.authorizeUrl },
    onError: (e) => toast.error(errMsg(e)),
  })

  // An install configured by environment variables has nothing to choose here.
  if (state.data?.source === "env") {
    return (
      <Shell>
        <Card className="gradient-ring panel-lift">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4 text-primary" /> Sign-in is set by this server</CardTitle>
            <CardDescription>
              Environment variables configure how sign-in works on this install, so there&rsquo;s nothing to
              choose. Change them on the server to change the method.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" onClick={onDone}>Continue to the console</Button>
          </CardContent>
        </Card>
      </Shell>
    )
  }

  if (sentTo) {
    return (
      <Shell>
        <Card className="gradient-ring panel-lift">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Mail className="size-4 text-primary" /> Enter the code we sent</CardTitle>
            <CardDescription>
              A six-digit code is on its way to <span className="font-mono text-xs">{sentTo}</span>. Entering it
              proves this server can reach you — only then does it become your sign-in method.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(e: FormEvent) => { e.preventDefault(); if (code.trim()) verify.mutate() }}
              className="space-y-3"
            >
              <Input
                aria-label="Verification code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                className="text-center font-mono text-lg tracking-[0.3em]"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                autoFocus
              />
              <Button type="submit" className="w-full" disabled={verify.isPending || code.trim().length < 6}>
                {verify.isPending ? "Checking…" : "Finish setup"}
              </Button>
              <Button type="button" variant="ghost" size="sm" className="w-full" onClick={() => { setSentTo(null); setCode("") }}>
                Use a different method
              </Button>
            </form>
          </CardContent>
        </Card>
      </Shell>
    )
  }

  return (
    <Shell>
      <Card className="gradient-ring panel-lift">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4 text-primary" /> Finish sign-in setup</CardTitle>
          <CardDescription>
            Choose how you&rsquo;ll
            sign in from now on — the server proves the method works before saving it. Until you finish, you can still sign in with your admin email.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Tab active={choice === "cloud"} onClick={() => setChoice("cloud")} icon={Mail}>Cloud</Tab>
            <Tab active={choice === "smtp"} onClick={() => setChoice("smtp")} icon={Server}>SMTP</Tab>
            <Tab active={choice === "oauth"} onClick={() => setChoice("oauth")} icon={KeyRound}>OAuth</Tab>
          </div>

          {choice === "cloud" && (
            <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (key.trim()) send.mutate() }} className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Send sign-in links through MailKite Cloud with an API key. This also gives the server a
                working outbound path.
              </p>
              <Input aria-label="MailKite Cloud API key" type="password" placeholder="mk_live_…" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
              <Input aria-label="From address" placeholder="From address — no-reply@yourdomain.com" value={from} onChange={(e) => setFrom(e.target.value)} autoComplete="off" spellCheck={false} />
              <Button type="submit" className="w-full" disabled={send.isPending || !key.trim()}>
                {send.isPending ? "Sending a test email…" : "Send verification code"}
              </Button>
            </form>
          )}

          {choice === "smtp" && (
            <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (smtp.host.trim() && smtp.from.trim()) send.mutate() }} className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Any SMTP server you already have — your provider&rsquo;s relay, or another mail host.
              </p>
              <div className="flex gap-2">
                <Input aria-label="SMTP host" placeholder="smtp.yourprovider.com" value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} spellCheck={false} className="flex-1" />
                <Input aria-label="Port" placeholder="587" value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: e.target.value })} className="w-24" />
              </div>
              <Input aria-label="SMTP username" placeholder="Username" value={smtp.user} onChange={(e) => setSmtp({ ...smtp, user: e.target.value })} autoComplete="off" spellCheck={false} />
              <Input aria-label="SMTP password" type="password" placeholder="Password" value={smtp.pass} onChange={(e) => setSmtp({ ...smtp, pass: e.target.value })} autoComplete="off" />
              <Input aria-label="From address" placeholder="From address — no-reply@yourdomain.com" value={smtp.from} onChange={(e) => setSmtp({ ...smtp, from: e.target.value })} spellCheck={false} />
              <Button type="submit" className="w-full" disabled={send.isPending || !smtp.host.trim() || !smtp.from.trim()}>
                {send.isPending ? "Sending a test email…" : "Send verification code"}
              </Button>
            </form>
          )}

          {choice === "oauth" && (
            <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (clientId.trim() && clientSecret.trim()) oauth.mutate() }} className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Sign in with Google or GitHub. You&rsquo;ll complete one round trip now — that&rsquo;s what proves it
                works. Redirect URI: <code className="font-mono">{window.location.origin}/api/auth/oauth/callback</code>
              </p>
              <div className="flex gap-2">
                <Tab active={provider === "google"} onClick={() => setProvider("google")} icon={KeyRound}>Google</Tab>
                <Tab active={provider === "github"} onClick={() => setProvider("github")} icon={KeyRound}>GitHub</Tab>
              </div>
              <Input aria-label="Client ID" placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} />
              <Input aria-label="Client secret" type="password" placeholder="Client secret" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" />
              <Input aria-label="Allowed emails" placeholder="Who may sign in — comma separated" value={allowed} onChange={(e) => setAllowed(e.target.value)} autoComplete="off" spellCheck={false} />
              <p className="text-xs text-muted-foreground">
                Your own address is always allowed, so finishing setup can&rsquo;t lock you out.
              </p>
              <Button type="submit" className="w-full" disabled={oauth.isPending || !clientId.trim() || !clientSecret.trim()}>
                {oauth.isPending ? "Redirecting…" : `Continue with ${provider === "google" ? "Google" : "GitHub"}`}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
      <p className="mt-4 text-center text-xs text-muted-foreground">
        Locked out later? <code className="font-mono">node cli.mjs reset-auth</code> on the server re-opens this step.
      </p>
    </Shell>
  )
}
