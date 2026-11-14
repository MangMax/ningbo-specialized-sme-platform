import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createRuntimeSchema } from '../../db/create-runtime'
import * as schema from '../../db/schema'
import { commitRosterImport } from '../../server/utils/roster-import'
import type { RosterImportPlatformQuery } from '../../lib/roster-import-client'
export function nativeImportDb() {
  const sqlite = new Database(':memory:'); sqlite.pragma('foreign_keys=ON'); createRuntimeSchema(sqlite)
  return drizzle(sqlite, { schema })
}
export function businessSource(key: string, rows: NonNullable<RosterImportPlatformQuery['relations']> = []): RosterImportPlatformQuery {
  return { interface:'business_list',queryKey:key,rdjb:'2',titleCode:'specialized_sme',queriedAt:'2026-05-31T00:00:00Z',status:rows.length?'success':'no_record',rawResponse:JSON.stringify({source:key,rows}),relations:rows }
}
export function commitNativeSource(db: ReturnType<typeof nativeImportDb>, query: RosterImportPlatformQuery, key: string) {
  return commitRosterImport(db,{idempotencyKey:key,sourceKind:'platform_archive',sourceIdentity:'synthetic/native-import',payload:{platformQueries:[query]}},[],{deferCandidateTasks:true})
}
