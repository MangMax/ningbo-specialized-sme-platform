// Minimal isolated H3 route host for the SIGKILL regression. No Nuxt build/dev,
// toolkit transport, application plugins, Docker, or inherited production paths.
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'

const root = process.cwd()
const require = createRequire(resolve(root, 'package.json'))
const h3 = require('h3')
// Fault injector only: stop the owned process immediately AFTER a real SQLite
// transaction commits the selected claim state, before its caller resumes. The
// parent reads the committed row from another connection and SIGKILLs us. No
// production hook or replacement claim algorithm is used by this observer.
if (process.env.ISSUE309_STOP_CLAIM_SOURCE) {
  const Database = require('better-sqlite3')
  const original = Database.prototype.transaction
  let stopped = false
  Database.prototype.transaction = function (fn) {
    const native = original.call(this, fn)
    const observe = () => {
      if (stopped || this.inTransaction) return
      const row = this.prepare('select result from job where id = ?').get(process.env.ISSUE309_STOP_CLAIM_SOURCE)
      const pages = JSON.parse(row?.result ?? '{}').ocrRecovery?.pages ?? {}
      if (!Object.values(pages).some(page => page.attempts.at(-1)?.state === process.env.ISSUE309_STOP_CLAIM_STATE)) return
      stopped = true
      writeFileSync(process.env.ISSUE309_STOP_FILE, JSON.stringify({ pid: process.pid, committedState: process.env.ISSUE309_STOP_CLAIM_STATE }))
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
const server = createServer(h3.toNodeListener(h3.createApp({ debug: false }).use(router)))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
process.stdout.write(JSON.stringify({ base: `http://127.0.0.1:${server.address().port}` }) + '\n')
