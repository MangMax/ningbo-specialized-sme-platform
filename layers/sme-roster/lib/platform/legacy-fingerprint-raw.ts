import { TextDecoder } from 'node:util'

/** Authenticated archive only. Preserve the predecessor TEXT decoder and original BLOB driver value. */
export function legacyFingerprintRaw(raw: { storageClass: 'null' | 'text' | 'blob'; bytes: Buffer | null }) {
  const driverValue = raw.storageClass === 'null' ? null : raw.storageClass === 'blob' ? raw.bytes
    : new TextDecoder('utf-8', { fatal: true }).decode(raw.bytes!)
  let rawFields: unknown = null
  try { rawFields = driverValue === null ? null : JSON.parse(String(driverValue)) }
  catch { /* The original observation oracle retains the unparsed driver value. */ }
  // In particular, do not turn a Buffer into text here. The original canonical serializer
  // refuses invalid/null JSON BLOB inputs; valid JSON BLOB inputs have invalidRaw=null.
  return { rawFields, invalidRaw: rawFields === null ? driverValue : null }
}
