import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'

/** Shared read seams for source-specific platform business projections. */
export type Db = BetterSQLite3Database<typeof schema>

export function fail(statusCode: number, code: string, message: string): never {
  throw Object.assign(new Error(message), { statusCode, code })
}

export function pageOf(filter: { page: number; pageSize: number }) {
  return { page: filter.page, pageSize: filter.pageSize, offset: (filter.page - 1) * filter.pageSize }
}

const RDJB_ORDER = ['1', '2', '3']

export function orderedScopes(values: Iterable<string>): string[] {
  const unique = [...new Set(values)].filter(Boolean)
  return unique.sort((a, b) => {
    const ai = RDJB_ORDER.indexOf(a), bi = RDJB_ORDER.indexOf(b)
    return (ai < 0 ? RDJB_ORDER.length : ai) - (bi < 0 ? RDJB_ORDER.length : bi) || a.localeCompare(b)
  })
}
