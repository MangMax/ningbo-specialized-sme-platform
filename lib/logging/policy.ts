import type { defaultFieldControls } from './field-controls'
import { LOG_LEVELS, LOG_SOURCES, LOG_SUPPORTED_INTEGRATIONS, type LogCollection, type LogEvent, type LogPolicyPatch, type LogFieldControls } from './contract'

export function defaultLogCollection(): LogCollection {
  return {
    sources: Object.fromEntries(LOG_SOURCES.map(key => [key, { enabled: true, minLevel: 'debug' }])) as LogCollection['sources'],
    integrations: Object.fromEntries(LOG_SUPPORTED_INTEGRATIONS.map(key => [key, { enabled: true, minLevel: 'debug' }])) as LogCollection['integrations'],
  }
}
/** Strict own-key projection. Never spread untrusted dictionaries into policy. */
export function validateCollection(value: unknown): NonNullable<LogPolicyPatch['collection']> {
  return validateCollectionWithCatalog(value, LOG_SOURCES, LOG_SUPPORTED_INTEGRATIONS, LOG_LEVELS)
}
/** Explicit catalog arguments keep the serialized validator free of imported bindings. */
export function validateCollectionWithCatalog(value: unknown, sources: typeof LOG_SOURCES, integrations: typeof LOG_SUPPORTED_INTEGRATIONS, levels: typeof LOG_LEVELS): NonNullable<LogPolicyPatch['collection']> {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v))
  if (!object(value) || Object.keys(value).some(key => key !== 'sources' && key !== 'integrations')) throw new Error('invalid_log_input')
  const result: Record<string, Record<string, unknown>> = {}
  for (const [dimension, keys] of [['sources', sources], ['integrations', integrations]] as const) {
    if (!Object.hasOwn(value, dimension)) continue
    const rules = value[dimension]
    if (!object(rules)) throw new Error('invalid_log_input')
    const clean: Record<string, unknown> = {}
    for (const key of Object.keys(rules)) {
      if (!(keys as readonly string[]).includes(key)) throw new Error('invalid_log_input')
      const rule = rules[key]
      if (!object(rule) || Object.keys(rule).length !== 2 || !Object.hasOwn(rule, 'enabled') || !Object.hasOwn(rule, 'minLevel') || typeof rule.enabled !== 'boolean' || !levels.includes(rule.minLevel as never)) throw new Error('invalid_log_input')
      clean[key] = { enabled: rule.enabled, minLevel: rule.minLevel }
    }
    result[dimension] = clean
  }
  return result as NonNullable<LogPolicyPatch['collection']>
}
/** Shared, pure decision serialized into the SQLite worker; no process-local policy cache. */
export function collectionAllows(event: LogEvent, collection: LogCollection): boolean {
  return collectionAllowsAtLevels(event, collection, LOG_LEVELS)
}
export function collectionAllowsAtLevels(event: LogEvent, collection: LogCollection, levels: readonly LogEvent['level'][]): boolean {
  const source = collection.sources[event.source]
  const integration = event.origin ? collection.integrations[event.origin.integration] : undefined
  return source.enabled && (!integration || integration.enabled)
    && levels.indexOf(event.level) >= levels.indexOf(source.minLevel)
    && (!integration || levels.indexOf(event.level) >= levels.indexOf(integration.minLevel))
}

/** Strict stored shape discrimination; only the pre-field sources/integrations shape is legacy. */
export function decodeStoredLogCollection(value: unknown, initial: LogCollection, profiles: Parameters<typeof defaultFieldControls>[0], validate: typeof validateCollection, defaults: typeof defaultFieldControls, complete: (value: unknown, profiles: Parameters<typeof defaultFieldControls>[0]) => LogFieldControls) {
  const record = (input: unknown, keys: readonly string[]) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== keys.length
      || keys.some(key => !Object.hasOwn(input, key))) throw new Error('invalid_log_policy')
    return input as Record<string, unknown>
  }
  const legacy = !!value && typeof value === 'object' && Object.hasOwn(value, 'sources') && Object.hasOwn(value, 'integrations')
  const envelope = legacy ? undefined : record(value, ['version', 'collection', 'fieldControls'])
  if (envelope && envelope.version !== 1) throw new Error('invalid_log_policy')
  const raw = record(legacy ? value : envelope!.collection, ['sources', 'integrations'])
  const validated = validate(raw)
  const collection = {} as LogCollection
  for (const dimension of ['sources', 'integrations'] as const) {
    const rules = validated[dimension]!
    for (const key of Object.keys(initial[dimension])) {
      if (!Object.hasOwn(rules, key) && !(legacy && dimension === 'integrations')) throw new Error('invalid_log_policy')
    }
    collection[dimension] = { ...initial[dimension], ...rules } as never
  }
  const fieldControls = legacy ? defaults(profiles) : complete(envelope!.fieldControls, profiles)
  return { legacy, collection, fieldControls }
}
