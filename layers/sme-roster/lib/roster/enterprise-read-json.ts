/** Plain JSON read models only. Bound string encoding scratch space even when a
 * single raw field is much larger than the executor's old generation. */
function* fragments(value: unknown): Generator<string> {
  if (typeof value === 'string') {
    yield '"'
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + 16384, value.length)
      // JSON.stringify escapes lone halves but must retain a real pair spanning
      // a chunk boundary. Slicing such a pair would change its string contents.
      const last = value.charCodeAt(end - 1)
      if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--
      yield JSON.stringify(value.slice(start, end)).slice(1, -1)
      start = end
    }
    yield '"'
  } else if (Array.isArray(value)) {
    yield '['
    for (let index = 0; index < value.length; index++) {
      if (index) yield ','
      yield* fragments(value[index] ?? null)
    }
    yield ']'
  } else if (value !== null && typeof value === 'object') {
    yield '{'
    let first = true
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      if (!first) yield ','
      first = false
      yield JSON.stringify(key); yield ':'; yield* fragments(item)
    }
    yield '}'
  } else yield JSON.stringify(value) ?? 'null'
}

/** At most 64KiB per IPC message. No complete JSON string or backing buffer here. */
export function* enterpriseJsonChunks(value: unknown): Generator<Buffer> {
  const size = 65536
  let buffer = Buffer.allocUnsafeSlow(size), used = 0
  // Batch punctuation and short fields before UTF-8 encoding. One Buffer per
  // token would add thousands of allocations to ordinary list responses.
  function* encoded() {
    let parts: string[] = [], length = 0
    for (const fragment of fragments(value)) {
      parts.push(fragment); length += fragment.length
      if (length >= 16384) { yield Buffer.from(parts.join('')); parts = []; length = 0 }
    }
    if (length) yield Buffer.from(parts.join(''))
  }
  for (const bytes of encoded()) {
    for (let offset = 0; offset < bytes.length;) {
      const count = Math.min(size - used, bytes.length - offset)
      bytes.copy(buffer, used, offset, offset + count)
      used += count; offset += count
      if (used === size) { yield buffer; buffer = Buffer.allocUnsafeSlow(size); used = 0 }
    }
  }
  if (used) yield buffer.subarray(0, used)
}
