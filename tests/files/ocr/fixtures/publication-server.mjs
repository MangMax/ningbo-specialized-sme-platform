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
// Fault injector only: stop the owned process immediately AFTER a real SQLite
// transaction commits the selected claim state, before its caller resumes. The
// parent reads the committed row from another connection and SIGKILLs us. No
// production hook or replacement claim algorithm is used by this observer.
if (process.env.ISSUE309_STOP_CLAIM_SOURCE || process.env.ISSUE309_STOP_ORIGINAL_UNKNOWN) {
  const Database = require('better-sqlite3')
  const original = Database.prototype.transaction
  let stopped = false
  Database.prototype.transaction = function (fn) {
    const native = original.call(this, fn)
    const observe = () => {
      if (stopped || this.inTransaction) return
      const row = process.env.ISSUE309_STOP_ORIGINAL_UNKNOWN
        ? this.prepare("select id, result from job where kind = 'ocr' and state = 'running' order by created_at desc limit 1").get()
        : this.prepare('select id, result from job where id = ?').get(process.env.ISSUE309_STOP_CLAIM_SOURCE)
      const result = JSON.parse(row?.result ?? '{}')
      const committedState = process.env.ISSUE309_STOP_ORIGINAL_UNKNOWN ? 'original-unknown' : process.env.ISSUE309_STOP_CLAIM_STATE
      const matched = process.env.ISSUE309_STOP_ORIGINAL_UNKNOWN
        ? !result.publication?.recovery && result.publication?.files.some(file => Object.values(file.requests).some(request => request.state === 'unknown'))
        : Object.values(result.ocrRecovery?.pages ?? {}).some(page => page.attempts.at(-1)?.state === committedState)
      if (!matched) return
      stopped = true
      writeFileSync(process.env.ISSUE309_STOP_FILE, JSON.stringify({ pid: process.pid, taskId: row.id, committedState }))
      process.kill(process.pid, 'SIGSTOP')
    }
    const wrapped = Object.fromEntries(['default', 'deferred', 'immediate', 'exclusive'].map(mode => [mode, (...args) => { const result = native[mode](...args); observe(); return result }]))
    for (const f of Object.values(wrapped)) Object.defineProperties(f, Object.fromEntries([...Object.entries(wrapped), ['database', this]].map(([key, value]) => [key, { value }])))
    return wrapped.default
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
const load = createJiti(resolve(root, 'package.json'), { alias: { '@db': resolve(root, 'db/index.ts'), '~~': root } })
const router = h3.createRouter()
for (const [method, path, file] of [
  ['post', '/api/jobs', 'jobs/index.post.ts'],
  ['get', '/api/jobs/:id', 'jobs/[id].get.ts'],
  ['get', '/api/files/:id/ocr-pages/:page', 'files/[id]/ocr-pages/[page].get.ts'],
]) router[method](path, (await load.import(resolve(root, 'server/api', file))).default)
router.get('/health', h3.defineEventHandler(() => ({ isolated: true })))
// Test-only observation of the actual runner finishing, including a still-live
// original executor whose persisted row was marked failed by another process.
router.get('/issue309/idle', h3.defineEventHandler(async () => {
  const { whenIdle } = await load.import(resolve(root, 'layers/core/server/utils/job-runner.ts'))
  await whenIdle()
  return { idle: true }
}))
const server = createServer(h3.toNodeListener(h3.createApp({ debug: false }).use(router)))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
process.stdout.write(JSON.stringify({ base: `http://127.0.0.1:${server.address().port}` }) + '\n')
