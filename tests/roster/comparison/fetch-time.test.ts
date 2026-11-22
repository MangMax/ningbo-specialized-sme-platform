import { describe, expect, it } from 'vitest'
import { formatFetchTime } from '../../../layers/sme-roster/lib/reconcile-time'

describe('取数时间展示', () => {
  it('格式化为 YYYY-MM-DD HH:mm，缺失或非法值保留 null', () => {
    expect(formatFetchTime('2026-10-14T09:38:40.313Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(formatFetchTime(null)).toBeNull()
    expect(formatFetchTime('nope')).toBeNull()
  })
})
