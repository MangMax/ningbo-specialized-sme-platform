import { usePostgresDirectoryDb } from '../../../../db/postgresql/client'

export function rosterWriteEnabled() {
  return process.env.NUXT_DB_READONLY !== '1'
}

export function usePostgresRosterDb(write = false) {
  if (write && !rosterWriteEnabled()) {
    throw Object.assign(new Error('PostgreSQL roster writes require a writable connection'), { statusCode: 503 })
  }
  return usePostgresDirectoryDb()
}
