import { expect, expectTypeOf, it } from 'vitest'
import { LOG_LEVELS, type LogInput, type LogEvent, type LogFieldControlsPatch, type FieldCapturedLogEvent } from '../lib/logging/contract'
import { LOG_FIELD_PROFILES, defaultFieldControls, mergeFieldControls, validateFieldControlsPatch, projectLogFields } from '../lib/logging/field-controls'
import { safeLogEvent, safeTusContext } from '../lib/logging/privacy'

const fields = ['tus.method', 'tus.uploadId', 'tus.size', 'tus.offset'] as const
const input = (level: LogEvent['level'] = 'info') => safeLogEvent({ source: 'file', operation: 'file.upload', level, outcome: 'success', origin: { runtime: 'node', integration: 'tus', capture: 'hook' }, tus: { uploadId: 'a'.repeat(32), phase: 'completed', method: 'PATCH', size: 8, offset: 0 }, statusCode: 204, durationMs: 0, errorCode: 'known_code', counts: { done: 0 }, requestId: 'req-tus' })
function controls(patch: unknown) { return mergeFieldControls(defaultFieldControls(LOG_FIELD_PROFILES), validateFieldControlsPatch(patch, LOG_FIELD_PROFILES), LOG_FIELD_PROFILES) }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }

it('TUS catalog contains exactly implemented HTTP and TUS closed fields with full defaults', () => {
  expect(LOG_FIELD_PROFILES.map(p => p.key)).toEqual(['http', 'tus'])
  const profile = LOG_FIELD_PROFILES.find(p => String(p.key) === 'tus')!
  expect(profile.source).toBe('file'); expect(profile.levels).toEqual(LOG_LEVELS); expect(profile.fields.map(f => f.key)).toEqual(fields)
  const defaults = defaultFieldControls(LOG_FIELD_PROFILES) as any
  for (const level of LOG_LEVELS) expect(defaults.tus[level]).toEqual(Object.fromEntries(fields.map(f => [f, true])))
  expectTypeOf<'fieldCapture' extends keyof LogInput ? true : false>().toEqualTypeOf<false>()
  expectTypeOf<NonNullable<FieldCapturedLogEvent['tus']>['uploadId']>().toEqualTypeOf<string | undefined>()
  // @ts-expect-error Strict producer input still requires uploadId, output is not producer input.
  const invalidInput: LogInput = { source: 'file', operation: 'file.upload', outcome: 'success', tus: { phase: 'completed' } }
  expect(invalidInput.tus!.uploadId).toBeUndefined()
})
for (const level of LOG_LEVELS) {
  for (const field of fields) it(`TUS ${level} disables only ${field} without mutating validated input`, () => {
    const original = freeze(input(level)), before = JSON.stringify(original)
    const policy = controls({ tus: { [level]: { [field]: false } } })
    const projected = projectLogFields(original, policy, 7, LOG_FIELD_PROFILES)
    const expected: any = { ...original, tus: { ...original.tus }, fieldCapture: { profile: 'tus', revision: 7, disabled: [field] } }
    delete expected.tus[field.slice(4)]
    expect(projected).toEqual(expected); expect(projected.tus).not.toBe(original.tus); expect(JSON.stringify(original)).toBe(before)
    expect(projected.tus!.phase).toBe('completed'); expect(projected).toMatchObject({ id: original.id, timestamp: original.timestamp, statusCode: 204, durationMs: 0, counts: { done: 0 } })
    for (const other of LOG_LEVELS.filter(l => l !== level)) expect((policy as any).tus[other]).toEqual(Object.fromEntries(fields.map(f => [f, true])))
  })
  it(`TUS ${level} all disabled retains phase and event facts while defaults clone without capture`, () => {
    const original = freeze(input(level))
    const all = projectLogFields(original, controls({ tus: { [level]: Object.fromEntries(fields.map(f => [f, false])) } }), 9, LOG_FIELD_PROFILES)
    expect(all).toEqual({ ...original, tus: { phase: 'completed' }, fieldCapture: { profile: 'tus', revision: 9, disabled: [...fields] } })
    const defaults = projectLogFields(original, defaultFieldControls(LOG_FIELD_PROFILES), 9, LOG_FIELD_PROFILES)
    expect(defaults).toEqual(original); expect(defaults).not.toHaveProperty('fieldCapture'); expect(defaults.tus).not.toBe(original.tus)
  })
}
for (const excluded of ['client', 'tus-client', 'other operation', 'no tus', 'invalid id', 'path only'] as const) it(`TUS exact match excludes ${excluded}`, () => {
  const candidate: any = { ...input(), tus: { ...input().tus } }
  if (excluded === 'client') candidate.source = 'client'
  if (excluded === 'tus-client') candidate.origin = { ...candidate.origin, integration: 'tus-client' }
  if (excluded === 'other operation') candidate.operation = 'file.register'
  if (excluded === 'no tus') delete candidate.tus
  if (excluded === 'invalid id') candidate.tus.uploadId = 'not-generated'
  if (excluded === 'path only') { delete candidate.tus; candidate.httpRoute = '/api/uploads/:id' }
  const result = projectLogFields(candidate, controls({ tus: { info: Object.fromEntries(fields.map(f => [f, false])) } }), 2, LOG_FIELD_PROFILES)
  expect(result).toEqual(candidate); expect(result).not.toHaveProperty('fieldCapture')
})
it('TUS missing optional originals still captures disabled preferences and strict input strips forged capture', () => {
  const original = safeLogEvent({ source: 'file', operation: 'file.upload', outcome: 'started', origin: { runtime: 'node', integration: 'tus', capture: 'hook' }, tus: { uploadId: 'b'.repeat(32), phase: 'created' }, fieldCapture: { profile: 'tus', revision: 999, disabled: [] } } as any)
  expect(original).not.toHaveProperty('fieldCapture')
  expect(projectLogFields(original, controls({ tus: { info: Object.fromEntries(fields.map(f => [f, false])) } }), 3, LOG_FIELD_PROFILES)).toEqual({ ...original, tus: { phase: 'created' }, fieldCapture: { profile: 'tus', revision: 3, disabled: [...fields] } })
  for (const uploadId of [undefined, '', 'a'.repeat(31), 'A'.repeat(32), 'z'.repeat(32)]) {
    expect(safeTusContext({ uploadId, phase: 'created' })).toBeUndefined()
    const safe = safeLogEvent({ ...original, tus: { uploadId, phase: 'created' } } as any)
    expect(safe.tus).toBeUndefined(); expect(projectLogFields(safe, controls({ tus: { info: { 'tus.uploadId': false } } }), 1, LOG_FIELD_PROFILES)).not.toHaveProperty('fieldCapture')
  }
})
it('TUS reauthorization from original restores uploadId and rebuilds capture without altering output copies', () => {
  const original = freeze(input())
  const first = projectLogFields(original, controls({ tus: { info: { 'tus.uploadId': false } } }), 1, LOG_FIELD_PROFILES)
  expect(first.tus).not.toHaveProperty('uploadId')
  const latest = projectLogFields(original, controls({ tus: { info: { 'tus.method': false } } }), 2, LOG_FIELD_PROFILES)
  expect(latest.tus!.uploadId).toBe(original.tus!.uploadId); expect(latest.tus).not.toHaveProperty('method')
  expect(latest.fieldCapture).toEqual({ profile: 'tus', revision: 2, disabled: ['tus.method'] }); expect(first.tus).not.toHaveProperty('uploadId')
  const serialized = new Function(`return (${projectLogFields.toString()})`)() as typeof projectLogFields
  expect(serialized(original, controls({ tus: { info: { 'tus.uploadId': false } } }), 1, JSON.parse(JSON.stringify(LOG_FIELD_PROFILES)))).toEqual(first)
})
