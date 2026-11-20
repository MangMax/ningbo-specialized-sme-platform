import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { isPageCapable } from '../../lib/roster/evidence-page'
import { registerPostgresEnterpriseSource } from '../../../core/server/public'
import type { RosterImportRequest, RosterImportItemResult } from '../../lib/roster-import-client'
import { readPostgresRosterRowsById } from '../../lib/roster/postgres-rows'
import { advancePostgresOfficialEventRevision, capturePostgresOfficialEventRevision } from './evidence-revision-postgres'
import { announcementEvidenceCoordinate, evidenceRepointPlanFingerprint, eventCoordinates, matchesEventCoordinates } from './roster-import'
import { readOfficialFile } from './official-evidence-plan'
import { resolvePostgresOfficialDeclaration, writePostgresOfficialPublishedRow } from './official-evidence-write-postgres'
import type { planPostgresAnnouncement } from './announcement-plan-postgres'
import { ImportReceiptError } from './import-receipts'
import { refreshPostgresDerivedFileParts } from './file-parts-postgres'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Plan = Awaited<ReturnType<typeof planPostgresAnnouncement>>
type Row = Plan['rows'][number]
const textOrNull = (value: unknown) => typeof value === 'string' ? value.trim() || null : null

async function ordinarySourceDocument(tx: Tx, request: RosterImportRequest, source: string) {
  const document = request.payload.announcement!.sourceDocument
  const title = textOrNull(document.title) ?? request.sourceIdentity
  const number = textOrNull(document.docNumber)
  const { rows: [previous] } = await tx.execute<{ id: number }>(sql`
    SELECT id::float8 AS id FROM source_document WHERE source=${source} AND title=${title}
      AND doc_number IS NOT DISTINCT FROM ${number} ORDER BY id LIMIT 1`)
  if (previous) return { id: previous.id, created: false }
  const { rows: [row] } = await tx.execute<{ id: number }>(sql`
    INSERT INTO source_document(source,title,doc_number,issue_date,path)
    VALUES(${source},${title},${number},${textOrNull(document.issueDate)},${request.sourceIdentity}) RETURNING id::float8 AS id`)
  return { id: row!.id, created: true }
}

async function repointEvidence(tx: Tx, row: Row, changedEvents: Map<number, number>, files: Set<string>) {
  let count = 0
  for (const target of row.repoints) {
    const keepPage = isPageCapable(target.sourceFile)
    const { rows: [changed] } = await tx.execute<{ lostPage: boolean; revision: number }>(sql`
      WITH previous AS (
        SELECT v.id,v.page,e.revision FROM record_evidence v JOIN record_event e ON e.id=v.record_event_id
        WHERE v.id=${target.id} AND v.record_event_id=${target.recordEventId} AND v.source_file=${target.fromSourceFile}
      )
      UPDATE record_evidence v SET source_file=${target.sourceFile},page=CASE WHEN ${keepPage} THEN v.page ELSE NULL END
      FROM previous p WHERE v.id=p.id RETURNING (NOT ${keepPage} AND p.page IS NOT NULL) AS "lostPage",p.revision::float8 AS revision`)
    if (!changed) continue
    if (changed.lostPage) changedEvents.set(target.recordEventId, changed.revision)
    files.add(target.fromSourceFile).add(target.sourceFile)
    count++
  }
  return count
}

