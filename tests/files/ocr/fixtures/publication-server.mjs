// Minimal isolated H3 route host for the SIGKILL regression. No Nuxt build/dev,
// toolkit transport, application plugins, Docker, or inherited production paths.
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'

const root = process.cwd()
const require = createRequire(resolve(root, 'package.json'))
const h3 = require('h3')
// Hold an actual cache read outcome (including ENOENT) after it resolves. This
// makes an original executor's stale cache miss deterministic even if a resume
// completes and populates the optional cache before the original is released.
if (process.env.ISSUE309_CACHE_GATE_HIT) {
  const promises = require('node:fs/promises')
  const originalRead = promises.readFile
  let held = false
  promises.readFile = async function (file, ...args) {
    if (held || !String(file).includes('/.ocr-cache/')) return originalRead.call(this, file, ...args)
    held = true
    let value, failure
    try { value = await originalRead.call(this, file, ...args) } catch (error) { failure = error }
    writeFileSync(process.env.ISSUE309_CACHE_GATE_HIT, JSON.stringify({ pid: process.pid, cacheMiss: failure?.code === 'ENOENT' }))
    while (true) {
      try { await originalRead(process.env.ISSUE309_CACHE_GATE_RELEASE); break } catch (error) { if (error.code !== 'ENOENT') throw error }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    if (failure) throw failure
    return value
  }
}
if (process.env.ISSUE309_STOP_CLAIM_SOURCE || process.env.ISSUE309_STOP_ORIGINAL_UNKNOWN) {
  const { Client } = require('pg')
  const query = Client.prototype.query
  const originalUnknown = Boolean(process.env.ISSUE309_STOP_ORIGINAL_UNKNOWN)
  let stopped = false
  Client.prototype.query = function (config, ...args) {
    const result = query.call(this, config, ...args)
    const statement = typeof config === 'string' ? config : config?.text
    if (stopped || statement?.trim().toLowerCase() !== 'commit' || !result?.then) return result
    return result.then(async committed => {
      const rows = originalUnknown
        ? await query.call(this, "select id, result from business.job where kind = 'ocr' and state = 'running' order by created_at desc limit 1")
        : await query.call(this, 'select id, result from business.job where id = $1', [process.env.ISSUE309_STOP_CLAIM_SOURCE])
      const row = rows.rows[0]
      const receipt = JSON.parse(row?.result ?? '{}')
      const committedState = originalUnknown ? 'original-unknown' : process.env.ISSUE309_STOP_CLAIM_STATE
      const matched = originalUnknown
        ? !receipt.publication?.recovery && receipt.publication?.files.some(file => Object.values(file.requests).some(request => request.state === 'unknown'))
        : Object.values(receipt.ocrRecovery?.pages ?? {}).some(page => page.attempts.at(-1)?.state === committedState)
      if (matched && !stopped) {
        stopped = true
        writeFileSync(process.env.ISSUE309_STOP_FILE, JSON.stringify({ pid: process.pid, taskId: row.id, committedState }))
        process.kill(process.pid, 'SIGSTOP')
      }
      return committed
    })
  }
}
const { initLogger } = require('evlog')
initLogger({ enabled: true, silent: true, pretty: false, drain: () => {} })
Object.assign(globalThis, h3, {
  defineRouteMeta: () => {},
  useRuntimeConfig: () => ({ filesDir: process.env.NUXT_FILES_DIR, apiToken: 'issue309-api', ocrToken: 'issue309-synthetic-ocr', ocrBaseUrl: process.env.NUXT_OCR_BASE_URL }),
})
const jitiPath = createRequire(require.resolve('nuxt/package.json')).resolve('jiti')
const { createJiti } = require(jitiPath)
const load = createJiti(resolve(root, 'package.json'), { alias: { '@db/schema': resolve(root, 'db/schema.ts'), '@db': resolve(root, 'db/index.ts'), '~~': root, '#core': resolve(root, 'layers/core'), '#sme-roster': resolve(root, 'layers/sme-roster') } })
const { installApplicationServer } = await load.import(resolve(root, 'server/install-application.ts'))
installApplicationServer()
const { startPostgresJobs } = await load.import(resolve(root, 'layers/core/server/utils/postgres-jobs.ts'))
const runner = startPostgresJobs(process.env.NUXT_FILES_DIR).runner
await runner.wake()
const router = h3.createRouter()
for (const [method, path, file] of [
  ['post', '/api/jobs', 'jobs/index.post.ts'],
  ['get', '/api/jobs/:id', 'jobs/[id].get.ts'],
  ['get', '/api/files/:id/ocr-pages/:page', 'files/[id]/ocr-pages/[page].get.ts'],
]) router[method](path, (await load.import(resolve(root, 'layers/core/server/api', file))).default)
router.get('/health', h3.defineEventHandler(() => ({ isolated: true })))
// Test-only observation of the actual runner finishing, including a still-live
// original executor whose persisted row was marked failed by another process.
router.get('/issue309/idle', h3.defineEventHandler(async () => {
  await runner.wake()
  return { idle: true }
}))
const server = createServer(h3.toNodeListener(h3.createApp({ debug: false }).use(router)))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
process.stdout.write(JSON.stringify({ base: `http://127.0.0.1:${server.address().port}` }) + '\n')
