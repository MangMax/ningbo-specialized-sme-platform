import type { PlatformRefreshFacts, PlatformRefreshMetadata } from '../../../../db/postgresql/platform-tables'
import { refreshMetadataKeys, refreshRelationFields, refreshSourceKeys } from './difference-hash-keys'

type RefreshCell = PlatformRefreshFacts['fields'][number]
type EvidenceIdentity = { id: number; sha256: string | null }

function fields(value: unknown, keys: readonly string[]) {
  return Object.fromEntries(keys.flatMap(key =>
    value && typeof value === 'object' && Object.hasOwn(value, key) ? [[key, Reflect.get(value, key)]] : []))
}

function sourceBody(text: string | null) {
  if (text === null) return null
  try {
    const value: unknown = JSON.parse(text)
    return value === null ? '{' : JSON.stringify(fields(value, refreshSourceKeys))
  } catch { return '{' }
}

function collectionMetadata(text: string | null): PlatformRefreshMetadata {
  if (text === null) return { json: null, quoted: false }
  try {
    const value: unknown = JSON.parse(text)
    if (value === null) return { json: 'null', quoted: false }
    const metadata = fields(value, refreshMetadataKeys)
    if (Object.hasOwn(metadata, 'pages')) {
      metadata.pages = Array.isArray(metadata.pages) ? metadata.pages.map(page => page === null ? null : {
        rdjb: page?.rdjb ?? null, status: page?.status ?? null, declaredTotal: page?.declaredTotal ?? null,
      }) : null
    }
    return { json: JSON.stringify(metadata), quoted: false }
  } catch { return { json: '{', quoted: false } }
}

export function capturePostgresObservationFacts(cells: readonly RefreshCell[], sourceText: string | null, materializedRawText: string | null) {
  const text = sourceText ?? ''
  return {
    identityOnlySource: text.includes('转写') && (text.includes('名称') || /qymc/i.test(text)) && /platform-verify-aclass/i.test(text),
    sourceRawBytes: Buffer.byteLength(materializedRawText ?? '', 'utf8'),
    refreshFacts: {
      fields: cells.filter(cell => refreshRelationFields.some(name => name === cell.name)),
      business: sourceBody(materializedRawText), quoted: false,
    } satisfies PlatformRefreshFacts,
  }
}

export function capturePostgresCollectionFacts(evidenceText: string | null, rawResponse: string | null, evidenceIdentity?: EvidenceIdentity) {
  return {
    evidenceArchiveId: evidenceIdentity?.id ?? null,
    evidenceSha256: evidenceIdentity?.sha256 ?? null,
    evidenceSealed: evidenceIdentity ? 1 : null,
    sourceArchiveBytes: Buffer.byteLength(evidenceText ?? '', 'utf8') + Buffer.byteLength(rawResponse ?? '', 'utf8'),
    refreshMetadata: collectionMetadata(evidenceText),
  }
}
