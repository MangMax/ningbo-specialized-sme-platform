import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import type { RosterImportRequest, RosterImportEvent, RosterImportItemResult } from '../../lib/roster-import-client'
import { readPostgresRosterRowsById } from '../../lib/roster/postgres-rows'
import {
  ambiguousAnnouncementRepoints, announcementEvidenceCoordinate, eventCoordinates, groupNewAnnouncementEvidence, hasOfficialFactInput, indexedEvidenceHashes,
  matchesEventCoordinates, projectAnnouncementRepoints, validateAnnouncementRecord,
} from './roster-import'
import { checkOfficialOuterDocument, officialPublishedRowSchema, officialFactFailure, officialPlanDigest, projectOfficialDeclaration, type OfficialClaimChange, type OfficialCoordinate } from './official-evidence-plan'
import { lockPostgresOfficialImportTargets, planPostgresOfficialImport } from './official-evidence-import-postgres'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type ExistingRecord = typeof schema.record.$inferSelect
const ids = (values: readonly number[]) => sql`${sql.param(values)}::bigint[]`
const key = (owner: number, titleCode: string, source: string) => [owner,titleCode,source].join(':')

export async function planPostgresAnnouncement(tx: Tx, request: RosterImportRequest, owners: ReadonlyMap<number, number>,
  created: ReadonlySet<number>, decision: string | undefined, filesDir?: string, ownerMap?: ReadonlyMap<string, string>) {
  const announcement = request.payload.announcement!
  const checked = announcement.records.map((record, index) => validateAnnouncementRecord(announcement, record, index))
  const errors = checked.flatMap(row => row.error ? [row.error] : [])
  const noOfficial = { official: null, officialPlan: null }
  if (errors.length) return { errors, rows: [] as never[], ...noOfficial }
  const addOfficialError = (error: unknown) => {
    const issue = error as { code?: string; message?: string; statusCode?: number }
    if (!issue.statusCode || !issue.code) throw error
    errors.push({ ok: false, kind: 'official_evidence', ref: 'payload', error: { code: issue.code, message: issue.message ?? issue.code } } satisfies RosterImportItemResult)
  }

  const records = await readPostgresRosterRowsById(tx, schema.record, sql`
    FROM record p WHERE enterprise_id=ANY(${ids([...new Set(owners.values())])})`)
  const bySubject = new Map(records.map(row => [key(row.enterpriseId,row.titleCode,row.source), row]))
  const events = await readPostgresRosterRowsById(tx, schema.recordEvent, sql`FROM record_event p WHERE record_id=ANY(${ids(records.map(row => row.id))})`)
  const byRecord = Map.groupBy(events, row => row.recordId)
  const findStoredEvent = (stored: ExistingRecord | undefined, event: RosterImportEvent) => stored &&
    byRecord.get(stored.id)?.find(row => matchesEventCoordinates(row, eventCoordinates(stored.id, event)))
  const evidence = await readPostgresRosterRowsById(tx, schema.recordEvidence, sql`FROM record_evidence p WHERE record_event_id=ANY(${ids(events.map(row => row.id))})`)
  const paths = new Set([request.sourceIdentity, ...evidence.map(row => row.sourceFile)])
  for (const row of checked) {
    for (const event of row.events ?? []) {
      for (const link of event.evidence ?? []) paths.add(announcementEvidenceCoordinate(link).sourceFile)
    }
  }
  try {
    await lockPostgresOfficialImportTargets(tx, request, paths, events.map(row => row.id))
  } catch (error) {
    addOfficialError(error)
    return { errors, rows: [] as never[], ...noOfficial }
  }
  const { rows: evidenceHashes } = await tx.execute<{ path: string; sha256: string | null }>(sql`
    SELECT rel_path AS path,sha256 FROM stored_file WHERE rel_path=ANY(${sql.param([...paths])}::text[])
    UNION ALL
    SELECT source_identity,source_sha256 FROM import_batch WHERE status='committed' AND source_kind='announcement'
      AND source_identity=ANY(${sql.param([...paths])}::text[])`)
  const hashes = indexedEvidenceHashes(request, evidenceHashes)
  const prior = new Map(checked.flatMap((row, index) => {
    const stored = row.error ? undefined : bySubject.get(key(owners.get(index)!,row.titleCode,row.source))
    return stored ? [[index,stored.id] as const] : []
  }))
  const ambiguous = ambiguousAnnouncementRepoints(announcement.records, prior, events, evidence, hashes)
  const taken = new Set<number>()
  const grouped = groupNewAnnouncementEvidence(announcement, announcement.records, index => ({ key: 'enterprise:' + owners.get(index)! }),
    (index, title, source, event) => !!findStoredEvent(bySubject.get(key(owners.get(index)!,title,source)), event))
  const known = new Set(bySubject.keys())
  const createdRows = new Map<number, number>()
  for (const [index, id] of owners) if (created.has(id) && !createdRows.has(id)) createdRows.set(id,index)
  const rows = checked.flatMap((row, index) => {
    if (row.error) return []
    const owner = owners.get(index)!
    const coordinate = key(owner,row.titleCode,row.source), existing = bySubject.get(coordinate)
    const plan = existing ? projectAnnouncementRepoints(existing.id, row.events, byRecord.get(existing.id) ?? [], evidence, taken, ambiguous, hashes)
      : { targets: [], hashConflicts: new Set() }
    if (plan.hashConflicts.size) {
      const mismatch = plan.hashConflicts.has('mismatch')
      errors.push({ ok: false, kind: 'record_evidence', ref: 'record:' + index, error: {
        code: mismatch ? 'evidence_content_hash_mismatch' : 'evidence_content_hash_unknown',
        message: mismatch ? '原出处与目标路径内容 SHA-256 不一致，不能收敛指针' : '出处路径缺少唯一可核验 SHA-256，不能收敛指针',
        field: 'evidence.sourceFile',
      } })
    }
    const operation = known.has(coordinate) ? plan.targets.length ? 'update' as const : 'skip' as const : 'add' as const
    known.add(coordinate)
    const record = announcement.records[index]!
    return [{ ...row, index, operation, owner, existing, uscc: normalizeUscc(record.enterprise.uscc) || null,
      district: typeof record.enterprise.district === 'string' ? record.enterprise.district.trim() || null : null,
      events: grouped.eventsByRecord.get(index)!, repoints: plan.targets, created: createdRows.get(owner) === index }]
  })

  const changes: OfficialClaimChange[] = []
  const unknownClaims: { ref: string; coordinate: OfficialCoordinate }[] = []
  if (errors.length || !hasOfficialFactInput(request)) return { errors, rows, ...noOfficial }
  const typedCount = announcement.records.reduce((count, record) => count + (record.events ?? []).reduce((n,event) =>
    n + (event.evidence ?? []).filter(link => link.publishedRow !== undefined).length, 0), 0)
  const declarations = new Map<number, typeof schema.sourceDocument.$inferSelect>()
  const batchCoordinates = new Map<string, boolean>()
  try {
    if (typedCount + (request.payload.officialEvidenceAppends?.length ?? 0) + (request.payload.officialEvidenceCorrections?.operations?.length ?? 0) > 100) {
      return officialFactFailure('input_limit', 'At most 100 new official fact operations', 400)
    }
    for (const row of rows) {
      for (const event of row.events) if (event.evidence?.some(link => link.publishedRow !== undefined) && event.evidence.length > 300) {
        return officialFactFailure('source_limit', 'Final new event evidence exceeds 300', 413)
      }
      const identity = row.created || createdRows.has(row.owner) ? 'pending:reviewed:' + createdRows.get(row.owner)! : 'enterprise:' + row.owner
      for (const [eventIndex, event] of checked[row.index]!.events!.entries()) {
        const eventId = identity + ':' + row.titleCode + ':' + officialPlanDigest(eventCoordinates(0,event))
        for (const [linkIndex, link] of (event.evidence ?? []).entries()) {
          const coordinate = announcementEvidenceCoordinate(link, grouped.groupedOccurrences.has(row.index + ':' + eventIndex))
          const key = officialPlanDigest({ eventKey: eventId, ...coordinate })
          const typed = link.publishedRow !== undefined
          if (batchCoordinates.has(key) && (typed || batchCoordinates.get(key))) {
            return officialFactFailure('ambiguous_target', 'Typed new capture coordinate must be stated once across the batch', 409)
          }
          batchCoordinates.set(key, typed)
          if (!typed) continue
          if (row.source !== 'jxj') return officialFactFailure('target_mismatch', 'Published facts belong to official jxj events', 409)
          if (event.evidence!.length > 300) return officialFactFailure('source_limit', 'Event evidence exceeds 300', 413)
          if (findStoredEvent(row.existing, event)) return officialFactFailure('explicit_append_required', 'Existing event requires exact officialEvidenceAppends; ordinary duplicate import adds no facts', 409)
          const check = officialPublishedRowSchema.safeParse(link.publishedRow)
          if (!check.success) return officialFactFailure('invalid_input','Full explicit publishedRow required',409)
          const publishedRow = link.publishedRow!
          const declaration = publishedRow.declaration
          if (declaration.kind === 'existing' && !declarations.has(declaration.sourceDocumentId)) {
            const [doc] = await readPostgresRosterRowsById(tx,schema.sourceDocument,sql`FROM source_document p WHERE id=${declaration.sourceDocumentId}`)
            if (doc) declarations.set(doc.id,doc)
          }
          checkOfficialOuterDocument(projectOfficialDeclaration(declaration, declaration.kind === 'existing' ? declarations.get(declaration.sourceDocumentId) : undefined), announcement.sourceDocument)
          const ref = 'capture:' + row.index + ':' + eventIndex + ':' + linkIndex
          changes.push({ ref, evidenceId: ref, eventId: 'event:' + eventId, owner: identity,
            titleCode: row.titleCode, coordinate: announcementEvidenceCoordinate(link), publishedRow, expectedRowRevision: 0 })
        }
      }
      for (const [eventIndex, event] of row.events.entries()) {
        if (findStoredEvent(row.existing,event)) continue
        for (const [linkIndex, link] of (event.evidence ?? []).entries()) {
          if (link.publishedRow === undefined) unknownClaims.push({ ref: 'legacy:' + row.index + ':' + eventIndex + ':' + linkIndex,
            coordinate: announcementEvidenceCoordinate(link) })
        }
      }
    }
    const officialPlan = await planPostgresOfficialImport(tx, request, {
      filesDir, captures: changes, unknownClaims, locatorMoves: rows.flatMap(row => row.repoints), ownerMap, reviewDecision: decision,
    })
    return { errors, rows, official: officialPlan?.planHash ?? null, officialPlan }
  } catch (error) {
    addOfficialError(error)
    return { errors, rows, ...noOfficial }
  }
}
