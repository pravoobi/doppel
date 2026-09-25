"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

/**
 * Polls (not SSE — CLAUDE.md §4 calls for an SSE route that doesn't exist yet;
 * this is the honest, simpler interim so a running run's page isn't static)
 * by re-fetching the current route's server data every `intervalMs`.
 */
export function AutoRefresh({ intervalMs = 3000 }: { intervalMs?: number }) {
  const router = useRouter()

  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs)
    return () => clearInterval(id)
  }, [router, intervalMs])

  return null
}
