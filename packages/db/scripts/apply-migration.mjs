import { neon } from "@neondatabase/serverless"
import fs from "node:fs"

const file = process.argv[2]
if (!file) {
  console.error("usage: node apply-migration.mjs <path-to-sql>")
  process.exit(1)
}

const sql = neon(process.env.DATABASE_URL)
const statements = fs.readFileSync(file, "utf8").split("--> statement-breakpoint")

for (const stmt of statements) {
  const trimmed = stmt.trim()
  if (!trimmed) continue
  console.log(`running: ${trimmed}`)
  await sql(trimmed)
}
console.log("done")
