import { createServer } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { createApp, defineEventHandler, toNodeListener } from 'h3'
import { expect, it } from 'vitest'
import { admitEnterpriseResponse } from '../server/utils/enterprise-read-response'

it('backpressures slow HTTP responses until finish or disconnect releases an enterprise slot', async () => {
  const streams: PassThrough[] = []
  const responses: import('node:http').ServerResponse[] = []
  const app = createApp().use(defineEventHandler(event => {
    admitEnterpriseResponse(event)
    const body = new PassThrough()
    streams.push(body); responses.push(event.node.res)
    event.node.res.setHeader('content-type', 'text/plain')
    event.node.res.flushHeaders()
    return body
  }))
  const server = createServer(toNodeListener(app))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const clients: AbortController[] = []
  const request = () => { const controller = new AbortController(); clients.push(controller); return fetch(base, { signal: controller.signal }) }
  try {
    const held = await Promise.all(Array.from({ length: 17 }, request))
    expect(held.every(response => response.status === 200)).toBe(true)
    expect((await request()).status).toBe(503)
    streams[0]!.end('complete')
    expect(await held[0]!.text()).toBe('complete')
    expect((await request()).status).toBe(200)
    const closed = once(responses[1]!, 'close')
    clients[1]!.abort()
    await closed
    expect((await request()).status).toBe(200)
  } finally {
    clients.forEach(controller => controller.abort())
    streams.forEach(stream => stream.destroy())
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
