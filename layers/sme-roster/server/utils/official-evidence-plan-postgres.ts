import { and, asc, count, eq, isNull } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { storedFile } from '../../../../db/postgresql/file-tables'
import { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import { sourceDocument } from '../../../../db/postgresql/official-evidence-tables'
import { rosterFileClassification } from '../../../../db/postgresql/roster-file-tables'
import { projectOfficialDeclaration, projectOfficialEvidenceChanges } from './official-evidence-plan'
import { readPostgresOfficialPlanFacts } from './official-evidence-postgres'

type Db = Pick<NodePgDatabase, 'execute' | 'select'>
type ReadRequest = Exclude<ReturnType<ReturnType<typeof projectOfficialEvidenceChanges>['next']>, { done: true }>['value']

async function readOfficialPlanInput(db: Db, input: ReadRequest) {
  if (input.type === 'count') {
    const bounded = db.select({ id: recordEvidence.id }).from(recordEvidence)
      .where(eq(recordEvidence.recordEventId, input.eventId)).limit(301).as('bounded_evidence')
    const [result] = await db.select({ count: count() }).from(bounded)
    return result!.count
  }
  if (input.type === 'declaration') {
    const declaration = input.declaration
    const [document] = declaration.kind === 'existing' ? await db.select().from(sourceDocument)
      .where(eq(sourceDocument.id, declaration.sourceDocumentId)) : []
    return projectOfficialDeclaration(declaration, document)
  }
  if (input.type === 'latest') return readPostgresOfficialPlanFacts(db, { id: input.id })
  if (input.type === 'candidates') return readPostgresOfficialPlanFacts(db, { key: input.key })
  if (input.type === 'file') {
    const [row] = await db.select({
      id: storedFile.id, relPath: storedFile.relPath, bytes: storedFile.bytes, sha256: storedFile.sha256, removedAt: storedFile.removedAt,
      source: rosterFileClassification.source, kind: rosterFileClassification.kind, titleCode: rosterFileClassification.titleCode,
    }).from(storedFile).innerJoin(rosterFileClassification, eq(rosterFileClassification.fileId, storedFile.id))
      .where(eq(storedFile.id, input.id))
    return row && { ...row, bytes: Number(row.bytes) }
  }
  if (input.type === 'repoint') {
    const [row] = await db.select({
      evidence: recordEvidence, event: recordEvent, recordId: record.id, enterpriseId: enterprise.id,
    }).from(recordEvidence).innerJoin(recordEvent, eq(recordEvent.id, recordEvidence.recordEventId))
      .innerJoin(record, eq(record.id, recordEvent.recordId))
      .leftJoin(enterprise, eq(enterprise.id, record.enterpriseId))
      .where(eq(recordEvidence.id, input.id))
    return row && { ...row, event: { ...row.event, formalValidity: row.event.formalValidity === null ? null : JSON.parse(row.event.formalValidity) } }
  }
  const c = input.coordinate
  return db.select().from(recordEvidence).where(and(
    eq(recordEvidence.sourceFile, c.sourceFile), eq(recordEvidence.listNo, c.listNo!),
    c.attachment === null ? isNull(recordEvidence.attachment) : eq(recordEvidence.attachment, c.attachment),
  )).orderBy(asc(recordEvidence.id)).limit(101)
}

export async function planPostgresOfficialEvidenceChanges(db: Db, ...args: Parameters<typeof projectOfficialEvidenceChanges>) {
  const queries = projectOfficialEvidenceChanges(...args)
  let next = queries.next()
  while (!next.done) next = queries.next(await readOfficialPlanInput(db, next.value))
  return next.value
}
