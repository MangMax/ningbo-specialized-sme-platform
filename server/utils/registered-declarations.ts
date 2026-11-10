import { and, eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'

type Declaration = typeof schema.fileDeclaration669.$inferSelect
/** Shared registered-only projection; never writes or substitutes evidence statistics. */
export function listRegisteredDeclarations681(db: BetterSQLite3Database<typeof schema>, fileIds: readonly number[]) {
  const result = new Map<number, Declaration[]>()
  if (!fileIds.length) return result
  const rows = db.select().from(schema.fileDeclaration669)
    .where(and(inArray(schema.fileDeclaration669.fileId, [...fileIds]), eq(schema.fileDeclaration669.active, true)))
    .orderBy(schema.fileDeclaration669.displaySequence, schema.fileDeclaration669.declarationId).all()
  for (const row of rows) {
    const group = result.get(row.fileId) ?? []
    group.push(row)
    result.set(row.fileId, group)
  }
  return result
}
export function registeredSummary681(declarations: Declaration[]) {
  return { count: declarations.length, declarations }
}
