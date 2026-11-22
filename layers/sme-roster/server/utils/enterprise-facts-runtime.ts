import { usePostgresRosterDb } from './postgres-roster-db'
import { readPostgresEnterpriseFacts, preflightPostgresEnterpriseFact, commitPostgresEnterpriseFact } from './enterprise-facts-postgres'

export async function readRuntimeEnterpriseFacts(id: number) {
  const db = usePostgresRosterDb()
  return readPostgresEnterpriseFacts(db, id)
}

export async function preflightRuntimeEnterpriseFact(id: number, body: unknown) {
  const db = usePostgresRosterDb(true)
  return preflightPostgresEnterpriseFact(db, id, body)
}

export async function commitRuntimeEnterpriseFact(id: number, body: unknown) {
  const db = usePostgresRosterDb(true)
  return commitPostgresEnterpriseFact(db, id, body)
}
