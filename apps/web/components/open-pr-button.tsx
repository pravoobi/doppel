"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"

export function OpenPrButton({ runId, passCount }: { runId: string; passCount: number }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [prUrl, setPrUrl] = useState<string | null>(null)

  async function handleClick() {
    setPending(true)
    setError(null)
    try {
      const res = await fetch(`/api/runs/${runId}/pr`, { method: "POST" })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      setPrUrl(body.prUrl)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  if (passCount === 0) return null

  return (
    <div className="flex flex-col items-end gap-1">
      <Button onClick={handleClick} disabled={pending || prUrl != null} variant="outline">
        {prUrl ? "PR opened" : pending ? "Opening PR…" : `Open PR (${passCount} pass finding${passCount === 1 ? "" : "s"})`}
      </Button>
      {prUrl && (
        <a href={prUrl} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:underline">
          {prUrl}
        </a>
      )}
      {error && <p className="max-w-xs text-right text-xs text-destructive">{error}</p>}
    </div>
  )
}