export async function writePostgresAnnouncement(tx: Tx, request: RosterImportRequest, batchId: number, plan: Plan) {
  const declarations = new Map<string, number>()
  const changedEvents = new Map<number,number>(), files = new Set<string>()
  const fingerprint = evidenceRepointPlanFingerprint(request)
  const records = new Map(plan.rows.flatMap(row => row.existing ? [[row.owner+':'+row.titleCode+':'+row.source,row.existing.id] as const] : []))
  const items: RosterImportItemResult[] = []
  for (const row of plan.rows) {
    const published = row.events.flatMap(event => event.evidence ?? []).find(evidence => evidence.publishedRow)?.publishedRow
    const beforeDeclarations = declarations.size
    const source = published ? { id: await resolvePostgresOfficialDeclaration(tx, published.declaration, declarations), created: false }
      : await ordinarySourceDocument(tx, request, row.source)
    const key = row.owner+':'+row.titleCode+':'+row.source
    let recordId = records.get(key)
    const recordCreated = recordId === undefined
    if (recordId === undefined) {
      const { rows: [record] } = await tx.execute<{ id: number }>(sql`
        INSERT INTO record(enterprise_id,title_code,source,district,uscc_raw,name_raw,quality_flags)
        VALUES(${row.owner},${row.titleCode},${row.source},${row.district},${row.uscc},${row.name},'[]') RETURNING id::float8 AS id`)
      recordId = record!.id
      records.set(key, recordId)
    }
    const evidenceRepointed = await repointEvidence(tx, row, changedEvents, files)
    const existing = recordCreated ? [] : await readPostgresRosterRowsById(tx, schema.recordEvent, sql`FROM record_event p WHERE record_id=${recordId}`)
    const events: number[] = [], evidenceIds: number[] = []
    let skipped = 0
    for (const event of row.events) {
      const coordinate = eventCoordinates(recordId, event)
      if (existing.some(stored => matchesEventCoordinates(stored, coordinate))) { skipped++; continue }
      const { rows: [inserted] } = await tx.execute<{ id: number }>(sql`
        INSERT INTO record_event(record_id,event_type,year,batch_seq,sort_key,review_outcome,decided_year,revision)
        VALUES(${recordId},${coordinate.eventType},${coordinate.year},${coordinate.batchSeq},${coordinate.year ?? 0},
          ${coordinate.reviewOutcome},${coordinate.decidedYear},1) RETURNING id::float8 AS id`)
      const eventId = inserted!.id
      events.push(eventId)
      existing.push({ ...coordinate, eventType: event.eventType, reviewOutcome: event.reviewOutcome ?? null,
        id: eventId, revision: 1, formalValidity: null, sortKey: coordinate.year ?? 0 })
      for (const entry of event.evidence ?? []) {
        const link = announcementEvidenceCoordinate(entry)
        const { rows: [created] } = await tx.execute<{ id: number }>(sql`
          INSERT INTO record_evidence(record_event_id,source_file,attachment,list_no,page)
          VALUES(${eventId},${link.sourceFile},${link.attachment},${link.listNo},${link.page}) RETURNING id::float8 AS id`)
        const evidenceId = created!.id
        evidenceIds.push(evidenceId)
        files.add(link.sourceFile)
        if (entry.publishedRow) {
          await writePostgresOfficialPublishedRow(tx, entry.publishedRow, evidenceId, 0, { kind: 'import', batchId }, declarations)
        }
      }
      if (row.source === 'jxj') await capturePostgresOfficialEventRevision(tx, eventId, 0, 1)
    }
    const rowsWritten = Number(source.created) + declarations.size - beforeDeclarations + Number(row.created) + Number(recordCreated) + events.length + evidenceIds.length
    items.push({ ok: true, kind: 'record_event', ref: 'record:' + recordId, detail: {
      enterpriseId: row.owner, recordId, sourceDocumentId: source.id, events, evidence: evidenceIds, skipped,
      evidenceRepointed, evidenceRepointTargets: row.repoints, evidenceRepointPlanFingerprint: fingerprint, rowsWritten,
    } })
  }
  for (const [eventId, revision] of changedEvents) await advancePostgresOfficialEventRevision(tx, eventId, revision)
  await refreshPostgresDerivedFileParts(tx, files)
  if (plan.official !== null) items.push({ ok: true, kind: 'official_evidence', ref: 'official_evidence', detail: { evidence: [], rowsWritten: 0 } })
  return items
}

export async function attachPostgresAnnouncementSources(tx: Tx, intakeId: number, batchId: number, request: RosterImportRequest,
  owners: ReadonlyMap<number,number>, filesDir?: string) {
  const { rows: [file] } = await tx.execute<{ id: number; sha256: string; source: string }>(sql`
    SELECT f.id::float8 AS id,f.sha256,c.source FROM stored_file f JOIN roster_file_classification c ON c.file_id=f.id
    WHERE f.rel_path=${request.sourceIdentity} AND c.kind='announcement' AND f.removed_at IS NULL`)
  if (file && (request.sourceSha256 && request.sourceSha256 !== file.sha256 ||
    filesDir && readOfficialFile(filesDir, request.sourceIdentity).sha256 !== file.sha256)) {
    throw new ImportReceiptError(409, 'source_changed', 'Registered announcement bytes differ')
  }
  const { rows: captured } = await tx.execute<{ id: number; source: string; title: string; fileId: number | null; sha256: string; owner: number }>(sql`
    SELECT d.id::float8 AS id,d.source,d.title,h.stored_file_id::float8 AS "fileId",h.sha256,r.enterprise_id::float8 AS owner
    FROM official_evidence_row_revision h JOIN source_document d ON d.id=h.source_document_id JOIN record_event e ON e.id=h.event_id
    JOIN record r ON r.id=e.record_id WHERE h.import_batch_id=${batchId} AND h.source_binding_known=1 ORDER BY h.evidence_id,h.revision`)
  const sourceIds = new Set<number>(), capturedOwners = new Set<string>()
  for (const row of captured) {
    sourceIds.add(await registerPostgresEnterpriseSource(tx, { module: 'sme-roster', businessTable: 'source_document',
      versionKey: row.id+':'+row.sha256, channel: row.source, listType: 'announcement',
      series: row.title, acquiredOn: null, fileId: row.fileId, sha256: row.sha256 }, [row.owner]))
    capturedOwners.add(row.owner+':'+row.source)
  }
  const announcement = request.payload.announcement!
  const title = announcement.sourceDocument.title ?? request.sourceIdentity
  for (const [index, owner] of owners) {
    const channel = announcement.records[index]!.source ?? announcement.sourceDocument.source
    if (capturedOwners.has(owner+':'+channel)) continue
    const registered = file?.source === channel ? file : undefined
    const docs = registered ? (await tx.execute<{ id: number }>(sql`SELECT id::float8 AS id FROM source_document
        WHERE path=${request.sourceIdentity} AND source=${channel} AND title=${title} LIMIT 2`)).rows : []
    const versionKey = docs.length === 1 ? docs[0]!.id + ':' + registered!.sha256 : intakeId + ':' + channel
    const digest = registered?.sha256 ?? (/^[a-f0-9]{64}$/.test(request.sourceSha256 ?? '') ? request.sourceSha256! : null)
    sourceIds.add(await registerPostgresEnterpriseSource(tx, { module: 'sme-roster', businessTable: docs.length === 1 ? 'source_document' : 'roster_announcement_intake',
      versionKey, channel, listType: 'announcement', series: title, acquiredOn: null, fileId: registered?.id ?? null, sha256: digest }, [owner]))
  }
  return [...sourceIds].sort((a,b) => a-b)
}
