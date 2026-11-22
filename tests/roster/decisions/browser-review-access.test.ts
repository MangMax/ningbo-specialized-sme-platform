import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import { createApp, defineEventHandler, setResponseStatus, toNodeListener } from 'h3'
import { checkBrowserReviewRequest } from '../../../layers/sme-roster/server/utils/browser-review-access'

it('enables browser writes without configuration while retaining exact origin and JSON validation', async () => {
  const app = createApp().use(defineEventHandler(event => {
    const result = checkBrowserReviewRequest(event, { write: true })
    setResponseStatus(event, result.ok ? 200 : result.status)
    return result
  }))
  const server = createServer(toNodeListener(app))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing listener')
  const base = `http://127.0.0.1:${address.port}`
  const post = (headers: Record<string, string>) => fetch(base, { method: 'POST', headers, body: '{}' })
  const headers = { origin: base, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }
  try {
    expect((await post(headers)).status).toBe(200)
    expect((await post({ ...headers, origin: 'https://foreign.invalid' })).status).toBe(403)
    expect((await post({ ...headers, origin: base + '/' })).status).toBe(403)
    expect((await post({ ...headers, 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await post({ 'content-type': 'application/json' })).status).toBe(403)
    expect((await post({ ...headers, 'content-type': 'text/plain' })).status).toBe(415)
    expect((await post({ ...headers, origin: 'https://forged.invalid', 'x-forwarded-host': 'forged.invalid', 'x-forwarded-proto': 'https' })).status).toBe(403)
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
