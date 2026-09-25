"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"

export function StartRunButton() {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleClick() {
    setPending(true)
    setError(null)
    try {
      const res = await fetch("/api/runs", { method: "POST" })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      router.push(`/runs/${body.runId}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Button onClick={handleClick} disabled={pending}>
        {pending ? "Starting…" : "Start demo run"}
      </Button>
      {error && <p className="text-sm text-destructive max-w-xs text-right">{error}</p>}
    </div>
  )
}
