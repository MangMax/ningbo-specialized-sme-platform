type EvidenceIdentity = { id: number; sha256: string | null }

export function capturePostgresObservationFacts(sourceText: string | null, materializedRawText: string | null) {
  const text = sourceText ?? ''
  return {
    identityOnlySource: text.includes('转写') && (text.includes('名称') || /qymc/i.test(text)) && /platform-verify-aclass/i.test(text),
    sourceRawBytes: Buffer.byteLength(materializedRawText ?? '', 'utf8'),
  }
}

export function capturePostgresCollectionFacts(evidenceText: string | null, rawResponse: string | null, evidenceIdentity?: EvidenceIdentity) {
  return {
    evidenceArchiveId: evidenceIdentity?.id ?? null,
    evidenceSha256: evidenceIdentity?.sha256 ?? null,
    evidenceSealed: evidenceIdentity ? 1 : null,
    sourceArchiveBytes: Buffer.byteLength(evidenceText ?? '', 'utf8') + Buffer.byteLength(rawResponse ?? '', 'utf8'),
  }
}
