import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestLogContext } from '../../../layers/core/lib/logging'
import { safeLogEvent } from '../../../layers/core/lib/logging/privacy'

const reads = vi.hoisted(() => ({ json: vi.fn() }))
vi.mock('@db', () => ({ useDb: () => ({ $client: { name: 'context-compat.db' } }) }))
vi.mock('../../../server/utils/enterprise-read', () => ({ enterpriseReads: reads }))

describe('request log context compatibility', () => {
  let handler: (event: unknown) => Promise<unknown>
  beforeAll(async () => {
    vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
    vi.stubGlobal('getQuery', () => ({}))
    vi.stubGlobal('setHeader', vi.fn())
    handler = (await import('../../../server/api/roster/enterprises.get')).default as unknown as typeof handler
  })
  beforeEach(() => reads.json.mockReset())
  afterAll(() => vi.unstubAllGlobals())

  it.each([
    { name: 'missing context', event: {} },
    { name: 'empty context', event: { context: {} } },
  ])('preserves the business read result with $name', async ({ event }) => {
    const body = Buffer.from('{"rows":[{"enterpriseId":42}],"counts":{"total":1},"page":1,"pageSize":50}')
    reads.json.mockResolvedValueOnce({ body })
    await expect(handler(event)).resolves.toBe(body)
    expect(reads.json).toHaveBeenLastCalledWith(
      'context-compat.db', expect.objectContaining({ operation: 'list' }), expect.any(AbortSignal), {},
    )
    expect(event).not.toHaveProperty('context.applicationLogContext')
  })

  it('keeps only known method without inventing identity route or execution', () => {
    expect(requestLogContext({})).toEqual({})
    expect(requestLogContext({ method: 'GET' })).toEqual({ httpMethod: 'GET' })
    expect(requestLogContext({ context: {}, method: 'GET' })).toEqual({ httpMethod: 'GET' })
  })

  it('passes explicit H3 metadata to the read without mutating request ownership', async () => {
    const metadata = Object.freeze({ requestId: 'req-compat', traceId: 'trace-compat', taskId: 'task-compat' })
    const event = Object.freeze({
      method: 'GET',
      context: Object.freeze({ applicationLogContext: metadata, matchedRoute: { path: '/api/roster/enterprises' } }),
    })
    const body = Buffer.from('{"rows":[],"counts":{"total":0}}')
    reads.json.mockResolvedValueOnce({ body })
    await expect(handler(event)).resolves.toBe(body)
    expect(reads.json).toHaveBeenLastCalledWith(
      'context-compat.db', expect.objectContaining({ operation: 'list' }), expect.any(AbortSignal),
      { requestId: 'req-compat', traceId: 'trace-compat', taskId: 'task-compat', module: 'sme-roster', httpMethod: 'GET', httpRoute: '/api/roster/enterprises' },
    )
    expect(event.context.applicationLogContext).toBe(metadata)
    expect(event.context.applicationLogContext).toEqual({ requestId: 'req-compat', traceId: 'trace-compat', taskId: 'task-compat' })
    const task = safeLogEvent({
      ...requestLogContext(event), source: 'task', operation: 'task.queued', outcome: 'started',
      origin: { runtime: 'node', integration: 'application', capture: 'manual', execution: 'background' },
    })
    expect(task).toMatchObject({ source: 'task', module: 'sme-roster', taskId: 'task-compat', requestId: 'req-compat', origin: { execution: 'background' } })
    expect(task).not.toHaveProperty('httpMethod')
    expect(task).not.toHaveProperty('httpRoute')
  })

  it('does not swallow unrelated metadata accessor errors', () => {
    const failure = new Error('metadata accessor failed')
    expect(() => requestLogContext({ context: { get matchedRoute() { throw failure } } })).toThrow(failure)
  })
})
