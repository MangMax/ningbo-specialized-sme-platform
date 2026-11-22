const secretKey = /cookie|password|passwd|token|secret|credential|authorization|api.?key|session|set-cookie|rawresponse|raw_response/i
const credentialName = String.raw`(?:set[-_]?cookie|cookie|password|passwd|(?:access|refresh|id)[-_]?token|token|secret|credential|authorization|authentication|auth|api[-_]?key|session(?:id)?|raw[-_]?response)`
const escapedJsonCredential = new RegExp(String.raw`(\\"${credentialName}\\"\s*:\s*\\")((?:(?!\\").)*)(\\")`, 'gi')
const jsonCredential = new RegExp(String.raw`("${credentialName}"\s*:\s*")((?:\\.|[^"\\])*)(")`, 'gi')
const assignmentCredential = new RegExp(String.raw`(\b${credentialName}\b\s*(?:[:=]|%3A|%3D)\s*(?:\\?"|%22)?)([^\s;,&}\]"']+)`, 'gi')
function redactAssignments(value: string): string {
  return value
    .replace(escapedJsonCredential, '$1[REDACTED]$3')
    .replace(jsonCredential, '$1[REDACTED]$3')
    .replace(assignmentCredential, (match, prefix: string, existing: string) => existing === '[REDACTED' ? match : `${prefix}[REDACTED]`)
}
function redactCredentialEchoes(value: string): string {
  const direct = redactAssignments(value)
  // Archived evidence can contain URI-encoded JSON, or JSON quoted inside
  // another string. Unwrap a bounded number of reversible layers and apply
  // the same structural assignment checks, including ordinary JSON spacing.
  let normalized = direct
  let foundEncodedCredential = false
  for (let depth = 0; depth < 4; depth++) {
    let next = normalized
    next = next.replace(/(?:%[0-9a-f]{2})+/gi, encoded => {
      try { return decodeURIComponent(encoded) } catch { return encoded }
    })
    next = next.replace(/\\(["\\])/g, '$1')
    if (next === normalized) break
    const sanitized = redactAssignments(next)
    if (sanitized !== next) foundEncodedCredential = true
    normalized = sanitized
  }
  return foundEncodedCredential ? normalized : direct
}
export function sanitizeEvidence(value: Record<string, unknown>, knownRedactors?: ReadonlyArray<(text: string) => string>): Record<string, unknown>
export function sanitizeEvidence(value: unknown, knownRedactors?: ReadonlyArray<(text: string) => string>): unknown
export function sanitizeEvidence(value: unknown, knownRedactors: ReadonlyArray<(text: string) => string> = []): unknown {
  if (Array.isArray(value)) return value.map(item => sanitizeEvidence(item, knownRedactors))
  const redact = (text: string) => knownRedactors.reduce((result, known) => known(result), redactCredentialEchoes(text))
  if (typeof value === 'string') return redact(value)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !secretKey.test(key)).map(([key, item]) => [redact(key), sanitizeEvidence(item, knownRedactors)]))
  return value
}
export function safeCollectionEvidence(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { rows: _rows, ...metadata } = value as Record<string, unknown>
  return sanitizeEvidence(metadata)
}
