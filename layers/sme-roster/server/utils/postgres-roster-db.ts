import { usePostgresDirectoryDb } from '../../../../db/postgresql/client'

export function usePostgresRosterDb(write = false) {
  if (write && process.env.NUXT_DB_READONLY === '1') {
    throw Object.assign(new Error('PostgreSQL roster writes require a writable connection'), { statusCode: 503 })
  }
  return usePostgresDirectoryDb()
}
