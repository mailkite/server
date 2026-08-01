// Docs: docs/dashboard/components/logo.md
import type { SVGProps } from "react"

/**
 * MailKite mark — the C07 "sail kite" (duotone blue/violet sails + webhook
 * string). Transparent, so it reads on light or dark. Size it via className,
 * e.g. <Logo className="size-5" />.
 *
 * The viewBox frames just the kite *body*, so the className sizes the body and
 * the wordmark beside it aligns to the body — the string + dot hang below via
 * overflow-visible without affecting layout.
 */
export function Logo({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="13 6 38 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={["overflow-visible", className].filter(Boolean).join(" ")}
      {...props}
    >
      <path d="M32 6 L32 46 L13 23 Z" fill="#5b9bff" />
      <path d="M32 6 L51 23 L32 46 Z" fill="#7c6cff" />
      <path d="M32 46 C 35 52 41 53 45 58" stroke="#5b9bff" strokeWidth={3} strokeLinecap="round" />
      <circle cx="45" cy="58" r="3" fill="#5b9bff" />
    </svg>
  )
}
