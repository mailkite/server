// Docs: docs/dashboard/components/ui/combobox.md
// Combobox — our standard dropdown: a select-style trigger that opens a searchable, keyboard-
// navigable list (Popover + cmdk Command). Every dropdown in the dashboard uses this so they're
// all searchable; prefer it over a bare <Select>. See docs/architecture/dashboard.md (Dropdowns).
//
//   <Combobox
//     value={domainId}
//     onValueChange={setDomainId}
//     options={domains.map((d) => ({ value: d.id, label: d.domain }))}
//     placeholder="Pick a domain"
//     triggerClassName="w-56"
//   />
//
// Grouped lists pass `groups` instead of `options`. For a ⌘K launcher, control `open`/`onOpenChange`.
import * as React from "react"
import { Check, ChevronsUpDown } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { cn } from "@/lib/utils"

export interface ComboboxOption {
  value: string
  label: string
  /** Extra text matched by the search box (e.g. a description or alias). */
  keywords?: string
  disabled?: boolean
}
export interface ComboboxGroup {
  heading?: string
  options: ComboboxOption[]
}

export function Combobox({
  value,
  onValueChange,
  options,
  groups,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No results.",
  disabled,
  triggerClassName,
  contentClassName,
  align = "start",
  open: openProp,
  onOpenChange,
}: {
  value?: string
  onValueChange: (value: string) => void
  options?: ComboboxOption[]
  groups?: ComboboxGroup[]
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  disabled?: boolean
  triggerClassName?: string
  contentClassName?: string
  align?: "start" | "center" | "end"
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [openState, setOpenState] = React.useState(false)
  const open = openProp ?? openState
  const setOpen = (o: boolean) => {
    setOpenState(o)
    onOpenChange?.(o)
  }

  const resolvedGroups: ComboboxGroup[] = groups ?? [{ options: options ?? [] }]
  const all = resolvedGroups.flatMap((g) => g.options)
  const selected = all.find((o) => o.value === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        className={cn(
          "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm transition-colors hover:bg-accent/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          triggerClassName,
        )}
      >
        <span className={cn("line-clamp-1 text-left", !selected && "text-muted-foreground")}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent align={align} className={cn("w-[var(--radix-popover-trigger-width)] min-w-52", contentClassName)}>
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {resolvedGroups.map((g, gi) => (
              <React.Fragment key={g.heading ?? gi}>
                {gi > 0 && <CommandSeparator />}
                <CommandGroup heading={g.heading}>
                  {g.options.map((o) => (
                    <CommandItem
                      key={o.value}
                      // Search matches label + keywords; onSelect uses the closure value, so a
                      // cmdk-normalized arg can't corrupt ids.
                      value={`${o.label} ${o.keywords ?? ""} ${o.value}`}
                      disabled={o.disabled}
                      onSelect={() => {
                        onValueChange(o.value)
                        setOpen(false)
                      }}
                    >
                      <Check className={cn("size-4", value === o.value ? "opacity-100" : "opacity-0")} />
                      <span className="line-clamp-1">{o.label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </React.Fragment>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
