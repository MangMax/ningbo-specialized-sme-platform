import type * as schema from '../../../../db/schema'
import type { PublishedPresentation } from '../../lib/roster/correspondence-view'
import { sanitizeEvidence } from './evidence-redaction'
import type { listRecordCorrespondenceRefs, CorrespondenceRead } from './record-correspondence'

export type SourceKind = 'event' | 'relation' | 'export_row'

// Both summary and hydrated detail exclude the same private correspondence fields.
export function publicCorrespondence(row: CorrespondenceRead) {
  const { edgeKey: _edgeKey, targetIdentity: _targetIdentity, provenance: _provenance, sourceFingerprint: _sourceFingerprint, ...publicRow } = row
  return publicRow
}

export type SourceSelection = { kind: SourceKind; id: number }

export function correspondenceSourceSelections(rows: readonly CorrespondenceRead[], extra?: SourceSelection) {
  const eventIds = [...new Set(rows.flatMap(row => [row.eventId, row.predecessorEventId]).filter((id): id is number => id != null).concat(extra?.kind === 'event' ? [extra.id] : []))]
  const relationIds = [...new Set(rows.flatMap(row => row.relationId == null ? [] : [row.relationId]).concat(extra?.kind === 'relation' ? [extra.id] : []))]
  const exportRowIds = [...new Set(rows.flatMap(row => row.exportRowId == null ? [] : [row.exportRowId]).concat(extra?.kind === 'export_row' ? [extra.id] : []))]
  const occurrences = rows.flatMap(row => [row.eventId, row.predecessorEventId]).filter((id): id is number => id != null)
  if (extra?.kind === 'event') occurrences.push(extra.id)
  return { eventIds, relationIds, exportRowIds, occurrences }
}

export type SourceEvidence = typeof schema.recordEvidence.$inferSelect

export function correspondencePublishedScope(evidence: SourceEvidence[], occurrences: number[]) {
  const scope = evidence.map(e => ({ evidenceId: e.id, eventId: e.recordEventId }))
  const byEvent = Map.groupBy(scope, row => row.eventId)
  const copies = occurrences.flatMap(id => (byEvent.get(id) ?? []).flatMap(item => [item, item, item]))
  return { scope, copies }
}

export function projectCorrespondenceSources({ events, evidenceRows, files, sortedLinks, exports, targetDisplays, presentation }: {
  events: { event: typeof schema.recordEvent.$inferSelect; record: typeof schema.record.$inferSelect }[]
  evidenceRows: SourceEvidence[]
  files: (Pick<typeof schema.storedFile.$inferSelect, 'id' | 'relPath' | 'bytes' | 'removedAt'> & { sha256: string | null })[]
  sortedLinks: ReturnType<typeof listRecordCorrespondenceRefs>
  exports: { row: typeof schema.platformExportRow.$inferSelect; batch: typeof schema.platformExportBatch.$inferSelect }[]
  targetDisplays: ReadonlyMap<number, unknown>
  presentation: PublishedPresentation
}) {
  const filesByPath = new Map(files.map(f => [f.relPath, f]))
  const evidenceByEvent = Map.groupBy(evidenceRows, e => e.recordEventId)
  const byEvent = Map.groupBy(sortedLinks.filter(r => r.eventId != null), r => r.eventId)
  const byPredecessor = Map.groupBy(sortedLinks.filter(r => r.predecessorEventId != null), r => r.predecessorEventId)
  const byRelation = Map.groupBy(sortedLinks.filter(r => r.relationId != null), r => r.relationId)
  const byExport = Map.groupBy(sortedLinks.filter(r => r.exportRowId != null), r => r.exportRowId)
  const facts = new Map(presentation.facts.map(fact => [fact.evidenceId, fact]))
  const eventSources = new Map(events.map(joined => {
    const id = joined.event.id, evidence = evidenceByEvent.get(id) ?? []
    const officialEvidence = evidence.map(item => {
      const legacy = { evidence: sanitizeEvidence(item), storedFile: filesByPath.get(item.sourceFile) ?? null }
      return { ...sanitizeEvidence(legacy) as typeof legacy, ...(facts.has(item.id) ? { publishedName: facts.get(item.id) } : {}) }
    })
    const eventLinks = [...new Map([...(byEvent.get(id) ?? []), ...(byPredecessor.get(id) ?? [])].map(r => [r.id, r])).values()].sort((a, b) => a.id - b.id)
    return [id, { ...joined.event, publishedPresentation: presentation.availability === 'unavailable' ? presentation : { ...presentation, facts: presentation.facts.filter(fact => fact.eventId === id) }, record: { id: joined.record.id, enterpriseId: joined.record.enterpriseId, titleCode: joined.record.titleCode, source: joined.record.source, usccRaw: joined.record.usccRaw }, evidence: evidence.map(item => ({ ...sanitizeEvidence(item) as typeof item, ...(facts.has(item.id) ? { publishedName: facts.get(item.id) } : {}) })), officialEvidence, correspondences: eventLinks }] as const
  }))
  const relationSources = new Map([...targetDisplays].map(([id, display]) => [id, display && typeof display === 'object' ? { ...display, correspondences: byRelation.get(id) ?? [] } : null]))
  const exportSources = new Map(exports.map(({ row, batch }) => [row.id, { ...row, rawFields: sanitizeEvidence(row.rawFields), batch: sanitizeEvidence(batch), correspondences: byExport.get(row.id) ?? [] }] as const))
  const read = (kind: SourceKind, id: number) => kind === 'event' ? eventSources.get(id) ?? null : kind === 'relation' ? relationSources.get(id) ?? null : exportSources.get(id) ?? null
  const detailRow = (row: CorrespondenceRead) => {
    return { ...publicCorrespondence(row), event: row.eventId ? eventSources.get(row.eventId) ?? null : null, predecessorEvent: row.predecessorEventId ? eventSources.get(row.predecessorEventId) ?? null : null, relation: row.relationId ? read('relation', row.relationId) : null, exportRow: row.exportRowId ? read('export_row', row.exportRowId) : null }
  }
  return { read, detail: detailRow, event: (id: number) => eventSources.get(id) ?? null }
}
