// Docs: docs/dashboard/components/load-more.md
import { Button } from "@/components/ui/button"

// The shared footer for every paginated list — one "Load more" control plus an optional
// "Showing X of Y" count. Renders nothing when there's nothing more to load, so callers
// drop it unconditionally at the bottom of a list and let it decide whether to appear.
// Pairs with `useCursorList` / `usePagedList` from `@/lib/pagination`.
export function LoadMore({
  hasMore,
  onClick,
  loading,
  shown,
  total,
}: {
  hasMore: boolean
  onClick: () => void
  loading?: boolean
  shown?: number
  total?: number
}) {
  if (!hasMore) return null
  return (
    <div className="border-t border-border p-3 text-center">
      <Button variant="outline" size="sm" onClick={onClick} disabled={loading}>
        {loading ? "Loading…" : "Load more"}
      </Button>
      {shown != null && total != null && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Showing {shown} of {total}
        </p>
      )}
    </div>
  )
}
