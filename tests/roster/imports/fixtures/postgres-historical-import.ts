import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { createRuntimeSchema } from '../../../../db/create-runtime'

export const pg19Bin = process.env.TEST_ROSTER_IMPORT_PG_BIN

export async function withHistoricalImportDatabase(seed: string, run: (pool: pg.Pool, db: NodePgDatabase) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'pgi-'))
  const sqlitePath = join(dir, 'fixture.sqlite')
  const data = join(dir, 'pg')
  const env = { PATH: process.env.PATH, LC_ALL: 'C', TZ: 'UTC', PGHOST: dir, PGPORT: '5432', PGUSER: 'fixture',
    PGDATABASE: 'postgres', PGSQL_BIN: join(pg19Bin!, 'psql') }
  const command = (name: string, ...args: string[]) => execFileSync(join(pg19Bin!, name), args, { env, stdio: 'pipe' })
  const pool = new pg.Pool({ host: dir, port: 5432, user: 'fixture', database: 'postgres', options: '-c search_path=business,public' })
  let started = false
  try {
    const sqlite = new Database(sqlitePath)
    try {
      createRuntimeSchema(sqlite)
      sqlite.exec(seed)
    } finally {
      sqlite.close()
    }
    command('initdb', '-A', 'trust', '-E', 'UTF8', '--locale=C', '-U', 'fixture', '-D', data)
    try {
      command('pg_ctl', '-w', '-D', data, '-l', join(dir, 'pg.log'), '-o', "-c listen_addresses='' -k " + dir, 'start')
    } catch (error) {
      throw new Error(readFileSync(join(dir, 'pg.log'), 'utf8'), { cause: error })
    }
    started = true
    execFileSync(process.execPath, ['upgrade/postgresql/stage-sqlite.mjs', sqlitePath, 'staged'], { env, stdio: 'pipe' })
    for (const name of ['enterprise-directory', 'enterprise-identity', 'jobs', 'file-and-lead-lists', 'roster']) {
      command('psql', '-X', '-w', '-q', '-v', 'staging=staged', '-f', 'upgrade/postgresql/materialize-' + name + '.sql')
    }
    await run(pool, drizzle(pool))
  } finally {
    await pool.end()
    if (started) command('pg_ctl', '-w', '-D', data, '-m', 'fast', 'stop')
    rmSync(dir, { recursive: true, force: true })
  }
}
