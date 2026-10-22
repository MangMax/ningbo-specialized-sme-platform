import { LOG_LEVELS, LOG_SOURCES, LOG_SUPPORTED_INTEGRATIONS, type LogCollection, type LogEvent, type LogPolicyPatch } from './contract'

export function defaultLogCollection(): LogCollection {
  return {
    sources: Object.fromEntries(LOG_SOURCES.map(key => [key, { enabled: true, minLevel: 'debug' }])) as LogCollection['sources'],
    integrations: Object.fromEntries(LOG_SUPPORTED_INTEGRATIONS.map(key => [key, { enabled: true, minLevel: 'debug' }])) as LogCollection['integrations'],
  }
}
/** Strict own-key projection. Never spread untrusted dictionaries into policy. */
export function validateCollection(value: unknown): NonNullable<LogPolicyPatch['collection']> {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v))
  if (!object(value) || Object.keys(value).some(key => key !== 'sources' && key !== 'integrations')) throw new Error('invalid_log_input')
  const result: Record<string, Record<string, unknown>> = {}
  for (const [dimension, keys] of [['sources', LOG_SOURCES], ['integrations', LOG_SUPPORTED_INTEGRATIONS]] as const) {
    if (!Object.hasOwn(value, dimension)) continue
    const rules = value[dimension]
    if (!object(rules)) throw new Error('invalid_log_input')
    const clean: Record<string, unknown> = {}
    for (const key of Object.keys(rules)) {
      if (!(keys as readonly string[]).includes(key)) throw new Error('invalid_log_input')
      const rule = rules[key]
      if (!object(rule) || Object.keys(rule).length !== 2 || !Object.hasOwn(rule, 'enabled') || !Object.hasOwn(rule, 'minLevel') || typeof rule.enabled !== 'boolean' || !LOG_LEVELS.includes(rule.minLevel as never)) throw new Error('invalid_log_input')
      clean[key] = { enabled: rule.enabled, minLevel: rule.minLevel }
    }
    result[dimension] = clean
  }
  return result as NonNullable<LogPolicyPatch['collection']>
}
/** Shared, pure decision serialized into the SQLite worker; no process-local policy cache. */
export function collectionAllows(event: LogEvent, collection: LogCollection): boolean {
  const levels = ['debug', 'info', 'warn', 'error']
  const source = collection.sources[event.source]
  const integration = event.origin ? collection.integrations[event.origin.integration] : undefined
  return source.enabled && (!integration || integration.enabled)
    && levels.indexOf(event.level) >= levels.indexOf(source.minLevel)
    && (!integration || levels.indexOf(event.level) >= levels.indexOf(integration.minLevel))
}
