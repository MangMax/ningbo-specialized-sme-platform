import { useDb } from '@db'
import { usePostgresRosterDb } from './postgres-roster-db'
import { getEnterpriseFacts, preflightEnterpriseFact, commitEnterpriseFact } from './enterprise-facts'
import { readPostgresEnterpriseFacts, preflightPostgresEnterpriseFact, commitPostgresEnterpriseFact } from './enterprise-facts-postgres'

export async function readRuntimeEnterpriseFacts(id: number) {
  const db = usePostgresRosterDb()
  return db ? readPostgresEnterpriseFacts(db, id) : getEnterpriseFacts(useDb(), id)
}

export async function preflightRuntimeEnterpriseFact(id: number, body: unknown) {
  const db = usePostgresRosterDb(true)
  return db ? preflightPostgresEnterpriseFact(db, id, body) : preflightEnterpriseFact(useDb(), id, body)
}

export async function commitRuntimeEnterpriseFact(id: number, body: unknown) {
  const db = usePostgresRosterDb(true)
  return db ? commitPostgresEnterpriseFact(db, id, body) : commitEnterpriseFact(useDb(), id, body)
}
