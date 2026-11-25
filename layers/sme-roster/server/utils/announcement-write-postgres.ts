import { and, eq, isNull } from 'drizzle-orm'
import { storedFile } from '../../../../db/postgresql/file-tables'
import { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import { officialEvidenceRowRevision, sourceDocument } from '../../../../db/postgresql/official-evidence-tables'
import { rosterFileClassification } from '../../../../db/postgresql/roster-file-tables'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { registerEnterpriseSource } from '../../../core/server/public'
import type { RosterImportRequest, RosterImportItemResult } from '../../lib/roster-import-client'
import { readPostgresAnnouncementEvents, repointPostgresAnnouncementEvidence } from './announcement-evidence-postgres'
import { announcementEvidenceCoordinate, evidenceRepointPlanFingerprint, eventCoordinates, matchesEventCoordinates } from './roster-import-model'
import { officialFactFailure, readOfficialFile } from './official-evidence-claim-model'
import { resolvePostgresOfficialDeclaration, writePostgresOfficialPublishedRow } from './official-evidence-write-postgres'
import type { planPostgresAnnouncement } from './announcement-plan-postgres'
import { ImportReceiptError } from './import-receipt-model'
import { createPostgresOfficialImportState, finishPostgresOfficialImport, type PostgresOfficialImportState } from './official-evidence-import-postgres'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Plan = Awaited<ReturnType<typeof planPostgresAnnouncement>>
type Row = Plan['rows'][number]
const textOrNull = (value: unknown) => typeof value === 'string' ? value.trim() || null : null

async function ordinarySourceDocument(tx: Tx, request: RosterImportRequest, source: typeof sourceDocument.$inferInsert.source) {
  const document = request.payload.announcement!.sourceDocument
  const title = textOrNull(document.title) ?? request.sourceIdentity
  const number = textOrNull(document.docNumber)
  const [previous] = await tx.select({ id: sourceDocument.id }).from(sourceDocument).where(and(
    eq(sourceDocument.source, source), eq(sourceDocument.title, title),
    number === null ? isNull(sourceDocument.docNumber) : eq(sourceDocument.docNumber, number),
  )).orderBy(sourceDocument.id).limit(1)
  if (previous) return { id: previous.id, created: false }
  const [row] = await tx.insert(sourceDocument).values({
    source, title, docNumber: number, issueDate: textOrNull(document.issueDate), path: request.sourceIdentity,
  }).returning({ id: sourceDocument.id })
  return { id: row!.id, created: true }
}

async function repointEvidence(tx: Tx, row: Row, changedEvents: Map<number, number>, files: Set<string>) {
  let count = 0
  for (const target of row.repoints) {
    const changed = await repointPostgresAnnouncementEvidence(tx, target)
    if (!changed) continue
    if (changed.lostPage) changedEvents.set(target.recordEventId, changed.revision)
    files.add(target.fromSourceFile).add(target.sourceFile)
    count++
  }
  return count
}

export async function writePostgresAnnouncement(tx: Tx, request: RosterImportRequest, batchId: number, plan: Plan, sharedState?: PostgresOfficialImportState) {
  if (!sharedState && (plan.officialPlan?.appendTargets.length || plan.officialPlan?.correctionTargets.length)) {
    return officialFactFailure('invalid_input', 'Explicit official evidence operations require the shared import state')
  }
  const state = sharedState ?? createPostgresOfficialImportState()
  const { declarations, changedEvents, files } = state
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
      const [inserted] = await tx.insert(record).values({
        enterpriseId: row.owner, titleCode: row.titleCode, source: row.source, district: row.district,
        usccRaw: row.uscc, nameRaw: row.name, qualityFlags: '[]',
      }).returning({ id: record.id })
      recordId = inserted!.id
      records.set(key, recordId)
    }
    const evidenceRepointed = await repointEvidence(tx, row, changedEvents, files)
    const existing = recordCreated ? [] : await readPostgresAnnouncementEvents(tx, eq(recordEvent.recordId, recordId))
    const events: number[] = [], evidenceIds: number[] = []
    let skipped = 0
    for (const event of row.events) {
      const coordinate = eventCoordinates(recordId, event)
      if (existing.some(stored => matchesEventCoordinates(stored, coordinate))) { skipped++; continue }
      const [inserted] = await tx.insert(recordEvent).values({
        ...coordinate, eventType: coordinate.eventType as typeof event.eventType,
        reviewOutcome: coordinate.reviewOutcome as NonNullable<typeof event.reviewOutcome> | null,
        sortKey: coordinate.year ?? 0, revision: 1,
      }).returning({ id: recordEvent.id })
      const eventId = inserted!.id
      events.push(eventId)
      existing.push({ ...coordinate, eventType: coordinate.eventType as typeof event.eventType,
        reviewOutcome: coordinate.reviewOutcome as NonNullable<typeof event.reviewOutcome> | null,
        id: eventId, revision: 1, formalValidity: null, sortKey: coordinate.year ?? 0 })
      for (const entry of event.evidence ?? []) {
        const link = announcementEvidenceCoordinate(entry)
        const [created] = await tx.insert(recordEvidence).values({
          recordEventId: eventId, ...link,
        }).returning({ id: recordEvidence.id })
        const evidenceId = created!.id
        evidenceIds.push(evidenceId)
        files.add(link.sourceFile)
        if (entry.publishedRow) {
          await writePostgresOfficialPublishedRow(tx, entry.publishedRow, evidenceId, 0, { kind: 'import', batchId }, declarations)
        }
      }
    }
    const rowsWritten = Number(source.created) + declarations.size - beforeDeclarations + Number(row.created) + Number(recordCreated) + events.length + evidenceIds.length
    items.push({ ok: true, kind: 'record_event', ref: 'record:' + recordId, detail: {
      enterpriseId: row.owner, recordId, sourceDocumentId: source.id, events, evidence: evidenceIds, skipped,
      evidenceRepointed, evidenceRepointTargets: row.repoints, evidenceRepointPlanFingerprint: fingerprint, rowsWritten,
    } })
  }
  if (!sharedState) {
    await finishPostgresOfficialImport(tx, state)
    if (plan.official !== null) items.push({ ok: true, kind: 'official_evidence', ref: 'official_evidence', detail: { evidence: [], rowsWritten: 0 } })
  }
  return items
}

