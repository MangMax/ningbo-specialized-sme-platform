/** Private startup capability: runtime sources only, never job parameters/results. */
export type ReceiptRuntimeContext = Readonly<{ apiToken?: string; mcpToken?: string; ocrToken?: string }>
const keys = ['apiToken', 'mcpToken', 'ocrToken'] as const
const unavailable = () => new Error('导出运行上下文不可用')

export function validateReceiptRuntimeContext(value: unknown): ReceiptRuntimeContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw unavailable()
  const names = Reflect.ownKeys(value)
  if (names.length > 3) throw unavailable()
  const result: { apiToken?: string; mcpToken?: string; ocrToken?: string } = {}
  let bytes = 0
  for (const name of names) {
    if (typeof name !== 'string' || !keys.includes(name as typeof keys[number])) throw unavailable()
    const descriptor = Object.getOwnPropertyDescriptor(value, name)!
    if (!descriptor.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string' || descriptor.value.length > 16384) throw unavailable()
    const size = Buffer.byteLength(descriptor.value, 'utf8')
    if (size > 16384 || (bytes += size) > 49152) throw unavailable()
    result[name as typeof keys[number]] = descriptor.value
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 65536) throw unavailable()
  return Object.freeze(result)
}

/** Project only three trusted runtime fields; do not retain the runtime object. */
export function captureReceiptRuntimeContext(runtime: unknown): ReceiptRuntimeContext {
  try {
    if (runtime !== undefined && (runtime === null || typeof runtime !== 'object')) throw unavailable()
    const result: { apiToken?: string; mcpToken?: string; ocrToken?: string } = {}
    for (const key of keys) {
      const value = (runtime as Record<string, unknown> | undefined)?.[key]
      if (value !== undefined) Object.defineProperty(result, key, { value, enumerable: true })
    }
    return validateReceiptRuntimeContext(result)
  } catch { throw unavailable() }
}
