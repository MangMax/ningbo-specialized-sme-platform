import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const root = fileURLToPath(new URL('../..', import.meta.url))

/** @param {import('pg').PoolConfig} options */
export function postgresFixturePool(options) {
  const pool = new pg.Pool(options)
  /** @type {Set<import('pg').PoolClient>} */
  const connected = new Set()
  pool.on('connect', client => connected.add(client))
  pool.on('remove', client => connected.delete(client))
  return {
    pool,
    async close() {
      await pool.end()
      // pg-pool can resolve end() before its idle clients finish disconnecting.
      // Wait for their sockets before stopping the isolated PostgreSQL server.
      while (connected.size) await once(pool, 'remove')
    },
  }
}

/**
 * Create an isolated PostgreSQL runtime.
 * @param {{ dir: string; bin?: string; logsOnly?: boolean }} options
 */
export async function postgresRuntimeFixture({ dir, bin = process.env.ROSTER_TEST_POSTGRES_BIN, logsOnly = false }) {
  if (!bin) throw new Error('Set ROSTER_TEST_POSTGRES_BIN to the PostgreSQL 19 bin directory')
  const binDir = resolve(bin)
  const version = execFileSync(join(binDir, 'postgres'), ['--version'], { encoding: 'utf8' }).trim()
  if (!/\b19\./.test(version)) throw new Error('PostgreSQL 19 is required for the isolated runtime fixture: ' + version)

  const fixture = mkdtempSync(join(resolve(dir), 'postgres-'))
  // Short, owner-only socket path even when the caller's temporary directory is long.
  const socket = mkdtempSync(join(tmpdir(), 'pg-'))
  const data = join(fixture, 'data')
  const log = join(fixture, 'postgres.log')
  const user = 'runtime_fixture'
  const url = new URL('postgresql://' + user + '@localhost/postgres')
  url.port = '5432'
  url.searchParams.set('host', socket)
  const pgEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG'))),
    PGHOST: socket, PGPORT: '5432', PGUSER: user, PGDATABASE: 'postgres', PGSQL_BIN: binDir,
  }
  const run = (name, args) => execFileSync(join(binDir, name), args, { cwd: root, env: pgEnv, encoding: 'utf8', stdio: 'pipe' })
  /** @param {string[]} args */
  const psql = (args) => run('psql', ['-X', '-w', '-v', 'ON_ERROR_STOP=1', ...args])
  const node = (args) => execFileSync(process.execPath, args, { cwd: root, env: pgEnv, encoding: 'utf8', stdio: 'pipe' })
  const close = () => {
    if (existsSync(join(data, 'postmaster.pid'))) run('pg_ctl', ['-D', data, '-w', '-m', 'fast', 'stop'])
    rmSync(socket, { recursive: true, force: true })
    rmSync(fixture, { recursive: true, force: true })
  }

  try {
    run('initdb', ['-D', data, '-U', user, '-A', 'trust', '--locale=C', '-E', 'UTF8'])
    const socketSetting = socket.replaceAll('\\', '\\\\').replaceAll("'", "''")
    appendFileSync(join(data, 'postgresql.conf'), "\nlisten_addresses = ''\nport = 5432\nunix_socket_directories = '" + socketSetting + "'\n")
    run('pg_ctl', ['-D', data, '-l', log, '-w', 'start'])
    node(['scripts/initialize-postgresql.mjs', ...(logsOnly ? ['--logs-only'] : [])])
    return {
      url: url.href, psql, close,
      env: {
        NUXT_POSTGRES_DIRECTORY_URL: url.href,
        NUXT_POSTGRES_LOG_URL: url.href,
        NUXT_POSTGRES_LOG_SCHEMA: 'runtime_logs',
        NUXT_POSTGRES_BIN: binDir,
      },
    }
  } catch (error) {
    const logTail = existsSync(log) ? readFileSync(log, 'utf8').slice(-4000) : ''
    try { close() }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'PostgreSQL fixture setup and cleanup both failed') }
    throw new Error('Failed to materialize isolated PostgreSQL runtime\n' + logTail, { cause: error })
  }
}
