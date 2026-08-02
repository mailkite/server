// First-run claim (WordPress-style): while the install has no admin and no
// ADMIN_EMAIL, the first email entered here becomes the admin and is signed
// straight in. Recovery from a squatted claim: `cli.mjs reset-admin <email>`.

import { useState, type FormEvent } from "react"
import { useMutation } from "@tanstack/react-query"
import { ShieldCheck } from "lucide-react"
import { toast } from "sonner"
import { Logo } from "@/components/logo"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { errMsg } from "@/lib/format"
import { completeSetup } from "@/providers/auth"
import { useConnection } from "@/providers/context"

export function SetupScreen() {
  const { signedIn } = useConnection()
  const [email, setEmail] = useState("")

  const claim = useMutation({
    mutationFn: () => completeSetup(email.trim()),
    onSuccess: (confirmed) => {
      window.history.replaceState({}, "", "/")
      signedIn(confirmed)
      toast.success("You're the admin — welcome to your mail server")
    },
    onError: (e) => toast.error(errMsg(e)),
  })

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background px-4">
      <div className="brand-glow pointer-events-none absolute inset-0" aria-hidden />
      <div className="grid-bg pointer-events-none absolute inset-0" aria-hidden />

      <div className="brand-backdrop relative w-full max-w-md">
        <div className="mb-8 flex items-center justify-center gap-3">
          <Logo className="size-8" />
          <h1 className="text-xl font-bold tracking-tight">
            MailKite <span className="text-gradient">Server</span>
          </h1>
        </div>

        <Card className="gradient-ring panel-lift">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-primary" /> Create your admin account
            </CardTitle>
            <CardDescription>
              This install has no admin yet — the first email entered becomes it. Future
              sign-ins send a magic link to that address.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(e: FormEvent) => {
                e.preventDefault()
                if (email.trim()) claim.mutate()
              }}
              className="space-y-3"
            >
              <div>
                <label htmlFor="setup-email" className="mb-1 block text-xs font-medium text-muted-foreground">
                  Admin email
                </label>
                <Input
                  id="setup-email"
                  type="email"
                  placeholder="you@yourdomain.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  autoFocus
                />
              </div>
              <Button type="submit" className="w-full" disabled={claim.isPending || !email.trim()}>
                {claim.isPending ? "Creating…" : "Create admin account"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
