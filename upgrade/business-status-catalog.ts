/** Offline original status schema catalog from ab503081. */
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { BUSINESS_STATUS_V1, BUSINESS_STATUS_V2, businessStatusChecks } from '../lib/platform/business-status'

const oldChecks = {
  stored_status_kind_ck: `stored_status_kind IS NULL OR (stored_status_kind IN ('absent','null','text','number','boolean','array','object','invalid') AND (stored_status_kind NOT IN ('absent','null','array','object','invalid','boolean') OR stored_status IS NULL))`,
  stored_status_ck: `stored_status IS NULL OR (typeof(stored_status) = 'text')`,
  reconciled_status_ck: `reconciled_status IS NULL OR (typeof(reconciled_status) = 'text')`,
  status_reconcile_ck: `observation_id IS NULL OR (typeof(status_conflict) = 'integer' AND status_conflict = (stored_status IS NOT NULL AND parsed_status IS NOT NULL AND stored_status <> parsed_status) AND reconciled_status IS (CASE WHEN status_conflict = 1 THEN NULL ELSE coalesce(stored_status,parsed_status) END))`,
} as const
const normalized = (sql: string) => sql.replace(/["`][^"`]+["`]\./g, '').replace(/["`]/g, '').replace(/\s+/g, '').toLowerCase()

/** Extract a named CHECK with balanced parentheses, retaining its entire predicate. */
export function statusCheckRange(ddl: string, suffix: string) {
  const name = 'platform_business_projection_' + suffix
  const match = new RegExp(`CONSTRAINT\\s+["\`]?${name}["\`]?\\s+CHECK\\s*\\(`, 'i').exec(ddl)
  if (!match) throw new Error('Missing business status CHECK ' + name)
  const start = match.index + match[0].length
  let depth = 1, quoted = false
  for (let end = start; end < ddl.length; end++) {
    const c = ddl[end]
    if (c === "'") {
      if (quoted && ddl[end + 1] === "'") { end++; continue }
      quoted = !quoted
    }
    if (!quoted) {
      if (c === '(') depth++
      if (c === ')' && --depth === 0) return { start, end, predicate: ddl.slice(start, end) }
    }
  }
  throw new Error('Unterminated business status CHECK')
}
export function businessStatusRule(t: Database.Database) {
  const { sql } = z.object({ sql: z.string() }).parse(t.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='platform_business_projection'").get())
  const matches = (checks: typeof oldChecks | typeof businessStatusChecks) => Object.entries(checks).every(([name, predicate]) => normalized(statusCheckRange(sql, name).predicate) === normalized(predicate))
  if (matches(oldChecks)) return BUSINESS_STATUS_V1
  if (matches(businessStatusChecks)) return BUSINESS_STATUS_V2
  throw new Error('Unknown business status catalog')
}
export function upgradedBusinessStatusDdl(ddl: string) {
  for (const [name, predicate] of Object.entries(businessStatusChecks)) {
    const { start, end } = statusCheckRange(ddl, name)
    ddl = ddl.slice(0, start) + predicate + ddl.slice(end)
  }
  return ddl
}
