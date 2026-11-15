import { IncomingMessage, ServerResponse, type IncomingHttpHeaders } from 'node:http'
import { Socket } from 'node:net'
import { createEvent } from 'h3'
import { afterEach, expect, it, vi } from 'vitest'

const cold = vi.hoisted(() => ({ calls: 0 }))
// A cold accessor must never be reached on denied opt-ins. No database is opened.
vi.mock('@db', () => ({ useDb: () => { cold.calls++; throw new Error('synthetic cold accessor reached') } }))
import { evidenceCorrectionRoute } from '../../../server/utils/roster-evidence-correction-route'
import { eventCorrectionRoute } from '../../../server/utils/roster-event-correction-route'

afterEach(() => { cold.calls = 0; vi.unstubAllGlobals() })
function request(path: string, headers: IncomingHttpHeaders) {
  const socket = new Socket(), incoming = new IncomingMessage(socket)
  incoming.method = 'GET'; incoming.url = path; incoming.headers = headers
  const event = createEvent(incoming, new ServerResponse(incoming))
  event.context.params = { id: '1' }
  return event
}
for (const [name, factory, message] of [
  ['evidence', evidenceCorrectionRoute, 'Configured token required'],
  ['event', eventCorrectionRoute, 'Configured API token required'],
] as const) {
  it.each([
    { name: 'missing token', configured: 'synthetic-key', headers: {} },
    { name: 'wrong token', configured: 'synthetic-key', headers: { authorization: 'Bearer wrong-key' } },
    { name: 'unconfigured token', configured: '', headers: { authorization: 'Bearer synthetic-key' } },
  ])(`${name} factory denies $name before the cold database accessor`, async ({ configured, headers }) => {
    vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: configured }))
    const event = request('/?official=latest', headers)
    const result = await factory('get')(event)
    expect(event.node.res.statusCode).toBe(401)
    expect(result).toEqual({ error: { code: 'unauthorized', message } })
    expect(event.node.res.getHeader('cache-control')).toBe('no-store')
    expect(cold.calls).toBe(0)
  })
  it.each([
    { name: 'authorized bearer opt-in', path: '/?official=latest', configured: 'synthetic-key', headers: { authorization: 'Bearer synthetic-key' } },
    { name: 'authorized header opt-in', path: '/?official=latest', configured: 'synthetic-key', headers: { 'x-api-token': 'synthetic-key' } },
    { name: 'legacy anonymous read', path: '/', configured: 'synthetic-key', headers: {} },
    { name: 'legacy unconfigured anonymous read', path: '/', configured: '', headers: {} },
  ])(`${name} factory permits $name to reach the cold database accessor`, async ({ path, configured, headers }) => {
    vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: configured }))
    // Positive control: the same cold accessor throws only after admission.
    await expect(factory('get')(request(path, headers))).rejects.toThrow('synthetic cold accessor reached')
    expect(cold.calls).toBe(1)
  })
}
