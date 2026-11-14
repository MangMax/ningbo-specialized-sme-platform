/** Test-only real h3/Node stream boundary fixture; not a Nuxt route or product hook.
 * HTTP framing uses the original Content-Length. x-fixture-length changes only
 * the handler's observed header, allowing actual bytes > declared bytes without
 * replacing either the production reader or its application/service logic.
 */
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { createApp, toNodeListener, setHeader } from 'h3'
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const jiti = createJiti(import.meta.url)
Reflect.set(globalThis, 'useRuntimeConfig', () => ({ apiToken: 'synthetic-field-api' }))
const { createLoggingRoute } = await jiti.import(resolve('server/utils/logging-route.ts'))
const { closeApplicationLogging } = await jiti.import(resolve('lib/logging/index.ts'))
const routes = { patch: createLoggingRoute('setPolicy'), clear: createLoggingRoute('clear') }
const app = createApp().use(async event => {
  const req = event.node.req, on = req.on, off = req.off
  const wrapped = new WeakMap()
  let readers = 0, bytes = 0
  req.on = function (name, listener) {
    if (name === 'data') {
      readers++
      const observe = chunk => { bytes += Buffer.byteLength(chunk); listener(chunk) }
      wrapped.set(listener, observe)
      return on.call(this, name, observe)
    }
    return on.call(this, name, listener)
  }
  req.off = function (name, listener) { return off.call(this, name, name === 'data' ? wrapped.get(listener) ?? listener : listener) }
  if (req.headers['x-fixture-length'] !== undefined) {
    req.headers['content-length'] = req.headers['x-fixture-length'] === 'missing' ? undefined : req.headers['x-fixture-length']
  }
  const result = await routes[event.path === '/clear' ? 'clear' : 'patch'](event)
  setHeader(event, 'x-fixture-data-readers', String(readers))
  setHeader(event, 'x-fixture-read-bytes', String(bytes))
  return result
})
const server = createServer(toNodeListener(app))
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }))
process.on('SIGTERM', async () => {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await closeApplicationLogging()
  process.exit(0)
})
