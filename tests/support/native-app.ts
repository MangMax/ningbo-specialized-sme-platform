import { join, resolve } from 'node:path'
import { initializeDb } from '../../db/client'
import { spawnOwnedChild, reserveLoopbackPort, waitForHttp, stopOwnedChild } from './owned-process.mjs'

type Launch = (context: { cwd: string; port: number }) => {
  args: string[]
  env?: NodeJS.ProcessEnv
}

// Real native app transport only: scenario seeds and export oracles stay with callers.
// Each reset stops the owned process before opening a new immutable database path.
export function nativeAppAdapter({ dir, token, launch }: { dir: string; token: string; launch?: Launch }) {
  let generation = 0
  let dbPath = join(dir, 'synthetic.db')
  let db = initializeDb({ dbPath, create: true })
  let baseUrl = ''
  let processId: number | undefined
  let stop: (() => Promise<void>) | undefined
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
  const url = (path: string) => baseUrl + path
  const request = (path: string, init?: RequestInit) => fetch(url(path), { headers, ...init })

  async function start() {
    if (stop) throw new Error('Native app already started')
    const cwd = resolve(import.meta.dirname, '../..')
    const port = await reserveLoopbackPort()
    if (port === 3480 || port === 3481) throw new Error('Reserved business port refused')
    const command = launch?.({ cwd, port }) ?? { args: [join(cwd, '.output/server/index.mjs')], env: { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port) } }
    const child = spawnOwnedChild(process.execPath, command.args, {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NUXT_BUILD_DIR: join(dir, 'build'), NUXT_DB_PATH: dbPath,
        NUXT_API_TOKEN: token, NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming'),
        ...command.env,
      },
    })
    processId = child.pid
    let output = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-12000) })
    baseUrl = `http://127.0.0.1:${port}`
    stop = () => stopOwnedChild(child)
    try { await waitForHttp(url('/api/jobs/kinds'), { timeoutMs: 60000, child }) }
    catch (error) { await stop(); stop = undefined; throw new Error(String(error) + output) }
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

  async function resetBusiness() {
    await stop?.()
    stop = undefined
    db.$client.close()
    dbPath = join(dir, `synthetic-${++generation}.db`)
    db = initializeDb({ dbPath, create: true })
  }

  return {
    get processId() { return processId }, get db() { return db }, get dbPath() { return dbPath },
    headers, url, request, start, terminal, download, resetBusiness,
    async close() { try { await stop?.(); stop = undefined } finally { db.$client.close() } },
  }
}
