import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../db/schema'
import { getComparison } from './comparison'
import { readCuration, projectCuratedComparison } from './curation-model'

export * from './curation-model'

export function getCuratedComparison(db: BetterSQLite3Database<typeof schema>, path: string) {
  const result = getComparison(db)
  const annotations = readCuration(path)
  const names = new Map(db.select({ id: schema.enterprise.id, nameNorm: schema.enterprise.nameNorm }).from(schema.enterprise).all().map(e => [e.id, e.nameNorm]))
  return projectCuratedComparison(result, annotations, names)
}
