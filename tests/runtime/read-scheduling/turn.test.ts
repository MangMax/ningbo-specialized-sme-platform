import { expect, it } from 'vitest'
import { createReadTurns } from '../../../server/utils/read-turn'

it('allows an independently scheduled timer between FIFO whole reads', async () => {
  const observed: number[] = []
  let timerSaw = -1
  const turns = createReadTurns((input: number) => {
    observed.push(input)
    if (input === 1) setTimeout(() => { timerSaw = observed.length }, 0)
    const until = performance.now() + 8
    while (performance.now() < until) { /* synchronous read stand-in */ }
    return input * 2
  })
  const results = await Promise.all([1, 2, 3, 4, 5].map(n => turns.submit(n).result))
  expect(results).toEqual([2, 4, 6, 8, 10])
  expect(observed).toEqual([1, 2, 3, 4, 5])
  expect(timerSaw).toBeGreaterThanOrEqual(1)
  expect(timerSaw).toBeLessThan(5)
})

it('falls back synchronously at sixteen queued reads and preserves the original thrown error', async () => {
  const seen: number[] = []
  const failure = new Error('original domain failure')
  const turns = createReadTurns((n: number) => { seen.push(n); if (n === 99) throw failure; return n })
  const queued = Array.from({ length: 16 }, (_, n) => turns.submit(n))
  expect(seen).toEqual([])
  expect(() => turns.submit(99)).toThrow(failure)
  expect(seen).toEqual([99])
  expect(await turns.submit(17).result).toBe(17)
  expect(seen).toEqual([99, 17])
  expect(await Promise.all(queued.map(q => q.result))).toEqual(Array.from({ length: 16 }, (_, n) => n))
})

it('accounts UTF8 bytes at the exact retained metadata boundary and clones queued options', async () => {
  const seen: string[] = []
  const turns = createReadTurns((input: { q: string }) => { seen.push(input.q); return input.q.length })
  const first = { q: '界'.repeat(21842) + 'aa' } // JSON metadata: 65536 bytes
  const queued = turns.submit(first)
  first.q = 'mutated'
  expect(await turns.submit({ q: 'overflow' }).result).toBe(8)
  expect(seen).toEqual(['overflow'])
  expect(await queued.result).toBe(21844)
  expect(seen[1]).toBe('界'.repeat(21842) + 'aa')
  const tooBig = turns.submit({ q: 'x'.repeat(65529) }) // 65537 bytes
  expect(seen.at(-1)).toHaveLength(65529)
  expect(await tooBig.result).toBe(65529)
})

it('propagates a queued original error and continues serving later reads', async () => {
  const failure = new Error('original read error')
  const turns = createReadTurns((n: number) => { if (n === 1) throw failure; return n })
  const failed = expect(turns.submit(1).result).rejects.toBe(failure)
  const next = turns.submit(2)
  await failed
  expect(await next.result).toBe(2)
})

it('releases cancelled queue count and bytes without executing or inventing an error', async () => {
  const seen: number[] = []
  const turns = createReadTurns((input: { q: string }) => { seen.push(input.q.length); return input.q.length })
  const cancelled = turns.submit({ q: 'x'.repeat(65528) })
  cancelled.cancel(); cancelled.cancel()
  expect(await cancelled.result).toBeUndefined()
  const next = turns.submit({ q: 'next' })
  expect(seen).toEqual([])
  expect(await next.result).toBe(4)
  const many = Array.from({ length: 16 }, () => turns.submit({ q: 'q' }))
  for (const job of many) job.cancel()
  const after = turns.submit({ q: 'after' })
  expect(seen).toEqual([4])
  expect(await after.result).toBe(5)
  expect(seen).toEqual([4, 5])
})

it('shares one turn and sixteen retained slots across different fixed readers', async () => {
  let tick = 0, watching = true
  const ticks: number[] = [], seen: string[] = []
  const observe = () => { tick++; if (watching) setImmediate(observe) }
  setImmediate(observe)
  const a = createReadTurns((n: number) => { ticks.push(tick); seen.push(`a${n}`); return n })
  const b = createReadTurns((n: number) => { ticks.push(tick); seen.push(`b${n}`); return n })
  const queued = Array.from({ length: 16 }, (_, n) => (n % 2 ? b : a).submit(n))
  const overflow = b.submit(99)
  expect(seen).toEqual(['b99'])
  await overflow.result
  await Promise.all(queued.map(q => q.result))
  watching = false
  expect(seen.slice(1)).toEqual(['a0', 'b1', 'a2', 'b3', 'a4', 'b5', 'a6', 'b7', 'a8', 'b9', 'a10', 'b11', 'a12', 'b13', 'a14', 'b15'])
  expect(new Set(ticks.slice(1)).size).toBe(16)
})
