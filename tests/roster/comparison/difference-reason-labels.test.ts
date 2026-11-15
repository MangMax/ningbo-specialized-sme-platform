import { describe, expect, it } from 'vitest'
import { DIFFERENCE_REASONS } from '../../../lib/labels'

describe('差异原因名称', () => {
  it('与台账视觉基线使用「已更名」', () => {
    expect(DIFFERENCE_REASONS.renamed).toBe('已更名')
  })
})
