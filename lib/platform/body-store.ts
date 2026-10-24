import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'

/** Storage safety ceiling, not the future compiler's fragment policy. */
export const MAX_PLATFORM_BODY_PARTS = 64

/** Opaque internal handle. Never put it in a source object, fingerprint or DTO. */
export type PlatformBodyRoot = number & { readonly __platformBodyRoot: unique symbol }
export type PlatformBodyOwner =
  | { kind: 'relation'; id: number; field: 'rawFields' | 'sourceText' }
  | { kind: 'query'; id: number; field: 'rawResponse' | 'collectionEvidence' }
  | { kind: 'version'; id: number; field: 'canonicalRawJson' }

export const bodyOwnerDefinitions = {
  relation: { table: 'platform_relation', columns: { rawFields: 'raw_fields', sourceText: 'source_text' }, ref: 'platform_relation_body_ref', fields: ['rawFields', 'sourceText'] },
  query: { table: 'platform_query', columns: { rawResponse: 'raw_response', collectionEvidence: 'collection_evidence' }, ref: 'platform_query_body_ref', fields: ['rawResponse', 'collectionEvidence'] },
  version: { table: 'platform_business_record_version', columns: { canonicalRawJson: 'canonical_raw_json' }, ref: 'platform_version_body_ref', fields: ['canonicalRawJson'] },
} as const

export function bodyOwnerDefinition(kind: PlatformBodyOwner['kind'], field: string) {
  const definition = bodyOwnerDefinitions[kind]
  if (!definition || !(definition.fields as readonly string[]).includes(field)) fail('invalid_owner')
  return definition
}

