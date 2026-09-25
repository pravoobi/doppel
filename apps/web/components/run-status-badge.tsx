import { Badge } from "@/components/ui/badge"
import type { Run } from "@doppel/db"

const STYLES: Record<Run["status"], string> = {
  pending: "bg-muted text-muted-foreground",
  running: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  completed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
}

export function RunStatusBadge({ status }: { status: Run["status"] }) {
  return (
    <Badge variant="outline" className={STYLES[status]}>
      {status}
      {status === "running" && (
        <span className="ml-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      )}
    </Badge>
  )
}
