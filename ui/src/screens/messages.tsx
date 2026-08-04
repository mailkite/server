// Messages — INBOX / Sent list, a reading view for one message, and compose.
//
// Clicking a row opens the message *in the app* (hash route #/messages/<mailbox>/<uid>)
// rather than a modal: reading is the primary act, so it gets a page and a working back
// button. The modal is demoted to "Original" — full headers and raw source — which is
// the debugging surface, one click away.

import { useEffect, useState } from "react"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, Check, Copy, Inbox, PenSquare, Send } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/page-header"
import { LoadMore } from "@/components/load-more"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { bareAddr, displayName } from "@/lib/addr"
import { bytes, errMsg, shortWhen, when } from "@/lib/format"
import { decodeWords, parseMessage } from "@/lib/mime"
import { useProvider } from "@/providers/context"
import type { Mailbox, MessageRow } from "@/providers/types"
import { cn } from "@/lib/utils"

const PAGE = 50
const MAILBOXES = ["INBOX", "Sent"] as const

// ---- routing -------------------------------------------------------------------
// #/messages                      → list
// #/messages/INBOX/12             → reading view
// The nav key is still the first segment, so app.tsx keeps highlighting "Messages".

type Route = { mailbox: Mailbox; uid: number | null }

function readRoute(): Route {
  const [, mailbox, uid] = window.location.hash.replace(/^#\/?/, "").split("/")
  return {
    mailbox: mailbox === "Sent" ? "Sent" : "INBOX",
    uid: uid && /^\d+$/.test(uid) ? Number(uid) : null,
  }
}

function useRoute(): [Route, (r: Partial<Route>) => void] {
  const [route, setRoute] = useState<Route>(readRoute)
  useEffect(() => {
    const onHash = () => setRoute(readRoute())
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])
  const go = (next: Partial<Route>) => {
    const merged = { ...route, ...next }
    // Assigning the hash pushes history, so Back returns to the list.
    window.location.hash = merged.uid == null ? `/messages/${merged.mailbox}` : `/messages/${merged.mailbox}/${merged.uid}`
  }
  return [route, go]
}

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        } catch {
          toast.error("Couldn't copy — your browser blocked clipboard access")
        }
      }}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {done ? "Copied" : label}
    </Button>
  )
}

// ---- original / details --------------------------------------------------------

