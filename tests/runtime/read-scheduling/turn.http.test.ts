import { createServer } from 'node:http'
import { createApp, defineEventHandler, toNodeListener } from 'h3'
import { expect, it } from 'vitest'
import { createReadTurns, runReadTurn } from '../../../server/utils/read-turn'
import { withReadTurn } from '../../../server/utils/read-turn-http'

it('cleans real queued disconnects and lifecycle listeners without a new HTTP domain error', async () => {
  const reads: string[] = [], listeners: number[][] = []
  const turns = createReadTurns((input: string) => { reads.push(input); return { value: input } })
  const app = createApp()
  app.use('/cancel', defineEventHandler(async event => {
    const { req, res } = event.node
    listeners.push([req.listenerCount('aborted'), res.listenerCount('close')])
    const earlier = turns.submit('ahead')
    const pending = withReadTurn(event, turns, 'cancelled')
    // An actual socket disconnect while the whole read is still queued.
    res.destroy()
    await pending
    await earlier.result
    listeners.push([req.listenerCount('aborted'), res.listenerCount('close')])
  }))
  app.use('/read', defineEventHandler(event => withReadTurn(event, turns, 'kept')))
  const server = createServer(toNodeListener(app))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    await expect(fetch(base + '/cancel')).rejects.toThrow()
    const response = await fetch(base + '/read')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ value: 'kept' })
    expect(reads).toEqual(['ahead', 'kept'])
    expect(listeners).toHaveLength(2)
    expect(listeners[1]).toEqual(listeners[0])
  } finally { await new Promise<void>(r => server.close(() => r())) }
})

it('cleans an aborted MCP-style signal and leaves subsequent reads available', async () => {
  const reads: string[] = []
  const turns = createReadTurns((input: string) => { reads.push(input); return input })
  const signal = new AbortController()
  const pending = runReadTurn(turns, 'cancelled', signal.signal)
  signal.abort()
  expect(await pending).toBeUndefined()
  expect(await runReadTurn(turns, 'already aborted', signal.signal)).toBeUndefined()
  expect(await runReadTurn(turns, 'next')).toBe('next')
  expect(reads).toEqual(['next'])
})
