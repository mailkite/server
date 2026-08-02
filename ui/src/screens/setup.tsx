// /setup — first-boot claim. The server printed a one-time URL to its log;
// whoever holds it names the first admin email and is signed straight in.

import { useState, type FormEvent } from "react"
import { useMutation } from "@tanstack/react-query"
import { ShieldCheck } from "lucide-react"
import { toast } from "sonner"
import { Logo } from "@/components/logo"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { errMsg } from "@/lib/format"
import { completeSetup, tokenFromHash } from "@/providers/auth"
import { useConnection } from "@/providers/context"

export function SetupScreen() {
  const { signedIn } = useConnection()
  const [email, setEmail] = useState("")
  const token = tokenFromHash()

  const claim = useMutation({
    mutationFn: () => completeSetup(token!, email.trim()),
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
              <ShieldCheck className="size-4 text-primary" /> Claim this server
            </CardTitle>
            <CardDescription>
              {token
                ? "You followed the one-time setup link from the server log. Enter the email that should own this web console — future sign-ins send a magic link there."
                : "This setup URL is missing its token. Copy the full link from the server log (it starts with /setup#token=…)."}
            </CardDescription>
          </CardHeader>
          {token && (
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
                  {claim.isPending ? "Claiming…" : "Make me the admin"}
                </Button>
              </form>
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  )
}
