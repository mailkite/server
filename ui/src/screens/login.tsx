// /login — lands from the magic-link email (or server log), consumes the
// #token, and enters the console. Errors offer the way back to a fresh link.

import { useEffect, useRef, useState } from "react"
import { AlertTriangle, Loader2 } from "lucide-react"
import { Logo } from "@/components/logo"
import { Button } from "@/components/ui/button"
import { errMsg } from "@/lib/format"
import { tokenFromHash, verifyToken } from "@/providers/auth"
import { useConnection } from "@/providers/context"

export function LoginCallback() {
  const { signedIn } = useConnection()
  const [error, setError] = useState<string | null>(null)
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return // StrictMode double-mount would burn the single-use token
    ran.current = true
    const token = tokenFromHash()
    if (!token) {
      setError("This sign-in URL is missing its token — request a new link.")
      return
    }
    verifyToken(token)
      .then((email) => {
        window.history.replaceState({}, "", "/")
        signedIn(email)
      })
      .catch((e) => setError(errMsg(e)))
  }, [signedIn])

  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="brand-glow pointer-events-none absolute inset-0" aria-hidden />
      <div className="relative flex w-full max-w-sm flex-col items-center gap-4 text-center">
        <Logo className="size-8" />
        {error ? (
          <>
            <div className="flex size-11 items-center justify-center rounded-full border border-border bg-card">
              <AlertTriangle className="size-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">Sign-in link didn&rsquo;t work</p>
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button onClick={() => { window.history.replaceState({}, "", "/"); window.location.reload() }}>
              Request a new link
            </Button>
          </>
        ) : (
          <>
            <Loader2 className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none" />
            <p className="text-sm text-muted-foreground">Signing you in…</p>
          </>
        )}
      </div>
    </div>
  )
}
