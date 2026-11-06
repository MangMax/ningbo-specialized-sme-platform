import { describe, expect, it, vi } from 'vitest'
import {
  lookupEnterpriseNames,
} from '../lib/roster/enterprise-name-lookup'

describe('bounded enterprise name lookup', () => {
  it('deduplicates and caps the page at 25 IDs', async () => {
    const fetchName = vi.fn(async (id: number) => `企业 ${id}`)
    const ids = [1, 1, 2, ...Array.from({ length: 30 }, (_, index) => index + 3)]
    const result = await lookupEnterpriseNames(ids, { fetchName, concurrency: 4 })
    expect(fetchName).toHaveBeenCalledTimes(25)
    expect(result.names.size).toBe(25)
    expect.soft(fetchName.mock.calls.map(call => call[0])).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
      14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
    ])
    expect.soft([...result.names]).toEqual([
      [1, '企业 1'],
      [2, '企业 2'],
      [3, '企业 3'],
      [4, '企业 4'],
      [5, '企业 5'],
      [6, '企业 6'],
      [7, '企业 7'],
      [8, '企业 8'],
      [9, '企业 9'],
      [10, '企业 10'],
      [11, '企业 11'],
      [12, '企业 12'],
      [13, '企业 13'],
      [14, '企业 14'],
      [15, '企业 15'],
      [16, '企业 16'],
      [17, '企业 17'],
      [18, '企业 18'],
      [19, '企业 19'],
      [20, '企业 20'],
      [21, '企业 21'],
      [22, '企业 22'],
      [23, '企业 23'],
      [24, '企业 24'],
      [25, '企业 25'],
    ])
    expect(result.failed).toEqual(new Set())
    expect(result.aborted).toBe(false)
  })

  it('bounds concurrency and reuses a bounded cache', async () => {
    let active = 0
    let peak = 0
    const cache = new Map<number, string>([[9, '缓存企业']])
    const fetchName = vi.fn(async (id: number) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 1))
      active -= 1
      return `企业 ${id}`
    })
    const first = await lookupEnterpriseNames([1, 2, 3, 4, 5, 9], { fetchName, cache, concurrency: 2 })
    expect(peak).toBeLessThanOrEqual(2)
    expect(fetchName.mock.calls.some(call => call[0] === 9)).toBe(false)
    expect(first.names.get(9)).toBe('缓存企业')
    expect(cache.get(1)).toBe('企业 1')
    const second = await lookupEnterpriseNames([1, 2, 9], { fetchName, cache, concurrency: 2 })
    expect(fetchName).toHaveBeenCalledTimes(5)
    expect(second.names.get(1)).toBe('企业 1')
    expect(second.names.get(9)).toBe('缓存企业')
  })

  it('drops stale-page results and reports failures without inventing names', async () => {
    let current = true
    const fetchName = vi.fn(async (id: number) => {
      current = false
      if (id === 2) throw new Error('profile unavailable')
      return `企业 ${id}`
    })
    const result = await lookupEnterpriseNames([1, 2], {
      fetchName,
      concurrency: 1,
      isCurrent: () => current,
    })
    expect(result.aborted).toBe(true)
    expect(result.names.size).toBe(0)
    expect(result.failed.size).toBe(0)
  })

  it('marks an unreadable profile as failed instead of treating the ID as a name', async () => {
    const result = await lookupEnterpriseNames([4, 5], {
      fetchName: async id => { if (id === 5) throw new Error('404'); return '企业 4' },
    })
    expect(result.names.get(4)).toBe('企业 4')
    expect(result.failed.has(5)).toBe(true)
    expect(result.names.has(5)).toBe(false)
  })
})
