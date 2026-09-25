/**
 * Drizzle client, Neon serverless driver (HTTP-based — works in Next.js API
 * routes and edge functions without pooling/connection-lifecycle concerns).
 */

import { neon } from "@neondatabase/serverless"
import { drizzle } from "drizzle-orm/neon-http"
import * as schema from "./schema"

export type Database = ReturnType<typeof createDb>

export function createDb(databaseUrl: string) {
  const sql = neon(databaseUrl)
  return drizzle(sql, { schema })
}

let cached: Database | null = null

/** Lazily creates a singleton client from DATABASE_URL. Throws clearly if it's unset — never silently no-ops. */
export function getDb(): Database {
  if (cached) return cached
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error("DATABASE_URL is not set. See .env.example.")
  }
  cached = createDb(url)
  return cached
}
