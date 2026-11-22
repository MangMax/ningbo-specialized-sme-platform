import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, vi } from 'vitest'
import { closePostgresDirectoryDb } from '../../db/postgresql/client'
import { postgresRuntimeFixture } from './postgres-fixture.mjs'

/** Each case gets an independent database cloned from the migrated empty schema. */
export function useIsolatedPostgresCases() {
  let root: string | undefined
  let server: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
  let database: string | undefined
  let pool: pg.Pool | undefined
  let sequence = 0

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'vitest-postgres-'))
    server = await postgresRuntimeFixture({ dir: root })
  }, 60_000)
  afterEach(async () => {
    try {
      try { await closePostgresDirectoryDb() }
      finally { await pool?.end() }
    } finally {
      try { if (database) server?.psql(['-c', 'DROP DATABASE IF EXISTS ' + database]) }
      finally {
        database = undefined
        pool = undefined
        vi.unstubAllGlobals()
        vi.unstubAllEnvs()
      }
    }
  })
  afterAll(() => {
    try { server?.close() }
    finally { if (root) rmSync(root, { recursive: true, force: true }) }
  })

  return () => {
    if (!server) throw new Error('PostgreSQL fixture has not started')
    if (database) throw new Error('Each test can open one PostgreSQL case database')
    database = 'vitest_case_' + ++sequence
    server.psql(['-c', 'CREATE DATABASE ' + database + ' TEMPLATE postgres'])
    const url = new URL(server.url)
    url.pathname = '/' + database
    vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', url.href)
    vi.stubEnv('NUXT_DB_READONLY', '0')
    pool = new pg.Pool({ connectionString: url.href, options: '-c search_path=business,public' })
    return drizzle({ client: pool })
  }
}

export function singlePostgresFixtureRow<T>(rows: readonly T[]): T {
  const [row] = rows
  if (rows.length !== 1 || row === undefined) throw new Error('Expected one PostgreSQL fixture row, received ' + rows.length)
  return row
}
