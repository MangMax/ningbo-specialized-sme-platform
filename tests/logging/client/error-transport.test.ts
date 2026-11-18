import { afterEach, expect, it, vi } from 'vitest'
import { createClientErrorTransport } from '../../../layers/core/lib/client-logging/transport'
const transports: ReturnType<typeof createClientErrorTransport>[] = []
afterEach(() => { for (const transport of transports.splice(0)) transport.dispose(); vi.unstubAllGlobals(); vi.useRealTimers() })
function fixture(options = {}) { const transport = createClientErrorTransport(options); transports.push(transport); return transport }
it('sends classified errors through the official transport and suppresses duplicates without reading raw errors', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetch)
  const transport = fixture()
  transport.report('script_error', 'roster')
  transport.report('script_error', 'roster')
  await transport.flush()
  expect(fetch).toHaveBeenCalledTimes(1)
  const [endpoint, request] = fetch.mock.calls[0]!
  expect(endpoint).toBe('/api/logs/client')
  expect(request).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'X-Log-Browser': '1' } })
  expect(JSON.parse(request.body)).toEqual([{ event: { kind: 'script_error', page: 'roster', level: 'error' } }])
  expect(transport.status()).toMatchObject({ queued: 0, sent: 1, suppressed: 1 })
})
it('bounds offline reports including in flight and expires old reports before reconnecting', async () => {
  let online = false, now = 1000
  const fetch = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetch)
  const transport = fixture({ online: () => online, now: () => now })
  for (const kind of ['script_error', 'vue_error', 'unhandled_rejection', 'interaction_failure'] as const)
    for (const page of ['roster', 'tasks', 'files', 'logs', 'settings', 'other'] as const)
      for (const level of ['error', 'warn'] as const) transport.report(kind, page, level)
  expect(transport.status()).toMatchObject({ queued: 32, dropped: 16 })
  await transport.flush(); expect(fetch).not.toHaveBeenCalled()
  now += 300000; online = true; await transport.flush()
  expect(transport.status()).toMatchObject({ queued: 0, dropped: 48, sent: 0 })
  expect(fetch).not.toHaveBeenCalled()
})
it('retries failed reporting at most three times without producing unhandled rejections or new reports', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('PRIVATE189 transport error')); vi.stubGlobal('fetch', fetch)
  const transport = fixture()
  transport.report('unhandled_rejection', 'files')
  for (let i = 0; i < 10; i++) await expect(transport.flush()).resolves.toBeUndefined()
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(transport.status()).toMatchObject({ queued: 0, failures: 3, dropped: 1, sent: 0 })
})
it('keeps the queue and active batch within one bounded buffer under concurrent report bursts', async () => {
  let resolve!: (value: unknown) => void
  const fetch = vi.fn(() => new Promise(r => { resolve = r })); vi.stubGlobal('fetch', fetch)
  const transport = fixture()
  transport.report('script_error', 'roster'); const active = transport.flush()
  for (const kind of ['script_error', 'vue_error', 'unhandled_rejection', 'interaction_failure'] as const)
    for (const page of ['roster', 'tasks', 'files', 'logs', 'settings', 'other'] as const)
      for (const level of ['error', 'warn'] as const) transport.report(kind, page, level)
  expect(transport.status()).toMatchObject({ queued: 31, inFlight: 1, dropped: 16, suppressed: 1 })
  resolve({ ok: true }); await active
  expect(transport.status()).toMatchObject({ queued: 31, inFlight: 0, sent: 1 })
})
it('reconnects with bounded official batches and discards invalid runtime classification values', async () => {
  let online = false
  const fetch = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetch)
  const transport = fixture({ online: () => online })
  transport.report('PRIVATE189' as any, 'roster')
  transport.report('script_error', '/files?token=PRIVATE189' as any)
  for (const kind of ['script_error', 'vue_error'] as const)
    for (const page of ['roster', 'tasks', 'files', 'logs', 'settings', 'other'] as const) transport.report(kind, page)
  await transport.flush(); expect(fetch).not.toHaveBeenCalled()
  online = true
  await transport.flush(); await transport.flush()
  expect(fetch.mock.calls.map(([, request]) => JSON.parse(request.body).length)).toEqual([8, 4])
  expect(JSON.stringify(fetch.mock.calls)).not.toContain('PRIVATE189')
  expect(transport.status()).toMatchObject({ sent: 12, queued: 0, dropped: 2 })
})

it('sends a separate bounded response reference without accepting arbitrary context or enlarging dedup keys', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetch)
  const transport = fixture()
  transport.report('interaction_failure', 'tasks', 'error', 'original-request-180')
  transport.report('interaction_failure', 'tasks', 'error', 'another-request-180')
  await transport.flush()
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual([{ event: { kind: 'interaction_failure', page: 'tasks', level: 'error', relatedRequestId: 'original-request-180' } }])
  expect(transport.status().suppressed).toBe(1)
})

it('keeps only valid request references at the exact length boundary without coercing or truncating claims', async () => {
  const { clientErrorReport } = await import('../../../layers/core/lib/client-logging/contract')
  const base = { kind: 'interaction_failure', page: 'tasks', level: 'error' }
  expect(clientErrorReport({ ...base, relatedRequestId: 'r'.repeat(128) })?.relatedRequestId).toBe('r'.repeat(128))
  for (const value of ['r'.repeat(129), '', '/private?token=secret', '<script>', 'line\nbreak', { toString() { throw Error('never coerce') } }, ['id'], 180]) {
    expect(clientErrorReport({ ...base, relatedRequestId: value })).toEqual(base)
  }
})
