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

/** Only implemented collection profiles. Nested field keys are closed policy keys, not input paths. */
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
  Object.freeze({
    key: 'tus', source: 'file', label: 'TUS 上传', levels: LOG_LEVELS,
    fields: Object.freeze([
      Object.freeze({ key: 'tus.method', label: '上传请求方法', description: '真实服务端 TUS 回调观察的方法' }),
      Object.freeze({ key: 'tus.uploadId', label: '上传标识', description: '服务端生成并通过输入清洗的上传标识' }),
      Object.freeze({ key: 'tus.size', label: '声明大小', description: 'TUS 库已知的声明字节数' }),
      Object.freeze({ key: 'tus.offset', label: '已接收字节', description: 'TUS 回调报告的实际接收字节数' }),
    ] as const),
  } as const),
] as const) satisfies readonly FieldProfile[]

type ControlMap = Record<string, Record<string, Record<string, boolean>>>

/** All helper dependencies are explicit arguments so F02 can serialize them into its worker. */
export function defaultFieldControls(profiles: readonly FieldProfile[]): LogFieldControls {
  const result: ControlMap = {}
  for (const profile of profiles) {
    const levels: Record<string, Record<string, boolean>> = {}
    for (const level of profile.levels) {
      const fields: Record<string, boolean> = {}
      for (const field of profile.fields) fields[field.key] = true
      levels[level] = fields
    }
    result[profile.key] = levels
  }
  return result as LogFieldControls
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
  const result: ControlMap = {}
  for (const profile of profiles) {
    if (!Object.hasOwn(input, profile.key)) continue
    const levels = record(input[profile.key], profile.levels)
    const cleanLevels: Record<string, Record<string, boolean>> = {}
    for (const level of profile.levels) {
      if (!Object.hasOwn(levels, level)) continue
      const fields = record(levels[level], profile.fields.map(field => field.key))
      const cleanFields: Record<string, boolean> = {}
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
  return result as LogFieldControlsPatch
}

/** Requires a validated patch and a complete effective baseline; does not infer persisted defaults. */
export function mergeFieldControls(base: LogFieldControls, patch: LogFieldControlsPatch, profiles: readonly FieldProfile[]): LogFieldControls {
  const result: ControlMap = {}
  for (const profile of profiles) {
    const levels: Record<string, Record<string, boolean>> = {}
    const changedLevels = Object.hasOwn(patch, profile.key) ? (patch as ControlMap)[profile.key] : undefined
    for (const level of profile.levels) {
      const fields: Record<string, boolean> = {}
      const changedFields = changedLevels && Object.hasOwn(changedLevels, level) ? changedLevels[level] : undefined
      for (const field of profile.fields) {
        fields[field.key] = changedFields && Object.hasOwn(changedFields, field.key)
          ? changedFields[field.key]!
          : (base as ControlMap)[profile.key]![level]![field.key]!
      }
      levels[level] = fields
    }
    result[profile.key] = levels
  }
  return result as LogFieldControls
}

/** Projects an already safe event using complete effective controls. No input or policy is mutated. */
export function projectLogFields(event: LogEvent, controls: LogFieldControls, revision: number, profiles: readonly FieldProfile[]): FieldCapturedLogEvent {
  // Match against ORIGINAL validated input, never a previous projection whose id may be absent.
  const profile = profiles.find(candidate => candidate.key === 'http' ? event.source === 'http'
    : event.source === 'file' && event.operation === 'file.upload' && event.origin?.integration === 'tus'
      && !!event.tus && /^[a-f0-9]{32}$/.test(event.tus.uploadId)
      && ['created', 'completed', 'request-failed'].includes(event.tus.phase))
  if (!profile) return event
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('invalid_log_input')
  const projected: FieldCapturedLogEvent = { ...event }
  delete projected.fieldCapture
  const rules = (controls as ControlMap)[profile.key]![event.level]!
  if (profile.key === 'http') {
    const disabled = profile.fields.filter(field => rules[field.key] === false).map(field => field.key)
    for (const field of disabled) delete projected[field]
    if (disabled.length) projected.fieldCapture = { profile: 'http', revision, disabled }
  } else {
    projected.tus = { ...event.tus! }
    const disabled = profile.fields.filter(field => rules[field.key] === false).map(field => field.key)
    for (const field of disabled) delete projected.tus[field.slice(4) as 'method' | 'uploadId' | 'size' | 'offset']
    if (disabled.length) projected.fieldCapture = { profile: 'tus', revision, disabled }
  }
  return projected
}

/** Persisted version-specific controls must be complete. Partial validation never supplies defaults to damaged state. */
export function validateCompleteFieldControls(value: unknown, profiles: readonly FieldProfile[], validate: typeof validateFieldControlsPatch): LogFieldControls {
  const clean = validate(value, profiles)
  for (const profile of profiles) {
    const levels = clean[profile.key]
    if (!levels) throw new Error('invalid_log_policy')
    for (const level of profile.levels) {
      const fields = (levels as Record<string, Record<string, boolean>>)[level]
      if (!fields) throw new Error('invalid_log_policy')
      for (const field of profile.fields) if (!Object.hasOwn(fields, field.key)) throw new Error('invalid_log_policy')
    }
  }
  return clean as LogFieldControls
}
