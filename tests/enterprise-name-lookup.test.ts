import { describe, expect, it, vi } from 'vitest'
import {
  ENTERPRISE_NAME_PAGE_LIMIT,
  lookupEnterpriseNames,
} from '../lib/roster/enterprise-name-lookup'

describe('bounded enterprise name lookup', () => {
  it('deduplicates and caps the page at 25 IDs', async () => {
    const fetchName = vi.fn(async (id: number) => `企业 ${id}`)
    const ids = [1, 1, 2, ...Array.from({ length: 30 }, (_, index) => index + 3)]
    const result = await lookupEnterpriseNames(ids, { fetchName, concurrency: 4 })
    expect(fetchName).toHaveBeenCalledTimes(ENTERPRISE_NAME_PAGE_LIMIT)
    expect(result.names.size).toBe(ENTERPRISE_NAME_PAGE_LIMIT)
    expect(new Set(fetchName.mock.calls.map(call => call[0])).size).toBe(ENTERPRISE_NAME_PAGE_LIMIT)
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
