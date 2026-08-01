// Messages — INBOX / Sent, newest first, cursor pagination, raw view on click.

import { useState } from "react"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { Inbox, Send } from "lucide-react"
import { PageHeader } from "@/components/page-header"
import { LoadMore } from "@/components/load-more"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { displayName } from "@/lib/addr"
import { bytes, errMsg, shortWhen, when } from "@/lib/format"
import { useProvider } from "@/providers/context"
import type { Mailbox, MessageRow } from "@/providers/types"
import { cn } from "@/lib/utils"

const PAGE = 50

function RawDialog({ mailbox, message, onClose }: { mailbox: Mailbox; message: MessageRow | null; onClose: () => void }) {
  const provider = useProvider()
  const raw = useQuery({
    queryKey: ["raw", mailbox, message?.uid],
    queryFn: () => provider.rawMessage(mailbox, message!.uid),
    enabled: !!message,
  })
  return (
    <Dialog open={!!message} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">{message?.subject || "(no subject)"}</DialogTitle>
          <DialogDescription>
            {message && (
              <>
                {message.from_addr} → {message.to_addr} · {when(message.internaldate)} · {bytes(message.size)}
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto rounded-md border border-border bg-rail">
          {raw.isLoading ? (
            <p className="p-4 text-sm text-muted-foreground">Loading raw message…</p>
          ) : raw.isError ? (
            <p className="p-4 text-sm text-destructive">{errMsg(raw.error)}</p>
          ) : (
            <pre className="whitespace-pre-wrap break-all p-4 font-mono text-xs leading-relaxed">{raw.data}</pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function MessagesScreen() {
  const provider = useProvider()
  const [mailbox, setMailbox] = useState<Mailbox>("INBOX")
  const [selected, setSelected] = useState<MessageRow | null>(null)

  const pages = useInfiniteQuery({
    queryKey: ["messages", mailbox],
    queryFn: ({ pageParam }) => provider.messages(mailbox, { limit: PAGE, before: pageParam ?? undefined }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore,
  })

  const rows = pages.data?.pages.flatMap((p) => p.messages) ?? []

  return (
    <div className="space-y-6">
      <PageHeader
        title="Messages"
        description="Everything this server has received and sent — the same mail your IMAP clients see."
      />

      <div className="flex gap-1 rounded-lg border border-border bg-rail p-1" role="tablist" aria-label="Mailbox">
        {(["INBOX", "Sent"] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mailbox === m}
            onClick={() => setMailbox(m)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              mailbox === m ? "bg-raised font-medium shadow-[inset_0_1px_0_0_var(--hairline)]" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {m === "INBOX" ? <Inbox className="size-3.5" /> : <Send className="size-3.5" />}
            {m === "INBOX" ? "Inbox" : "Sent"}
          </button>
        ))}
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
            {mailbox === "INBOX" ? <Inbox className="size-8 text-muted-foreground" /> : <Send className="size-8 text-muted-foreground" />}
            <p className="font-medium">{mailbox === "INBOX" ? "No mail yet" : "Nothing sent yet"}</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              {mailbox === "INBOX"
                ? "Once a domain's MX points here, everything it receives shows up in this list."
                : "Messages relayed through the submission edge land here, and in IMAP's Sent."}
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
                    onClick={() => setSelected(m)}
                    className="inbox-row-in flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}
                  >
                    <span
                      className={cn("size-1.5 shrink-0 rounded-full", unseen ? "bg-primary" : "bg-transparent")}
                      aria-label={unseen ? "Unread" : undefined}
                    />
                    <span className={cn("w-44 shrink-0 truncate text-sm", unseen && "font-semibold")}>
                      {displayName(mailbox === "INBOX" ? m.from_addr || "" : m.to_addr || "") || "—"}
                    </span>
                    <span className={cn("min-w-0 flex-1 truncate text-sm", unseen ? "text-foreground" : "text-muted-foreground")}>
                      {m.subject || "(no subject)"}
                    </span>
                    <span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:block">{bytes(m.size)}</span>
                    <span className="w-12 shrink-0 text-right text-xs text-muted-foreground">{shortWhen(m.internaldate)}</span>
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

      <RawDialog mailbox={mailbox} message={selected} onClose={() => setSelected(null)} />
    </div>
  )
}
