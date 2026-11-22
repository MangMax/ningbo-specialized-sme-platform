import { join, resolve } from 'node:path'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { postgresRuntimeFixture } from './postgres-fixture.mjs'
import { spawnOwnedChild, reserveLoopbackPort, waitForHttp, stopOwnedChild } from './owned-process.mjs'

type Launch = (context: { cwd: string; port: number }) => {
  args: string[]
  env?: NodeJS.ProcessEnv
}

export function nativeAppAdapter({ dir, token, launch }: { dir: string; token: string; launch?: Launch }) {
  let generation = 0
  const exportsDir = () => join(dir, `exports-${generation}`)
  let pool: pg.Pool | undefined
  let db: NodePgDatabase | undefined
  let baseUrl = ''
  let postgresUrl: string | undefined
  let processId: number | undefined
  let output = ''
  let stop: (() => Promise<void>) | undefined
  let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
  const url = (path: string) => baseUrl + path
  const request = (path: string, init?: RequestInit) => fetch(url(path), { headers, ...init })

  async function prepare() {
    if (postgres) return
    postgres = await postgresRuntimeFixture({ dir })
    postgresUrl = postgres.url
    pool = new pg.Pool({ connectionString: postgres.url, options: '-c search_path=business,public' })
    db = drizzle(pool)
  }

  async function stopRuntime() {
    try {
      await stop?.()
    } finally {
      stop = undefined
      await pool?.end()
      pool = undefined
      db = undefined
      postgres?.close()
      postgres = undefined
      postgresUrl = undefined
    }
  }

  async function start() {
    if (stop) throw new Error('Native app already started')
    const cwd = resolve(import.meta.dirname, '../..')
    const port = await reserveLoopbackPort()
    if (port === 3480 || port === 3481) throw new Error('Reserved business port refused')
    const command = launch?.({ cwd, port }) ?? { args: [join(cwd, '.output/server/index.mjs')], env: { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port) } }
    const externalUrl = command.env?.NUXT_POSTGRES_DIRECTORY_URL
    output = ''
    try {
      if (!externalUrl) await prepare()
      const child = spawnOwnedChild(process.execPath, command.args, {
        cwd, stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NUXT_BUILD_DIR: join(dir, 'build'), NUXT_DB_READONLY: '0',
          NUXT_ROSTER_EXPORT_DIR: exportsDir(),
          NUXT_API_TOKEN: token, NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming'),
          ...command.env,
          ...(!externalUrl && postgres ? postgres.env : {
            NUXT_POSTGRES_DIRECTORY_URL: externalUrl,
            NUXT_POSTGRES_LOG_URL: command.env?.NUXT_POSTGRES_LOG_URL || externalUrl,
            NUXT_POSTGRES_LOG_SCHEMA: command.env?.NUXT_POSTGRES_LOG_SCHEMA || 'runtime_logs',
          }),
        },
      })
      processId = child.pid
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-12000) })
      baseUrl = `http://127.0.0.1:${port}`
      stop = () => stopOwnedChild(child)
      await waitForHttp(url(externalUrl ? '/api/jobs/kinds' : '/api/health'), { timeoutMs: 60000, child })
      postgresUrl = externalUrl ?? postgres?.url
    } catch (error) {
      await stopRuntime()
      throw new Error(String(error) + '\n' + output, { cause: error })
    }
  }

  async function terminal(id: string) {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      // Job progress is public; deliberately do not attach export credentials.
      const response = await fetch(url('/api/jobs/' + id))
      if (response.status !== 200) throw new Error('Job progress HTTP ' + response.status)
      const job = await response.json()
      if (['done', 'failed', 'cancelled'].includes(job.state)) return job
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    throw new Error('job did not finish: ' + id)
  }

  async function download(path: string) {
    const response = await request(path)
    return { response, bytes: Buffer.from(await response.arrayBuffer()) }
  }

  return {
    get processId() { return processId },
    get output() { return output },
    get db() {
      if (!db) throw new Error('Prepare the native app fixture before accessing its database')
      return db
    },
    get postgresUrl() { return postgresUrl },
    psql(args: string[]) {
      if (!postgres) throw new Error('Prepare the native app fixture before running psql')
      return postgres.psql(args)
    },
    get exportsDir() { return exportsDir() },
    headers, url, request, prepare, start, terminal, download,
    async resetBusiness() {
      await stopRuntime()
      generation++
    },
    close: stopRuntime,
  }
}
