import { expect, expectTypeOf, it } from 'vitest'
import { LOG_LEVELS, LOG_SOURCES, type LogEvent, type LogFieldControlsPatch, type LogInput } from '../lib/logging/contract'
import { LOG_FIELD_PROFILES, defaultFieldControls, validateFieldControlsPatch, mergeFieldControls, projectLogFields } from '../lib/logging/field-controls'

const fields = ['httpMethod', 'httpRoute', 'statusCode', 'durationMs'] as const
function event(level: LogEvent['level'] = 'info'): LogEvent {
  return {
    id: 'event-1', timestamp: '2026-10-23T00:00:00.000Z', source: 'http', operation: 'http.request', level,
    outcome: 'failure', errorCode: 'HTTP_500', httpMethod: 'POST', httpRoute: '/api/items/:id', statusCode: 500, durationMs: 0,
    counts: { done: 0, total: 0, failed: 0, dropped: 0 }, origin: { runtime: 'node', integration: 'nuxt-nitro', capture: 'framework' },
    requestId: 'request-1', traceId: 'trace-1', taskId: 'task-1', fileId: 0, page: 0, batchId: 0, resourceType: 'item',
    resourceId: 0, auditId: 0, receiptId: 0, parentEventId: 'parent-1', untrustedRelatedRequestId: 'claim-1',
  }
}
function controls(patch: LogFieldControlsPatch) {
  return mergeFieldControls(defaultFieldControls(LOG_FIELD_PROFILES), validateFieldControlsPatch(patch, LOG_FIELD_PROFILES), LOG_FIELD_PROFILES)
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

it('catalog exposes HTTP and TUS and defaults enable every declared level and field', () => {
  expect(LOG_FIELD_PROFILES.map(p => p.key)).toEqual(['http', 'tus'])
  expect(LOG_FIELD_PROFILES[0].source).toBe('http')
  expect(LOG_FIELD_PROFILES[0].levels).toEqual(LOG_LEVELS)
  expect(LOG_FIELD_PROFILES[0].fields.map(f => f.key)).toEqual(fields)
  const defaults = defaultFieldControls(LOG_FIELD_PROFILES)
  expect(Object.keys(defaults)).toEqual(['http', 'tus'])
  expect(Object.keys(defaults.http)).toEqual(LOG_LEVELS)
  for (const level of LOG_LEVELS) expect(defaults.http[level]).toEqual({ httpMethod: true, httpRoute: true, statusCode: true, durationMs: true })
  defaults.http.info.httpRoute = false
  expect(defaultFieldControls(LOG_FIELD_PROFILES).http.info.httpRoute).toBe(true)
  expectTypeOf<'fieldCapture' extends keyof LogInput ? true : false>().toEqualTypeOf<false>()
})

for (const level of LOG_LEVELS) {
  for (const field of fields) {
    it(`HTTP ${level} disables only ${field} and preserves other levels`, () => {
      const policy = controls({ http: { [level]: { [field]: false } } })
      const input = freeze(event(level))
      const expected = { ...input }
      delete expected[field]
      expect(projectLogFields(input, policy, 17, LOG_FIELD_PROFILES)).toEqual({ ...expected, fieldCapture: { profile: 'http', revision: 17, disabled: [field] } })
      expect(Object.hasOwn(projectLogFields(input, policy, 17, LOG_FIELD_PROFILES), field)).toBe(false)
      for (const other of LOG_LEVELS.filter(v => v !== level)) {
        expect(projectLogFields(event(other), policy, 17, LOG_FIELD_PROFILES)).toEqual(event(other))
      }
      expect(input).toEqual(event(level))
    })
  }
  it(`HTTP ${level} disables all optional fields and retains result and correlation facts`, () => {
    const policy = freeze(controls({ http: { [level]: { httpMethod: false, httpRoute: false, statusCode: false, durationMs: false } } }))
    const input = freeze(event(level))
    const { httpMethod: _method, httpRoute: _route, statusCode: _status, durationMs: _duration, ...facts } = input
    expect(projectLogFields(input, policy, 0, LOG_FIELD_PROFILES)).toEqual({ ...facts, fieldCapture: { profile: 'http', revision: 0, disabled: [...fields] } })
    expect(input).toEqual(event(level))
  })
  it(`HTTP ${level} capture states disabled preferences even when source fields are absent`, () => {
    const input: LogEvent = { id: 'missing-1', timestamp: '2026-10-23T00:00:00.000Z', source: 'http', operation: 'http.request', outcome: 'unknown', level }
    expect(projectLogFields(input, controls({ http: { [level]: { httpMethod: false, statusCode: false } } }), 9, LOG_FIELD_PROFILES)).toEqual({ ...input, fieldCapture: { profile: 'http', revision: 9, disabled: ['httpMethod', 'statusCode'] } })
  })
  it(`HTTP ${level} defaults preserve the event without capture metadata`, () => {
    expect(projectLogFields(freeze(event(level)), freeze(defaultFieldControls(LOG_FIELD_PROFILES)), 5, LOG_FIELD_PROFILES)).toEqual(event(level))
  })
}
for (const source of LOG_SOURCES.filter(v => v !== 'http')) {
  it(`source ${source} retains HTTP shaped fields without capture metadata`, () => {
    const input = freeze({ ...event(), source })
    expect(projectLogFields(input, controls({ http: { info: { httpMethod: false, httpRoute: false, statusCode: false, durationMs: false } } }), 1, LOG_FIELD_PROFILES)).toEqual(input)
  })
}
it('partial merge preserves omitted false preferences and supports explicit restoration without mutation', () => {
  const baseline = freeze(controls({ http: { info: { httpRoute: false }, error: { statusCode: false } } }))
  const patch = freeze(validateFieldControlsPatch({ http: { info: { durationMs: false } } }, LOG_FIELD_PROFILES))
  const merged = mergeFieldControls(baseline, patch, LOG_FIELD_PROFILES)
  expect(merged.http.info).toEqual({ httpMethod: true, httpRoute: false, statusCode: true, durationMs: false })
  expect(merged.http.error).toEqual({ httpMethod: true, httpRoute: true, statusCode: false, durationMs: true })
  const restored = mergeFieldControls(merged, validateFieldControlsPatch({ http: { info: { httpRoute: true } } }, LOG_FIELD_PROFILES), LOG_FIELD_PROFILES)
  expect(restored.http.info).toEqual({ httpMethod: true, httpRoute: true, statusCode: true, durationMs: false })
  expect(baseline.http.info.durationMs).toBe(true)
  expect(merged.http.info.httpRoute).toBe(false)
  expect(patch).toEqual({ http: { info: { durationMs: false } } })
})
for (const [name, partial] of [['root', {}], ['profile', { http: {} }], ['level', { http: { info: {} } }]] as const) {
  it(`empty partial at ${name} preserves existing preferences`, () => {
    const baseline = freeze(controls({ http: { info: { httpRoute: false } } }))
    expect(mergeFieldControls(baseline, validateFieldControlsPatch(partial, LOG_FIELD_PROFILES), LOG_FIELD_PROFILES)).toEqual(baseline)
  })
}
it('validator copies only own whitelisted boolean data and accepts null prototype dictionaries', () => {
  const leaf = Object.assign(Object.create(null), { httpRoute: false })
  const partial = Object.assign(Object.create(null), { http: Object.assign(Object.create(null), { info: leaf }) })
  const validated = validateFieldControlsPatch(partial, LOG_FIELD_PROFILES)
  expect(validated).toEqual({ http: { info: { httpRoute: false } } })
  leaf.httpRoute = true
  expect(validated).toEqual({ http: { info: { httpRoute: false } } })
})
const invalid: { name: string; value: unknown }[] = [
  { name: 'unknown profile', value: { future: {} } },
  { name: 'unknown level', value: { http: { fatal: {} } } },
  { name: 'unknown field', value: { http: { info: { body: false } } } },
  ...[null, [], 'bad', 0, true, new Date()].flatMap((value, i) => [
    { name: `root kind ${i}`, value }, { name: `profile kind ${i}`, value: { http: value } },
    { name: `level kind ${i}`, value: { http: { info: value } } },
  ]),
  ...[null, [], {}, 'false', 0, undefined].map((value, i) => ({ name: `leaf kind ${i}`, value: { http: { info: { httpRoute: value } } } })),
]
for (const key of ['__proto__', 'constructor', 'prototype']) {
  const bad = JSON.parse(`{"${key}":false}`)
  invalid.push({ name: `root reserved ${key}`, value: bad }, { name: `profile reserved ${key}`, value: { http: bad } }, { name: `level reserved ${key}`, value: { http: { info: bad } } })
}
for (const [name, wrap] of [
  ['root', (v: unknown) => v], ['profile', (v: unknown) => ({ http: v })], ['level', (v: unknown) => ({ http: { info: v } })],
] as const) {
  invalid.push({ name: `${name} inherited properties`, value: wrap(Object.create({ httpRoute: false })) })
  invalid.push({ name: `${name} symbol key`, value: wrap({ [Symbol('hidden')]: false }) })
  invalid.push({ name: `${name} nonenumerable key`, value: wrap(Object.defineProperty({}, 'hidden', { value: false })) })
}
for (const entry of invalid) {
  it(`validator rejects ${entry.name}`, () => {
    expect(() => validateFieldControlsPatch(entry.value, LOG_FIELD_PROFILES)).toThrow('invalid_log_input')
  })
}
it('validator rejects accessors without invoking them at any nesting level', () => {
  let reads = 0
  for (const [key, wrap] of [
    ['http', (v: unknown) => v], ['info', (v: unknown) => ({ http: v })], ['httpRoute', (v: unknown) => ({ http: { info: v } })],
  ] as const) {
    const accessor = Object.defineProperty({}, key, { enumerable: true, get() { reads++; return false } })
    expect(() => validateFieldControlsPatch(wrap(accessor), LOG_FIELD_PROFILES)).toThrow('invalid_log_input')
  }
  expect(reads).toBe(0)
})
it('helpers execute with only explicitly injected data after serialization', () => {
  const defaults = new Function(`return (${defaultFieldControls.toString()})`)() as typeof defaultFieldControls
  const validate = new Function(`return (${validateFieldControlsPatch.toString()})`)() as typeof validateFieldControlsPatch
  const merge = new Function(`return (${mergeFieldControls.toString()})`)() as typeof mergeFieldControls
  const project = new Function(`return (${projectLogFields.toString()})`)() as typeof projectLogFields
  const profiles = JSON.parse(JSON.stringify(LOG_FIELD_PROFILES)) as typeof LOG_FIELD_PROFILES
  const policy = merge(defaults(profiles), validate({ http: { info: { statusCode: false } } }, profiles), profiles)
  const expected = event()
  delete expected.statusCode
  expect(project(event(), policy, 11, profiles)).toEqual({ ...expected, fieldCapture: { profile: 'http', revision: 11, disabled: ['statusCode'] } })
})

it('HTTP projection rebuilds capture from current controls and ignores supplied capture facts', () => {
  const input = freeze({ ...event(), fieldCapture: { profile: 'http', revision: 99, disabled: ['httpRoute'], originalValue: 'untrusted' } })
  expect(projectLogFields(input, defaultFieldControls(LOG_FIELD_PROFILES), 1, LOG_FIELD_PROFILES)).toEqual(event())
  const expected = event()
  delete expected.statusCode
  expect(projectLogFields(input, controls({ http: { info: { statusCode: false } } }), 2, LOG_FIELD_PROFILES)).toEqual({ ...expected, fieldCapture: { profile: 'http', revision: 2, disabled: ['statusCode'] } })
  expect(input.fieldCapture.revision).toBe(99)
})
for (const [name, revision] of [['negative', -1], ['fractional', 1.5], ['not finite', Infinity], ['not numeric', NaN], ['unsafe integer', Number.MAX_SAFE_INTEGER + 1]] as const) {
  it(`HTTP capture rejects ${name} revision`, () => {
    expect(() => projectLogFields(event(), controls({ http: { info: { httpRoute: false } } }), revision, LOG_FIELD_PROFILES)).toThrow('invalid_log_input')
  })
}
it('validator rejects unsafe unknown key data while keeping report names printable', () => {
  expect(() => validateFieldControlsPatch({ http: { info: { ['body\u0000\ud800']: false } } }, LOG_FIELD_PROFILES)).toThrow('invalid_log_input')
})
