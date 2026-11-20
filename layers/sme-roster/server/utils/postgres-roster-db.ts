import { usePostgresDirectoryDb } from '../../../../db/postgresql/client'

export function usePostgresRosterDb(write = false) {
  if (process.env.NUXT_POSTGRES_ROSTER_READ !== '1') return
  const db = usePostgresDirectoryDb()
  if (!db) throw new Error('PostgreSQL roster reads require NUXT_POSTGRES_DIRECTORY_URL')
  if (write && process.env.NUXT_POSTGRES_DIRECTORY_WRITE !== '1') {
    throw Object.assign(new Error('PostgreSQL roster writes require a writable connection'), { statusCode: 503 })
  }
  return db
}
