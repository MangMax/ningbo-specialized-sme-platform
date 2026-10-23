import { LOG_LEVELS, type FieldCapturedLogEvent, type LogEvent, type LogFieldControls, type LogFieldControlsPatch, type LogProfileFields } from './contract'

type FieldProfile = {
  [P in keyof LogProfileFields]: {
    readonly key: P
    readonly source: LogEvent['source']
    readonly label: string
    readonly levels: readonly LogEvent['level'][]
    readonly fields: readonly { readonly key: LogProfileFields[P]; readonly label: string; readonly description: string }[]
  }
}[keyof LogProfileFields]

/** Pure profile data, not an activated API catalog. No TUS profile is implemented here. */
export const LOG_FIELD_PROFILES = Object.freeze([
  Object.freeze({
    key: 'http', source: 'http', label: 'HTTP 请求', levels: LOG_LEVELS,
    fields: Object.freeze([
      Object.freeze({ key: 'httpMethod', label: '请求方法', description: '服务端已知的请求方法' }),
      Object.freeze({ key: 'httpRoute', label: '路由模板', description: '框架匹配或应用定义的固定模板' }),
      Object.freeze({ key: 'statusCode', label: '响应状态', description: '响应的 HTTP 状态码' }),
      Object.freeze({ key: 'durationMs', label: '耗时', description: '请求耗时，单位毫秒' }),
    ] as const),
  } as const),
] as const) satisfies readonly FieldProfile[]

/** All helper dependencies are explicit arguments so F02 can serialize them into its worker. */
export function defaultFieldControls(profiles: readonly FieldProfile[]): LogFieldControls {
  const result = {} as LogFieldControls
  for (const profile of profiles) {
    const levels = {} as LogFieldControls[typeof profile.key]
    for (const level of profile.levels) {
      const fields = {} as LogFieldControls[typeof profile.key][typeof level]
      for (const field of profile.fields) fields[field.key] = true
      levels[level] = fields
    }
    result[profile.key] = levels
  }
  return result
}

/** Closed partial profile -> level -> field. Accessors are rejected before any value is read. */
export function validateFieldControlsPatch(value: unknown, profiles: readonly FieldProfile[]): LogFieldControlsPatch {
  const record = (input: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('invalid_log_input')
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!
      if (typeof key !== 'string' || !keys.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('invalid_log_input')
    }
    return input as Record<string, unknown>
  }
  const input = record(value, profiles.map(profile => profile.key))
  const result: LogFieldControlsPatch = {}
  for (const profile of profiles) {
    if (!Object.hasOwn(input, profile.key)) continue
    const levels = record(input[profile.key], profile.levels)
    const cleanLevels: NonNullable<LogFieldControlsPatch[typeof profile.key]> = {}
    for (const level of profile.levels) {
      if (!Object.hasOwn(levels, level)) continue
      const fields = record(levels[level], profile.fields.map(field => field.key))
      const cleanFields: NonNullable<typeof cleanLevels[typeof level]> = {}
      for (const field of profile.fields) {
        if (!Object.hasOwn(fields, field.key)) continue
        const enabled = fields[field.key]
        if (typeof enabled !== 'boolean') throw new Error('invalid_log_input')
        cleanFields[field.key] = enabled
      }
      cleanLevels[level] = cleanFields
    }
    result[profile.key] = cleanLevels
  }
  return result
}

/** Requires a validated patch and a complete effective baseline; does not infer persisted defaults. */
export function mergeFieldControls(base: LogFieldControls, patch: LogFieldControlsPatch, profiles: readonly FieldProfile[]): LogFieldControls {
  const result = {} as LogFieldControls
  for (const profile of profiles) {
    const levels = {} as LogFieldControls[typeof profile.key]
    const changedLevels = Object.hasOwn(patch, profile.key) ? patch[profile.key] : undefined
    for (const level of profile.levels) {
      const fields = {} as LogFieldControls[typeof profile.key][typeof level]
      const changedFields = changedLevels && Object.hasOwn(changedLevels, level) ? changedLevels[level] : undefined
      for (const field of profile.fields) {
        fields[field.key] = changedFields && Object.hasOwn(changedFields, field.key)
          ? changedFields[field.key]!
          : base[profile.key][level][field.key]
      }
      levels[level] = fields
    }
    result[profile.key] = levels
  }
  return result
}

/** Projects an already safe event using complete effective controls. No input or policy is mutated. */
export function projectLogFields(event: LogEvent, controls: LogFieldControls, revision: number, profiles: readonly FieldProfile[]): FieldCapturedLogEvent {
  const profile = profiles.find(candidate => candidate.source === event.source)
  if (!profile) return event
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('invalid_log_input')
  const projected: FieldCapturedLogEvent = { ...event }
  // Rebuild internal facts rather than accepting stale or caller-supplied capture metadata.
  delete projected.fieldCapture
  const disabled: LogProfileFields[typeof profile.key][] = []
  for (const field of profile.fields) {
    if (controls[profile.key][event.level][field.key] !== false) continue
    delete projected[field.key]
    disabled.push(field.key)
  }
  if (disabled.length) projected.fieldCapture = { profile: profile.key, revision, disabled }
  return projected
}
