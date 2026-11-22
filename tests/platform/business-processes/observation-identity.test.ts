import { expect, it } from 'vitest'
import { canonicalPlatformJson, planPlatformObservation } from '../../../layers/sme-roster/lib/platform/observation-plan'
it('canonicalizes nested JSON objects only and preserves every JSON value partition', () => {
  expect(canonicalPlatformJson({ z: [{ b: true, a: null }], a: '' })).toBe('{"a":"","z":[{"a":null,"b":true}]}')
  const values = [null, false, 0, '', '0', [], {}, { a: null }, { a: false }, { a: 0 }, { a: '' }, [1, 2], [2, 1]]
  expect(new Set(values.map(canonicalPlatformJson)).size).toBe(values.length)
  for (const value of [undefined, NaN, Infinity, () => 1, { a: undefined }, [undefined], new Date()]) expect(() => canonicalPlatformJson(value)).toThrow('platform_raw_not_json')
})

it('uses case-sensitive interface keys without numeric or name identity guesses', () => {
  expect(planPlatformObservation({ interface: 'recognized_list', relationKey: null, rawFields: { id: '550e8400-e29b-41d4-a716-446655440000' } })).toMatchObject({ platformKey: '550e8400-e29b-41d4-a716-446655440000', identityState: 'resolved', keySource: 'raw_id' })
  for (const id of [null, 42, {}, [], ' ', false]) expect(planPlatformObservation({ interface: 'business_list', relationKey: null, rawFields: { id, qymc: 'same', tyshxydm: 'same' } })).toMatchObject({ platformKey: null, canonicalRawJson: null, identityState: 'missing_key' })
  expect(planPlatformObservation({ interface: 'apply_list', relationKey: 'SQ1', rawFields: { id: 'sq1' } })).toMatchObject({ identityState: 'conflict', canonicalRawJson: null })
  expect(planPlatformObservation({ interface: 'apply_list', relationKey: '  001  ', rawFields: { id: '001', unknown: 1 } })).toMatchObject({ platformKey: '001', identityState: 'resolved', keySource: 'both' })
})