function OriginalDialog({ raw, open, onClose }: { raw: string; open: boolean; onClose: () => void }) {
  const parsed = raw ? parseMessage(raw) : null
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Original message</DialogTitle>
          <DialogDescription>The headers and raw source exactly as this server stored them.</DialogDescription>
        </DialogHeader>

        {parsed && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Headers</p>
            <div className="max-h-48 overflow-auto rounded-md border border-border bg-rail">
              <pre className="min-w-max p-3 font-mono text-xs leading-relaxed">{parsed.headerBlock}</pre>
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Raw source</p>
          <div className="max-h-[40vh] overflow-auto rounded-md border border-border bg-rail">
            <pre className="min-w-max p-3 font-mono text-xs leading-relaxed">{raw}</pre>
          </div>
        </div>

        <DialogFooter>
          <CopyButton value={raw} label="Copy source" />
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---- reading view --------------------------------------------------------------

function AddressLine({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null
  return (
    <div className="flex gap-2 text-sm">
      <span className="w-12 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{decodeWords(value)}</span>
    </div>
  )
}

function ReadingView({ mailbox, uid, onBack }: { mailbox: Mailbox; uid: number; onBack: () => void }) {
  const provider = useProvider()
  const [showOriginal, setShowOriginal] = useState(false)

  const raw = useQuery({
    queryKey: ["raw", mailbox, uid],
    queryFn: () => provider.rawMessage(mailbox, uid),
  })

  const parsed = raw.data ? parseMessage(raw.data) : null
  const h = parsed?.headers ?? {}
  const subject = decodeWords(h.subject || "") || "(no subject)"
  const from = h.from || ""

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" /> {mailbox === "INBOX" ? "Inbox" : "Sent"}
        </Button>
        <div className="flex-1" />
        {parsed && <Button variant="outline" size="sm" onClick={() => setShowOriginal(true)}>Original</Button>}
      </div>

      {raw.isLoading ? (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Loading message…</CardContent></Card>
      ) : raw.isError ? (
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-sm text-destructive">{errMsg(raw.error)}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => raw.refetch()}>Try again</Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="space-y-2">
              <h1 className="text-lg font-semibold tracking-tight">{subject}</h1>
              <div className="space-y-0.5">
                <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="font-medium">{displayName(from) || "—"}</span>
                  {bareAddr(from) !== displayName(from) && (
                    <span className="font-mono text-xs text-muted-foreground">{bareAddr(from)}</span>
                  )}
                  <span className="flex-1" />
                  {h.date && <span className="text-xs text-muted-foreground">{h.date}</span>}
                </div>
                <AddressLine label="To" value={h.to} />
                <AddressLine label="Cc" value={h.cc} />
              </div>
            </div>

            <hr className="border-border" />

            {parsed?.text != null ? (
              // Preserve the author's line breaks; never interpret their text as markup.
              <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{parsed.text}</div>
            ) : parsed?.html != null ? (
              // HTML-only: render it isolated. No scripts, no same-origin, no form posts —
              // a stored message is untrusted input, and this console holds a session.
              <iframe
                title="Message body"
                sandbox=""
                referrerPolicy="no-referrer"
                className="h-[55vh] w-full rounded-md border border-border bg-white"
                srcDoc={parsed.html}
              />
            ) : (
              <p className="text-sm text-muted-foreground">This message has no readable text part — open the original to see its source.</p>
            )}
          </CardContent>
        </Card>
      )}

      <OriginalDialog raw={raw.data ?? ""} open={showOriginal} onClose={() => setShowOriginal(false)} />
    </div>
  )
}

// ---- compose -------------------------------------------------------------------

function ComposeDialog({
  open, onClose, onSent, canSendExternally,
}: { open: boolean; onClose: () => void; onSent: () => void; canSendExternally: boolean }) {
  const provider = useProvider()
  const domains = useQuery({ queryKey: ["domains"], queryFn: () => provider.domains() })

  const [local, setLocal] = useState("")
  const [domain, setDomain] = useState("")
  const [to, setTo] = useState("")
  const [cc, setCc] = useState("")
  const [bcc, setBcc] = useState("")
  const [subject, setSubject] = useState("")
  const [text, setText] = useState("")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!domain && domains.data?.length) setDomain(domains.data[0])
  }, [domains.data, domain])

  const send = useMutation({
    mutationFn: () =>
      provider.send({ from: `${local.trim()}@${domain}`, to: to.trim(), cc: cc.trim(), bcc: bcc.trim(), subject, text }),
    onSuccess: (r) => {
      const parts = [
        r.localDelivered ? `delivered to ${r.localDelivered} local mailbox${r.localDelivered > 1 ? "es" : ""}` : "",
        r.relayed ? `relayed to ${r.relayed} external recipient${r.relayed > 1 ? "s" : ""} via ${r.smarthost}` : "",
      ].filter(Boolean)
      toast.success(parts.length ? `Sent — ${parts.join("; ")}` : "Sent")
      setLocal(""); setTo(""); setCc(""); setBcc(""); setSubject(""); setText(""); setError(null)
      onSent()
    },
    onError: (e) => setError(errMsg(e)),
  })

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!domain) return setError("Add a domain before sending — mail can only be sent from a domain this server hosts.")
    if (!local.trim()) return setError("Enter the address this should come from.")
    if (!to.trim()) return setError("Add at least one recipient.")
    send.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New message</DialogTitle>
            <DialogDescription>
              Sent through the same pipeline as the submission edge — stored in Sent, delivered to
              local mailboxes, and handed to the smarthost for everyone else.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 py-4">
            <div className="space-y-1.5">
              <label htmlFor="c-from" className="text-xs font-medium text-muted-foreground">From</label>
              <div className="flex items-center gap-1.5">
                <Input
                  id="c-from"
                  value={local}
                  onChange={(e) => setLocal(e.target.value)}
                  placeholder="you"
                  spellCheck={false}
                  className="flex-1 font-mono text-sm"
                />
                <span aria-hidden className="font-mono text-sm text-muted-foreground">@</span>
                <Select value={domain} onValueChange={setDomain} disabled={!domains.data?.length}>
                  <SelectTrigger aria-label="From domain" className="w-[46%] font-mono text-sm">
                    <SelectValue placeholder={domains.data?.length ? "Pick a domain" : "Add a domain first"} />
                  </SelectTrigger>
                  <SelectContent>
                    {domains.data?.map((d) => <SelectItem key={d} value={d} className="font-mono">{d}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="c-to" className="text-xs font-medium text-muted-foreground">To</label>
              <Input id="c-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="someone@example.com, another@example.com" spellCheck={false} className="font-mono text-sm" />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="c-cc" className="text-xs font-medium text-muted-foreground">Cc <span className="font-normal">(optional)</span></label>
                <Input id="c-cc" value={cc} onChange={(e) => setCc(e.target.value)} spellCheck={false} className="font-mono text-sm" />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="c-bcc" className="text-xs font-medium text-muted-foreground">Bcc <span className="font-normal">(optional)</span></label>
                <Input id="c-bcc" value={bcc} onChange={(e) => setBcc(e.target.value)} spellCheck={false} className="font-mono text-sm" />
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="c-subject" className="text-xs font-medium text-muted-foreground">Subject</label>
              <Input id="c-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="c-body" className="text-xs font-medium text-muted-foreground">Message</label>
              <Textarea id="c-body" value={text} onChange={(e) => setText(e.target.value)} rows={8} />
            </div>

            {!canSendExternally && (
              <p className="text-xs text-muted-foreground">
                This server has no outbound path yet, so only addresses on its own domains can be
                reached. Set <code className="font-mono">SMARTHOST</code> to send beyond them.
              </p>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={send.isPending}>
              <Send className="size-4" /> {send.isPending ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---- screen --------------------------------------------------------------------

export function MessagesScreen() {
  const provider = useProvider()
  const qc = useQueryClient()
  const [route, go] = useRoute()
  const [composing, setComposing] = useState(false)

  const overview = useQuery({ queryKey: ["overview"], queryFn: () => provider.overview() })

  const pages = useInfiniteQuery({
    queryKey: ["messages", route.mailbox],
    queryFn: ({ pageParam }) => provider.messages(route.mailbox, { limit: PAGE, before: pageParam ?? undefined }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore,
    enabled: route.uid == null,
  })

  if (route.uid != null) {
    return <ReadingView mailbox={route.mailbox} uid={route.uid} onBack={() => go({ uid: null })} />
  }

  const rows: MessageRow[] = pages.data?.pages.flatMap((p) => p.messages) ?? []

  return (
    <div className="space-y-6">
      <PageHeader
        title="Messages"
        description="Everything this server has received and sent — the same mail your IMAP clients see."
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg border border-border bg-rail p-1" role="tablist" aria-label="Mailbox">
          {MAILBOXES.map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={route.mailbox === m}
              onClick={() => go({ mailbox: m, uid: null })}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                route.mailbox === m ? "bg-raised font-medium shadow-[inset_0_1px_0_0_var(--hairline)]" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m === "INBOX" ? <Inbox className="size-3.5" /> : <Send className="size-3.5" />}
              {m === "INBOX" ? "Inbox" : "Sent"}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <Button onClick={() => setComposing(true)}>
          <PenSquare className="size-4" /> Compose
        </Button>
      </div>

      {pages.isLoading ? (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Loading messages…</CardContent></Card>
      ) : pages.isError ? (
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-sm text-destructive">{errMsg(pages.error)}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => pages.refetch()}>Try again</Button>
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-10 text-center">
            {route.mailbox === "INBOX" ? <Inbox className="size-8 text-muted-foreground" /> : <Send className="size-8 text-muted-foreground" />}
            <p className="font-medium">{route.mailbox === "INBOX" ? "No mail yet" : "Nothing sent yet"}</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              {route.mailbox === "INBOX"
                ? "Once a domain's MX points here, everything it receives shows up in this list."
                : "Anything you send — from Compose or through the submission edge — lands here, and in IMAP's Sent."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul>
            {rows.map((m, i) => {
              const unseen = !m.flags.split(" ").includes("Seen")
              return (
                <li key={m.uid} className={cn(i > 0 && "border-t border-border")}>
                  <button
                    type="button"
                    onClick={() => go({ uid: m.uid })}
                    className="inbox-row-in flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}
                  >
                    <span
                      className={cn("size-1.5 shrink-0 rounded-full", unseen ? "bg-primary" : "bg-transparent")}
                      aria-label={unseen ? "Unread" : undefined}
                    />
                    <span className={cn("w-44 shrink-0 truncate text-sm", unseen && "font-semibold")}>
                      {displayName(route.mailbox === "INBOX" ? m.from_addr || "" : m.to_addr || "") || "—"}
                    </span>
                    <span className={cn("min-w-0 flex-1 truncate text-sm", unseen ? "text-foreground" : "text-muted-foreground")}>
                      {decodeWords(m.subject || "") || "(no subject)"}
                    </span>
                    <span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:block">{bytes(m.size)}</span>
                    <span className="w-12 shrink-0 text-right text-xs text-muted-foreground" title={when(m.internaldate)}>
                      {shortWhen(m.internaldate)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          <LoadMore
            hasMore={!!pages.hasNextPage}
            loading={pages.isFetchingNextPage}
            onClick={() => pages.fetchNextPage()}
            shown={rows.length}
          />
        </Card>
      )}

      <ComposeDialog
        open={composing}
        onClose={() => setComposing(false)}
        canSendExternally={!!overview.data?.capabilities.outboundInternet}
        onSent={() => {
          setComposing(false)
          qc.invalidateQueries({ queryKey: ["messages"] })
          qc.invalidateQueries({ queryKey: ["overview"] })
          go({ mailbox: "Sent", uid: null })
        }}
      />
    </div>
  )
}
