import { createHash } from 'node:crypto'


export function capturePostgresObservationFacts(sourceText: string | null, materializedRawText: string | null) {
  const text = sourceText ?? ''
  return {
    identityOnlySource: text.includes('转写') && (text.includes('名称') || /qymc/i.test(text)) && /platform-verify-aclass/i.test(text),
    sourceRawBytes: Buffer.byteLength(materializedRawText ?? '', 'utf8'),
  }
}

export function capturePostgresCollectionFacts(evidenceText: string | null, rawResponse: string | null) {
  return {
    evidenceSha256: evidenceText === null ? null : createHash('sha256').update(evidenceText).digest('hex'),
    sourceBytes: Buffer.byteLength(evidenceText ?? '', 'utf8') + Buffer.byteLength(rawResponse ?? '', 'utf8'),
  }
}
