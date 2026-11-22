import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const materializers = ['enterprise-directory', 'enterprise-identity', 'jobs', 'file-and-lead-lists', 'roster']

async function createEmptyLogSource(directory) {
  const require = createRequire(import.meta.url)
  const { createJiti } = createRequire(require.resolve('nuxt/package.json'))('jiti')
  const jiti = createJiti(import.meta.url, { fsCache: false })
  const { createLogService } = await jiti.import(join(root, 'layers/core/lib/logging/sqlite-service.ts'))
  const logs = createLogService({ directory })
  try { await logs.policy() }
  finally { await logs.close() }
  return join(directory, 'events.db')
}

/**
 * Materialize the runtime from a disposable SQLite source using the real offline
 * conversion. The running application only sees the isolated PostgreSQL schemas.
 * @param {{ dir: string; sourcePath?: string; bin?: string; logsOnly?: boolean }} options
 */
export async function postgresRuntimeFixture({ dir, sourcePath, bin = process.env.ROSTER_TEST_POSTGRES_BIN, logsOnly = false }) {
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
  url.searchParams.set('host', socket)
  const pgEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG'))),
    PGHOST: socket, PGPORT: '5432', PGUSER: user, PGDATABASE: 'postgres', PGSQL_BIN: binDir,
  }
  const run = (name, args) => execFileSync(join(binDir, name), args, { cwd: root, env: pgEnv, encoding: 'utf8', stdio: 'pipe' })
  /** @param {string[]} args */
  const psql = (args) => run('psql', ['-X', '-w', '-v', 'ON_ERROR_STOP=1', ...args])
  const node = (args) => execFileSync(process.execPath, args, { cwd: root, env: pgEnv, encoding: 'utf8', stdio: 'pipe' })
  const materialize = (name, staging) => psql(['-v', 'staging=' + staging, '-f', 'upgrade/postgresql/materialize-' + name + '.sql'])
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
    if (!logsOnly) {
      if (!sourcePath) {
        sourcePath = join(fixture, 'source.db')
        node(['scripts/initialize-native-db.mjs', sourcePath])
      }
      node(['upgrade/postgresql/stage-sqlite.mjs', resolve(sourcePath), 'fixture_business'])
      for (const name of materializers) materialize(name, 'fixture_business')
    }
    const logSource = await createEmptyLogSource(join(fixture, 'source-logs'))
    node(['upgrade/postgresql/stage-sqlite.mjs', logSource, 'fixture_logs'])
    materialize('runtime-logs', 'fixture_logs')
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
