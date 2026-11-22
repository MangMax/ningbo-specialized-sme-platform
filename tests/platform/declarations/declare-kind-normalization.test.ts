import { expect, it } from 'vitest'
import { normalizePlatformRelation } from '../../../layers/sme-roster/lib/platform/normalization'

const known = [
  { label: 'apply', chinese: '申请', english: 'apply' },
  { label: 'update', chinese: '更新', english: 'update' },
  { label: 'review', chinese: '复核', english: 'review' },
]
const equivalent = known.flatMap(({ label, chinese, english }) => [
  { label: `${label}-stored-chinese`, stored: chinese, raw: english, expected: english },
  { label: `${label}-raw-chinese`, stored: english, raw: chinese, expected: english },
  { label: `${label}-both-chinese`, stored: chinese, raw: chinese, expected: english },
  { label: `${label}-stored-only`, stored: ` ${chinese} `, raw: null, expected: english },
  { label: `${label}-raw-only`, stored: ' ', raw: ` ${chinese} `, expected: english },
])

it.each(['apply_list', 'business_list'])('known declare kinds use the same semantics on both sides for %s', (source) => {
  for (const { label, stored, raw, expected } of equivalent) {
    const rawFields = Object.freeze({ sblx: raw, untouched: '原始留证' })
    const relation = Object.freeze({ declareKind: stored, rawFields, relationKey: 'synthetic-id', sourceFingerprint: 'unchanged' })
    expect(normalizePlatformRelation(source, relation), label).toEqual({ ...relation, province: null, status: null, batch: null, declareKind: expected, appliedAt: null, awardBatchLabel: null, year: null, normalizationConflicts: [] })
    expect(relation.declareKind, label).toBe(stored)
    expect(relation.rawFields.sblx, label).toBe(raw)
  }
})

it.each([
  { label: 'new-kind', value: '新事项' },
  { label: 'proto-key', value: '__proto__' },
  { label: 'constructor-key', value: 'constructor' },
  { label: 'to-string-key', value: 'toString' },
  { label: 'own-property-key', value: 'hasOwnProperty' },
  { label: 'unmapped-case', value: 'APPLY' },
])('unknown declare kinds remain literal without prototype lookup: $label', ({ value }) => {
  for (const source of ['apply_list', 'business_list']) {
    for (const [stored, raw] of [[value, value], [value, null], [null, value]]) {
      expect(normalizePlatformRelation(source, { declareKind: stored, rawFields: { sblx: raw } })).toMatchObject({ declareKind: value, normalizationConflicts: [] })
    }
    expect(normalizePlatformRelation(source, { declareKind: value, rawFields: { sblx: '申请' } })).toMatchObject({ declareKind: null, normalizationConflicts: [{ field: 'declareKind', storedValue: value, rawValue: 'apply' }] })
    expect(normalizePlatformRelation(source, { declareKind: '申请', rawFields: { sblx: value } })).toMatchObject({ declareKind: null, normalizationConflicts: [{ field: 'declareKind', storedValue: 'apply', rawValue: value }] })
  }
})

it.each([
  { label: 'apply-versus-update', stored: '申请', raw: 'update', expectedStored: 'apply', expectedRaw: 'update' },
  { label: 'update-versus-review', stored: '更新', raw: '复核', expectedStored: 'update', expectedRaw: 'review' },
  { label: 'review-versus-apply', stored: 'review', raw: '申请', expectedStored: 'review', expectedRaw: 'apply' },
])('different nonempty process kinds remain unavailable with explicit conflicts: $label', ({ stored, raw, expectedStored, expectedRaw }) => {
  for (const source of ['apply_list', 'business_list']) {
    expect(normalizePlatformRelation(source, { declareKind: stored, status: '终审通过', rawFields: { sblx: raw, cszt: '已退回' } })).toMatchObject({ declareKind: null, status: null, normalizationConflicts: [{ field: 'status', storedValue: '终审通过', rawValue: '已退回' }, { field: 'declareKind', storedValue: expectedStored, rawValue: expectedRaw }] })
  }
})

it('recognized snapshots retain stored meaning and never borrow process-like raw keys', () => {
  for (const { chinese, english } of known) {
    expect(normalizePlatformRelation('recognized_list', { declareKind: chinese, rawFields: { sblx: english } })).toMatchObject({ declareKind: chinese, normalizationConflicts: [] })
    expect(normalizePlatformRelation('recognized_list', { rawFields: { sblx: chinese, cszt: '终审通过', year: '2025' } })).toMatchObject({ declareKind: null, status: null, year: null, normalizationConflicts: [] })
  }
})
