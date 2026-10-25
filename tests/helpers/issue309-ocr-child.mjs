// Minimal isolated H3 route host for the SIGKILL regression. No Nuxt build/dev,
// toolkit transport, application plugins, Docker, or inherited production paths.
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { createServer } from 'node:http'

const root = process.cwd()
const require = createRequire(resolve(root, 'package.json'))
const h3 = require('h3')
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
