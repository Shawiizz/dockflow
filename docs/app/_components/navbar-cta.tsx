"use client"

import Link from "next/link"
import { ThemeSwitch } from "nextra-theme-docs"

export function NavbarCTA() {
  return (
    <div className="flex items-center gap-3">
      <ThemeSwitch lite className="max-md:hidden" />
      <Link
        href="/getting-started"
        className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-neutral-900 dark:bg-neutral-800 text-neutral-50 text-[13px] font-semibold no-underline border border-neutral-800 dark:border-neutral-700 transition-opacity duration-200 hover:opacity-85 max-md:hidden"
      >
        Get Started
      </Link>
    </div>
  )
}
