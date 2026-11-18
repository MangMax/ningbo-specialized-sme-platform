import type Database from 'better-sqlite3'
import { z } from 'zod'
import { BUSINESS_STATUS_V2, businessStatusChecks } from '../../../../db/business-status'

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
  const matches = (checks: typeof businessStatusChecks) => Object.entries(checks).every(([name, predicate]) => normalized(statusCheckRange(sql, name).predicate) === normalized(predicate))
  if (matches(businessStatusChecks)) return BUSINESS_STATUS_V2
  throw new Error('Unknown business status catalog')
}
