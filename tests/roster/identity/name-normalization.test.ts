import { describe, expect, it } from 'vitest'
import { normalizeName } from '../../../layers/sme-roster/lib/domain'

describe('shared name normalization', () => {
  it('NoEvidence_RetainsCityPrefixAndSearchText', () => {
    expect(normalizeName(' 宁波（甲）科技有限公司。 ')).toBe('宁波甲科技有限公司')
    expect(normalizeName('甲科技有限公司')).toBe('甲科技有限公司')
    expect(normalizeName('杭州甲科技有限公司')).toBe('杭州甲科技有限公司')
  })
  it('SameCodeEvidence_AlignsNingboPrefix', () => {
    const evidence = [{ name: '甲有限公司', uscc: 'code-a' }, { name: '宁波甲有限公司', uscc: 'code-a' }]
    expect(normalizeName('甲有限公司', evidence)).toBe('宁波甲有限公司')
  })
  it('ConflictingCodeEvidence_RetainsDistinctSubjects', () => {
    const evidence = [{ name: '甲有限公司', uscc: 'code-a' }, { name: '宁波甲有限公司', uscc: 'code-b' }]
    expect(normalizeName('甲有限公司', evidence)).toBe('甲有限公司')
    expect(normalizeName('宁波甲有限公司', evidence)).toBe('宁波甲有限公司')
  })
  it('ProvenBeizdeAlias_RejectsContradictoryCode', () => {
    expect(normalizeName('贝兹德智能科技有限公司', [
      { name: '贝兹德智能科技有限公司', uscc: 'other-code' },
      { name: '宁波贝兹德智能科技有限公司', uscc: '91330226MA2CL6FP2U' },
    ])).toBe('贝兹德智能科技有限公司')
  })
})