function fail(reason: string): never { throw new Error(`platform_body_${reason}`) }
function integer(value: number) { if (!Number.isSafeInteger(value) || value < 0) fail('invalid_range') }
function digest(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex') }
function utf8(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { return fail('invalid_utf8') }
}
function encode(text: string): Buffer {
  if (typeof text !== 'string') fail('storage_class')
  const bytes = Buffer.from(text, 'utf8')
  if (utf8(bytes) !== text) fail('invalid_utf8') // Do not silently replace lone UTF-16 surrogates.
  return bytes
}
interface RootRow { id: PlatformBodyRoot; digest: string; byte_length: number; sealed: number; encoding: string }
interface PartRow { logical_start: number; byte_length: number; leaf_id: number }

/** Accepts an already-owned SQLite handle: never opens a DB or installs JS SQL functions.
 * All writes use a transaction/savepoint, composing atomically with the caller's transaction.
 * No application write/read path opts into this module in #278.
 */
export function createPlatformBodyStore(sqlite: Database.Database) {
  if (sqlite.pragma('foreign_keys', { simple: true }) !== 1) fail('foreign_keys_required')
  if (sqlite.pragma('encoding', { simple: true }) !== 'UTF-8') fail('unsupported_encoding')
  function root(id: PlatformBodyRoot): RootRow {
    integer(id)
    const row = sqlite.prepare('SELECT * FROM platform_body_root WHERE id = ?').get(id) as RootRow | undefined
    if (!row || row.sealed !== 1 || row.encoding !== 'utf8-v1' || !Number.isSafeInteger(row.byte_length) || row.byte_length < 0) fail('bad_root')
    return row
  }
  function rootLength(id: PlatformBodyRoot | null): number | null { return id === null ? null : root(id).byte_length }

  function leafBytes(id: number, expected: number): Buffer {
    const row = sqlite.prepare('SELECT bytes, byte_length, digest, encoding FROM platform_body_leaf WHERE id = ?').get(id) as { bytes: Buffer; byte_length: number; digest: string; encoding: string } | undefined
    if (!row || !Buffer.isBuffer(row.bytes) || row.encoding !== 'utf8-v1' || row.byte_length !== expected || row.bytes.length !== expected) fail('bad_leaf')
    if (digest(row.bytes) !== row.digest) fail('bad_digest')
    // Validate the storage conversion explicitly, including corrupt out-of-band BLOBs.
    utf8(row.bytes)
    return row.bytes
  }

  /** Byte offsets, half-open [offset, offset+length), clamped at EOF; may split UTF-8.
   * Two indexed seeks fetch only intersecting parts and their leaves. No whole-root read.
   */
  function readRootRange(id: PlatformBodyRoot | null, offset: number, length: number): Buffer | null {
    integer(offset); integer(length)
    if (id === null) return null
    const metadata = root(id)
    const end = offset + Math.min(length, Math.max(0, metadata.byte_length - offset))
    if (end === offset) {
      if (metadata.byte_length === 0) {
        const part = sqlite.prepare('SELECT leaf_id, byte_length FROM platform_body_part WHERE root_id = ? AND logical_start = 0').get(id) as { leaf_id: number; byte_length: number } | undefined
        if (!part || part.byte_length !== 0) fail('bad_parts')
        leafBytes(part.leaf_id, 0)
      }
      return Buffer.alloc(0)
    }
    const first = sqlite.prepare('SELECT logical_start FROM platform_body_part WHERE root_id = ? AND logical_start <= ? ORDER BY logical_start DESC LIMIT 1').get(id, offset) as { logical_start: number } | undefined
    if (!first) fail('bad_parts')
    const parts = sqlite.prepare('SELECT logical_start, byte_length, leaf_id FROM platform_body_part WHERE root_id = ? AND logical_start >= ? AND logical_start < ? ORDER BY logical_start').all(id, first.logical_start, end) as PartRow[]
    let position = offset
    const chunks: Buffer[] = []
    for (const [index, part] of parts.entries()) {
      if (!Number.isSafeInteger(part.byte_length) || part.byte_length <= 0 || part.logical_start > position
        || (index > 0 && part.logical_start !== position) || part.logical_start + part.byte_length <= position) fail('bad_parts')
      const next = Math.min(end, part.logical_start + part.byte_length)
      // SQLite substr(BLOB) returns only the intersecting bytes, even for a giant single leaf.
      const leaf = sqlite.prepare(`SELECT substr(bytes, ?, ?) AS bytes, length(bytes) AS stored_length,
        typeof(bytes) AS storage_class, byte_length, encoding FROM platform_body_leaf WHERE id = ?`)
        .get(position - part.logical_start + 1, next - position, part.leaf_id) as { bytes: Buffer; stored_length: number; storage_class: string; byte_length: number; encoding: string } | undefined
      if (!leaf || leaf.storage_class !== 'blob' || leaf.encoding !== 'utf8-v1' || leaf.byte_length !== part.byte_length
        || leaf.stored_length !== part.byte_length || !Buffer.isBuffer(leaf.bytes) || leaf.bytes.length !== next - position) fail('bad_leaf')
      chunks.push(leaf.bytes)
      position = next
    }
    if (position !== end) fail('bad_parts')
    return Buffer.concat(chunks)
  }

  function readRootText(id: PlatformBodyRoot | null): string | null {
    if (id === null) return null
    const metadata = root(id)
    const layout = sqlite.prepare('SELECT logical_start, byte_length, leaf_id FROM platform_body_part WHERE root_id = ? ORDER BY logical_start').all(id) as PartRow[]
    let expected = 0
    if (layout.length === 0 || layout.length > MAX_PLATFORM_BODY_PARTS) fail('bad_parts')
    for (const part of layout) {
      if (part.logical_start !== expected || part.byte_length < 0 || (part.byte_length === 0 && metadata.byte_length !== 0)) fail('bad_parts')
      expected += part.byte_length
    }
    if (expected !== metadata.byte_length) fail('bad_parts')
    const bytes = readRootRange(id, 0, metadata.byte_length)!
    if (digest(bytes) !== metadata.digest) fail('bad_digest')
    return utf8(bytes)
  }

  /** Explicit ordered *leaf text* fixture/composition seam; no recursive roots or JSON recipe.
   * Different segmentations of identical complete bytes reuse the same root.
   */
  const internParts = sqlite.transaction((texts: readonly string[]): PlatformBodyRoot => {
    if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_PLATFORM_BODY_PARTS) fail('invalid_parts')
    const chunks = texts.map(encode).filter(bytes => bytes.length > 0)
    if (chunks.length === 0) chunks.push(Buffer.alloc(0))
    const bytes = Buffer.concat(chunks), hash = digest(bytes)
    const existing = sqlite.prepare('SELECT id FROM platform_body_root WHERE digest = ?').get(hash) as { id: PlatformBodyRoot } | undefined
    if (existing) {
      if (rootLength(existing.id) !== bytes.length || !encode(readRootText(existing.id)!).equals(bytes)) fail('hash_collision')
      return existing.id
    }
    const id = Number(sqlite.prepare('INSERT INTO platform_body_root(digest, byte_length) VALUES(?, ?)').run(hash, bytes.length).lastInsertRowid) as PlatformBodyRoot
    let start = 0
    for (const chunk of chunks) {
      const leafHash = digest(chunk)
      const found = sqlite.prepare('SELECT id, byte_length FROM platform_body_leaf WHERE digest = ?').get(leafHash) as { id: number; byte_length: number } | undefined
      let leafId: number
      if (found) {
        if (found.byte_length !== chunk.length || !leafBytes(found.id, found.byte_length).equals(chunk)) fail('hash_collision')
        leafId = found.id
      } else leafId = Number(sqlite.prepare('INSERT INTO platform_body_leaf(digest, byte_length, bytes) VALUES(?, ?, ?)').run(leafHash, chunk.length, chunk).lastInsertRowid)
      sqlite.prepare('INSERT INTO platform_body_part(root_id, logical_start, leaf_id, byte_length) VALUES(?, ?, ?, ?)').run(id, start, leafId, chunk.length)
      start += chunk.length
    }
    sqlite.prepare('UPDATE platform_body_root SET sealed = 1 WHERE id = ?').run(id)
    return id
  })

  function intern(text: string | null): PlatformBodyRoot | null { return text === null ? null : internParts([text]) }

  /** Low-level future writer seam; call with intern in the SAME outer transaction.
   * NULL removes the override (inline fallback), never creates a NULL/empty root.
   */
  function setReference(owner: PlatformBodyOwner, id: PlatformBodyRoot | null): void {
    const definition = bodyOwnerDefinition(owner.kind, owner.field)
    integer(owner.id)
    if (id === null) sqlite.prepare(`DELETE FROM ${definition.ref} WHERE owner_id = ? AND field = ?`).run(owner.id, owner.field)
    else {
      root(id)
      sqlite.prepare(`INSERT INTO ${definition.ref}(owner_id, field, root_id) VALUES(?, ?, ?) ON CONFLICT(owner_id, field) DO UPDATE SET root_id = excluded.root_id`).run(owner.id, owner.field, id)
    }
  }
  function resolveOwner(owner: PlatformBodyOwner) {
    const definition = bodyOwnerDefinition(owner.kind, owner.field)
    integer(owner.id)
    const column = (definition.columns as Record<string, string>)[owner.field]!
    const row = sqlite.prepare(`SELECT root_id FROM ${definition.ref} WHERE owner_id = ? AND field = ?`).get(owner.id, owner.field) as { root_id: PlatformBodyRoot } | undefined
    if (row) return { root: row.root_id } as const
    const inline = sqlite.prepare(`SELECT typeof(${column}) AS storage_class, length(CAST(${column} AS BLOB)) AS byte_length FROM ${definition.table} WHERE id = ?`).get(owner.id) as { storage_class: string; byte_length: number | null } | undefined
    if (!inline) fail('missing_owner')
    if (inline.storage_class !== 'text' && inline.storage_class !== 'null') fail('storage_class')
    return { table: definition.table, column, byteLength: inline.byte_length } as const
  }
  type Source = PlatformBodyRoot | PlatformBodyOwner | null
  const logicalLength = sqlite.transaction((source: Source): number | null => {
    if (source === null || typeof source === 'number') return rootLength(source)
    const resolved = resolveOwner(source)
    return resolved.root !== undefined ? rootLength(resolved.root) : resolved.byteLength
  })
  const readRange = sqlite.transaction((source: Source, offset: number, length: number): Buffer | null => {
    integer(offset); integer(length)
    if (source === null || typeof source === 'number') return readRootRange(source, offset, length)
    const resolved = resolveOwner(source)
    if (resolved.root !== undefined) return readRootRange(resolved.root, offset, length)
    if (resolved.byteLength === null) return null
    const size = Math.min(length, Math.max(0, resolved.byteLength - offset))
    if (size === 0) return Buffer.alloc(0)
    const row = sqlite.prepare(`SELECT substr(CAST(${resolved.column} AS BLOB), ?, ?) AS bytes FROM ${resolved.table} WHERE id = ?`).get(offset + 1, size, source.id) as { bytes: Buffer }
    if (!Buffer.isBuffer(row.bytes) || row.bytes.length !== size) fail('storage_class')
    return row.bytes
  })
  const readText = sqlite.transaction((source: Source): string | null => {
    if (source === null || typeof source === 'number') return readRootText(source)
    const resolved = resolveOwner(source)
    if (resolved.root !== undefined) return readRootText(resolved.root)
    if (resolved.byteLength === null) return null
    return utf8(readRange(source, 0, resolved.byteLength)!)
  })
  return { intern, internParts, readText, readRange, logicalLength, setReference }
}
