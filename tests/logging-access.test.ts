import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { createApp, defineEventHandler, setResponseStatus, toNodeListener } from 'h3'
import { logAccessAllowed } from '../server/utils/logging-access'

afterEach(() => vi.unstubAllGlobals())
it('enables same-origin log reads and settings without a capability switch or API token while rejecting foreign requests', async () => {
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: '' }))
  const app = createApp().use(defineEventHandler(event => {
    const allowed = logAccessAllowed(event)
    setResponseStatus(event, allowed ? 200 : 401)
    return { allowed }
  }))
  const server = createServer(toNodeListener(app))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test listener')
  const base = `http://127.0.0.1:${address.port}`
  const page = { 'x-log-browser': '1', 'sec-fetch-site': 'same-origin', referer: base + '/logs' }
  try {
    expect((await fetch(base + '/api/logs', { headers: page })).status).toBe(200)
    expect((await fetch(base + '/api/logs/policy', { method: 'PATCH', headers: { ...page, origin: base, 'content-type': 'application/json' }, body: '{}' })).status).toBe(200)
    expect((await fetch(base + '/api/logs', { headers: { ...page, referer: 'https://foreign.invalid/logs' } })).status).toBe(401)
    expect((await fetch(base + '/api/logs', { headers: { ...page, 'sec-fetch-site': 'cross-site' } })).status).toBe(401)
    expect((await fetch(base + '/api/logs')).status).toBe(401)
    vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'synthetic-api-token' }))
    expect((await fetch(base + '/api/logs', { headers: { authorization: 'Bearer synthetic-api-token' } })).status).toBe(200)
    expect((await fetch(base + '/api/logs', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
