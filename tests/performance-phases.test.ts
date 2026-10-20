import { expect, it } from 'vitest'
import { setTimeout as sleep } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import { createPerformancePhases } from '../scripts/lib/performance-phases.mjs'

const block = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* deliberate cold work */ } }

it('separates a blocked cold phase from hot observations while retaining the lifetime stall', async () => {
  const meter = createPerformancePhases()
  try {
    await meter.begin('cold')
    await sleep(20)
    meter.measure('serialize', () => block(400))
    const cold = await meter.end('cold')
    expect(cold.loopMaxMs).toBeGreaterThan(250)
    expect(cold.stages.serialize.calls).toBe(1)
    expect(cold.stages.serialize.ms).toBeGreaterThan(250)
    await meter.begin('hot')
    await sleep(80)
    const hot = await meter.end('hot')
    expect(hot.loopMaxMs).toBeLessThan(250)
    expect(hot.lifetimeLoopMaxMs).toBeGreaterThan(250)
    expect(hot.stages).toEqual({})
    expect(hot.loopSamples).toBeGreaterThan(0)
  } finally { meter.close() }
})

it('retains measured values and rejects overlapping or mislabeled phases', async () => {
  const meter = createPerformancePhases()
  try {
    await meter.begin('read')
    await expect(meter.begin('other')).rejects.toThrow('already active')
    await expect(meter.end('other')).rejects.toThrow('does not match')
    const result = { rows: [{ id: 7, raw: '完整🙂' }] }
    expect(meter.measure('materialize', () => result)).toBe(result)
    const read = await meter.end('read')
    expect(read.label).toBe('read')
    expect(read.stages.materialize.calls).toBe(1)
    expect(read.heapDelta).toBeGreaterThanOrEqual(0)
    expect(read.cpuUserMs).toBeGreaterThanOrEqual(0)
  } finally { meter.close() }
})
