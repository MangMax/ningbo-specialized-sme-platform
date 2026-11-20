import { usePostgresDirectoryDb } from '../../../../db/postgresql/client'

export function usePostgresRosterDb() {
  if (process.env.NUXT_POSTGRES_ROSTER_READ !== '1') return
  const db = usePostgresDirectoryDb()
  if (!db) throw new Error('PostgreSQL roster reads require NUXT_POSTGRES_DIRECTORY_URL')
  return db
}
