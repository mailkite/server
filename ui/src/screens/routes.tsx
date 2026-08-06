// Routes — address-level rules for inbound mail (docs/routes.md). Each one matches a
// pattern on one domain and does one thing: POST to a webhook, forward to an address, or
// hand the message to an AI agent using a key you supply.
//
// The AI key is write-only by design: it goes in here and is never readable back, so this
// screen shows "configured" and offers to replace it, never to reveal it.

import { useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot, Forward, Split, Trash2, Webhook } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/page-header"
import { ValueRow } from "@/components/code-block"
import { useConfirm } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { errMsg } from "@/lib/format"
import { useProvider } from "@/providers/context"
import type { AiProvider, NewRoute, Route, RouteAction } from "@/providers/types"

const ACTION_META: Record<RouteAction, { label: string; icon: typeof Split; blurb: string }> = {
  webhook: { label: "Webhook", icon: Webhook, blurb: "POST the message to a URL, signed and retried." },
  forward: { label: "Forward", icon: Forward, blurb: "Send the message on to another address." },
  agent: { label: "AI agent", icon: Bot, blurb: "Let a model read it and reply or escalate." },
}

/** "support@example.com", or "*@example.com" for a whole-domain rule. */
const addressOf = (r: Pick<Route, "match_pattern" | "domain">) => `${r.match_pattern}@${r.domain}`