export async function attachPostgresAnnouncementSources(tx: Tx, intakeId: number, batchId: number, request: RosterImportRequest,
  owners: ReadonlyMap<number,number>, filesDir?: string) {
  const [file] = await tx.select({ id: storedFile.id, sha256: storedFile.sha256, source: rosterFileClassification.source })
    .from(storedFile).innerJoin(rosterFileClassification, eq(rosterFileClassification.fileId, storedFile.id))
    .where(and(eq(storedFile.relPath, request.sourceIdentity), eq(rosterFileClassification.kind, 'announcement'), isNull(storedFile.removedAt)))
  if (file && (request.sourceSha256 && request.sourceSha256 !== file.sha256 ||
    filesDir && readOfficialFile(filesDir, request.sourceIdentity).sha256 !== file.sha256)) {
    throw new ImportReceiptError(409, 'source_changed', 'Registered announcement bytes differ')
  }
  const capturedRevision = officialEvidenceRowRevision
  const captured = await tx.select({
    id: sourceDocument.id, source: sourceDocument.source, title: sourceDocument.title, fileId: capturedRevision.storedFileId,
    sha256: capturedRevision.sha256, owner: record.enterpriseId,
  }).from(capturedRevision).innerJoin(sourceDocument, eq(sourceDocument.id, capturedRevision.sourceDocumentId))
    .innerJoin(recordEvent, eq(recordEvent.id, capturedRevision.eventId)).innerJoin(record, eq(record.id, recordEvent.recordId))
    .where(and(eq(capturedRevision.importBatchId, batchId), eq(capturedRevision.sourceBindingKnown, 1)))
    .orderBy(capturedRevision.evidenceId, capturedRevision.revision)
  const sourceIds = new Set<number>(), capturedOwners = new Set<string>()
  for (const row of captured) {
    sourceIds.add(await registerEnterpriseSource(tx, { module: 'sme-roster', businessTable: 'source_document',
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
    const docs = registered ? await tx.select({ id: sourceDocument.id }).from(sourceDocument).where(and(
      eq(sourceDocument.path, request.sourceIdentity), eq(sourceDocument.source, channel), eq(sourceDocument.title, title),
    )).limit(2) : []
    const versionKey = docs.length === 1 ? docs[0]!.id + ':' + registered!.sha256 : intakeId + ':' + channel
    const digest = registered?.sha256 ?? (/^[a-f0-9]{64}$/.test(request.sourceSha256 ?? '') ? request.sourceSha256! : null)
    sourceIds.add(await registerEnterpriseSource(tx, { module: 'sme-roster', businessTable: docs.length === 1 ? 'source_document' : 'roster_announcement_intake',
      versionKey, channel, listType: 'announcement', series: title, acquiredOn: null, fileId: registered?.id ?? null, sha256: digest }, [owner]))
  }
  return [...sourceIds].sort((a,b) => a-b)
}