function RouteForm({ domains, providers, onDone }: { domains: string[]; providers: AiProvider[]; onDone: () => void }) {
  const provider = useProvider()
  const qc = useQueryClient()
  const [action, setAction] = useState<RouteAction>("webhook")
  const [domain, setDomain] = useState(domains[0] ?? "")
  const [pattern, setPattern] = useState("")
  const [destination, setDestination] = useState("")
  const [prompt, setPrompt] = useState("")
  const [forwardTo, setForwardTo] = useState("")
  const [aiProvider, setAiProvider] = useState("openai")
  const [aiKey, setAiKey] = useState("")
  const [aiBaseUrl, setAiBaseUrl] = useState("")
  const [aiModel, setAiModel] = useState("")

  const spec = providers.find((p) => p.id === aiProvider)
  const needsBaseUrl = !!spec && !spec.baseUrl

  const create = useMutation({
    mutationFn: (body: NewRoute) => provider.createRoute(body),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["routes"] })
      toast.success(`Route added for ${addressOf(r)}`)
      onDone()
    },
    onError: (e) => toast.error(errMsg(e)),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const base: NewRoute = { domain, matchPattern: pattern.trim(), action }
    if (action === "agent") {
      create.mutate({
        ...base,
        agentPrompt: prompt.trim(),
        agentForwardTo: forwardTo.split(",").map((s) => s.trim()).filter(Boolean),
        aiProvider,
        aiApiKey: aiKey.trim(),
        aiBaseUrl: aiBaseUrl.trim() || null,
        aiModel: aiModel.trim() || null,
      })
    } else {
      create.mutate({ ...base, destination: destination.trim() })
    }
  }

  return (
    <Card>
      <CardContent className="p-4">
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr]">
            <div className="space-y-1.5">
              <label htmlFor="route-pattern" className="text-xs font-medium text-muted-foreground">
                Address pattern
              </label>
              <Input
                id="route-pattern"
                placeholder="support"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                spellCheck={false}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="route-domain" className="text-xs font-medium text-muted-foreground">
                Domain
              </label>
              <Select value={domain} onValueChange={setDomain}>
                <SelectTrigger id="route-domain" className="font-mono text-xs">
                  <SelectValue placeholder="Pick a domain" />
                </SelectTrigger>
                <SelectContent>
                  {domains.map((d) => (
                    <SelectItem key={d} value={d} className="font-mono text-xs">{d}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="route-action" className="text-xs font-medium text-muted-foreground">
                Action
              </label>
              <Select value={action} onValueChange={(v) => setAction(v as RouteAction)}>
                <SelectTrigger id="route-action"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(ACTION_META) as RouteAction[]).map((a) => (
                    <SelectItem key={a} value={a}>{ACTION_META[a].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            {ACTION_META[action].blurb} <code className="font-mono">*</code> matches every address on the domain;{" "}
            <code className="font-mono">ticket+*</code> matches a prefix.
          </p>

          {action !== "agent" && (
            <div className="space-y-1.5">
              <label htmlFor="route-destination" className="text-xs font-medium text-muted-foreground">
                {action === "webhook" ? "Webhook URL" : "Forward to"}
              </label>
              <Input
                id="route-destination"
                type={action === "webhook" ? "url" : "email"}
                placeholder={action === "webhook" ? "https://your-app.example/inbound" : "you@example.com"}
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                spellCheck={false}
                className="font-mono text-xs"
              />
            </div>
          )}

          {action === "agent" && (
            <div className="space-y-4 rounded-md border border-border bg-rail/40 p-3">
              <div className="space-y-1.5">
                <label htmlFor="route-prompt" className="text-xs font-medium text-muted-foreground">
                  Instructions
                </label>
                <Textarea
                  id="route-prompt"
                  rows={3}
                  placeholder="Answer questions about our pricing. Escalate anything about refunds."
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label htmlFor="route-ai-provider" className="text-xs font-medium text-muted-foreground">
                    Model provider
                  </label>
                  <Select value={aiProvider} onValueChange={setAiProvider}>
                    <SelectTrigger id="route-ai-provider"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {providers.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="route-ai-key" className="text-xs font-medium text-muted-foreground">
                    API key
                  </label>
                  <Input
                    id="route-ai-key"
                    type="password"
                    autoComplete="off"
                    placeholder="sk-…"
                    value={aiKey}
                    onChange={(e) => setAiKey(e.target.value)}
                    spellCheck={false}
                    className="font-mono text-xs"
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {needsBaseUrl && (
                  <div className="space-y-1.5">
                    <label htmlFor="route-ai-url" className="text-xs font-medium text-muted-foreground">
                      Base URL
                    </label>
                    <Input
                      id="route-ai-url"
                      placeholder="http://localhost:11434/v1"
                      value={aiBaseUrl}
                      onChange={(e) => setAiBaseUrl(e.target.value)}
                      spellCheck={false}
                      className="font-mono text-xs"
                    />
                  </div>
                )}
                <div className="space-y-1.5">
                  <label htmlFor="route-ai-model" className="text-xs font-medium text-muted-foreground">
                    Model <span className="font-normal">(optional)</span>
                  </label>
                  <Input
                    id="route-ai-model"
                    placeholder={spec?.defaultModel || "model name"}
                    value={aiModel}
                    onChange={(e) => setAiModel(e.target.value)}
                    spellCheck={false}
                    className="font-mono text-xs"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="route-forward-to" className="text-xs font-medium text-muted-foreground">
                  Escalate to <span className="font-normal">(optional, comma-separated)</span>
                </label>
                <Input
                  id="route-forward-to"
                  placeholder="humans@example.com"
                  value={forwardTo}
                  onChange={(e) => setForwardTo(e.target.value)}
                  spellCheck={false}
                  className="font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">
                  The agent can only ever reply to the sender or forward to one of these addresses (or one on a
                  domain you host). Your key is encrypted on this server and never shown again.
                </p>
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <Button type="submit" disabled={create.isPending || !pattern.trim() || !domain}>
              {create.isPending ? "Adding…" : "Add route"}
            </Button>
            <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function RouteRow({ route }: { route: Route }) {
  const provider = useProvider()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const Icon = ACTION_META[route.action].icon
  const invalidate = () => qc.invalidateQueries({ queryKey: ["routes"] })

  const toggle = useMutation({
    mutationFn: () => provider.updateRoute(route.id, { active: !route.active }),
    onSuccess: (r) => { invalidate(); toast.success(r.active ? "Route enabled" : "Route paused") },
    onError: (e) => toast.error(errMsg(e)),
  })

  const remove = async () => {
    const ok = await confirm({
      title: `Delete the route for ${addressOf(route)}?`,
      description:
        route.action === "agent"
          ? "Its stored API key is deleted with it. Mail to this address stops being handled."
          : "Mail to this address stops being handled by this route.",
      confirmText: "Delete",
      destructive: true,
    })
    if (!ok) return
    try {
      await provider.deleteRoute(route.id)
      invalidate()
      toast.success("Route deleted")
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  const rotate = async () => {
    const ok = await confirm({
      title: `Rotate the signing secret for ${addressOf(route)}?`,
      description: "The current secret stops verifying immediately — update your receiver with the new one.",
      confirmText: "Rotate",
      destructive: true,
    })
    if (!ok) return
    try {
      await provider.rotateRouteSecret(route.id)
      invalidate()
      toast.success("New signing secret issued")
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Icon className={route.active ? "size-4 text-primary" : "size-4 text-muted-foreground"} aria-hidden />
          <span className="font-mono text-sm">{addressOf(route)}</span>
          <span className="rounded border border-border px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            {ACTION_META[route.action].label}
          </span>
          {!route.active && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
              Paused
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
              {route.active ? "Pause" : "Enable"}
            </Button>
            {route.action === "webhook" && (
              <Button variant="ghost" size="sm" onClick={rotate}>Rotate secret</Button>
            )}
            <Button variant="ghost" size="icon" onClick={remove} aria-label={`Delete route for ${addressOf(route)}`}>
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </div>
        </div>

        {route.destination && (
          <p className="truncate font-mono text-xs text-muted-foreground" title={route.destination}>
            → {route.destination}
          </p>
        )}

        {route.action === "agent" && (
          <div className="space-y-2">
            <p className="line-clamp-2 text-xs text-muted-foreground">{route.agent_prompt}</p>
            <p className="text-xs text-muted-foreground">
              <span className="font-mono">{route.ai_provider}</span>
              {route.ai_model && <> · <span className="font-mono">{route.ai_model}</span></>}
              {" · "}
              {route.hasAiKey ? "key configured" : "no usable key — re-enter it"}
              {route.agent_forward_to.length > 0 && <> · escalates to {route.agent_forward_to.join(", ")}</>}
            </p>
          </div>
        )}

        {route.action === "webhook" && route.webhook_secret && (
          <ValueRow label="Signing secret (verify x-mailkite-signature)" value={route.webhook_secret} />
        )}
      </CardContent>
    </Card>
  )
}

export function RoutesScreen() {
  const provider = useProvider()
  const [adding, setAdding] = useState(false)
  const caps = useQuery({ queryKey: ["capabilities"], queryFn: () => provider.capabilities() })
  const domains = useQuery({ queryKey: ["domains"], queryFn: () => provider.domains() })
  const data = useQuery({
    queryKey: ["routes"],
    queryFn: () => provider.routes(),
    enabled: caps.data?.routes === true,
  })

  const header = (
    <PageHeader
      title="Routes"
      description="Match an address, then webhook it, forward it, or hand it to an AI agent."
    />
  )

  if (caps.isLoading) {
    return (
      <div className="space-y-6">
        {header}
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Loading…</CardContent></Card>
      </div>
    )
  }

  // A backend that can't route says so rather than showing a form that would fail on save.
  if (!caps.data?.routes) {
    return (
      <div className="space-y-6">
        {header}
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <div className="flex size-12 items-center justify-center rounded-full border border-border bg-rail">
              <Split className="size-6 text-muted-foreground" aria-hidden />
            </div>
            <p className="font-medium">Not available on this backend</p>
            <p className="max-w-md text-sm text-muted-foreground">
              This backend delivers mail but doesn&rsquo;t evaluate per-address routes.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const routes = data.data?.routes ?? []

  return (
    <div className="space-y-6">
      {header}

      {!domains.data?.length ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-10 text-center">
            <Split className="size-8 text-muted-foreground" aria-hidden />
            <p className="font-medium">No domains yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Add a domain first — a route always belongs to one.
            </p>
          </CardContent>
        </Card>
      ) : adding ? (
        <RouteForm domains={domains.data} providers={data.data?.providers ?? []} onDone={() => setAdding(false)} />
      ) : (
        <Button onClick={() => setAdding(true)}>Add route</Button>
      )}

      {data.isError ? (
        <Card><CardContent className="p-8 text-center text-sm text-destructive">{errMsg(data.error)}</CardContent></Card>
      ) : data.isLoading ? (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Loading routes…</CardContent></Card>
      ) : routes.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            No routes yet. Mail still arrives and stays readable over IMAP — a route is how you act on it.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {routes.map((r) => (
            <RouteRow key={r.id} route={r} />
          ))}
        </div>
      )}
    </div>
  )
}
