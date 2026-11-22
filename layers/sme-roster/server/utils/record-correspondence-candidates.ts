import { type CandidateInput, projectCandidateRows } from './record-correspondence-candidate-projection'
import { asc, eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import type { PlatformObservationFact } from '../../lib/platform/observation-facts'
import { readCandidateTargetFacts, readCandidateTargetPositions, readCandidateTargetQueries, readCandidateTargetRelations, selectCandidateTargetPage } from './candidate-target-sources'
import { readPlatformBusinessGroups } from './platform-business-record-read'
import { correspondenceTable, externalRelationColumn } from './record-correspondence-store'
type Db = BetterSQLite3Database<typeof schema>
/** Keep SQLite parameter lists bounded, preserving historical ID ordering and duplicate-ID semantics. */
function batchesOf(ids: number[]) {
  const sorted = [...new Set(ids)].sort((a, b) => a - b)
  return Array.from({ length: Math.ceil(sorted.length / 400) }, (_, i) => sorted.slice(i * 400, (i + 1) * 400))
}
export function generateCandidates(db: Db, input: CandidateInput, selection?: { relationIds: number[]; total: number }) {
  return db.transaction(() => generateCandidateSnapshot(db, input, selection))
}
function generateCandidateSnapshot(db: Db, input: CandidateInput, selection?: { relationIds: number[]; total: number }) {
  const event = input.eventId ? db.select({ event: schema.recordEvent, record: schema.record }).from(schema.recordEvent).innerJoin(schema.record, eq(schema.recordEvent.recordId, schema.record.id)).where(eq(schema.recordEvent.id, input.eventId)).get() : null
  if (input.eventId && (!event || event.record.source !== 'jxj')) return null
  const enterpriseId = event?.record.enterpriseId ?? input.enterpriseId!
  const titleCode = event?.record.titleCode ?? input.titleCode!
  const enterprise = db.select().from(schema.enterprise).where(eq(schema.enterprise.id, enterpriseId)).get()
  if (!enterprise || !db.select().from(schema.title).where(eq(schema.title.code, titleCode)).get()) return null
  const identity = normalizeUscc(event?.record.usccRaw ?? enterprise.usccNorm)
  // These public candidates never expose raw_response or archived row arrays.
  const queries = batchesOf(input.queryIds).flatMap(ids => readCandidateTargetQueries(db, ids))
  const batches = batchesOf(input.exportBatchIds).flatMap(ids => db.select().from(schema.platformExportBatch).where(inArray(schema.platformExportBatch.id, ids)).orderBy(asc(schema.platformExportBatch.id)).all())
  if (queries.length !== new Set(input.queryIds).size || batches.length !== new Set(input.exportBatchIds).size) return null
  const targetPage = !selection ? selectCandidateTargetPage(db, { queryIds: input.queryIds, enterpriseId, identity, titleCode, event: !!event, page: input.page, pageSize: input.pageSize }) : null
  const x = schema.platformExportRow, c = correspondenceTable(db)
  const queriesById = new Map(queries.map(q => [q.id, q]))
  // Identity/scope columns only. Source-specific facts are read after scoping below.
  const relations = batchesOf(queries.filter(q => ['success', 'partial'].includes(q.status)).map(q => q.id)).flatMap(ids => readCandidateTargetRelations(db, ids, selection?.relationIds ?? targetPage?.ids))
  const exports = batchesOf(event && identity ? batches.filter(b => b.importStatus === 'imported' && b.titleCode === titleCode).map(b => b.id) : []).flatMap(ids => db.select({ id: x.id, batchId: x.batchId, sourceRowNo: x.sourceRowNo, usccRaw: x.usccRaw }).from(x).where(inArray(x.batchId, ids)).orderBy(asc(x.batchId), asc(x.sourceRowNo)).all())
  const relevantRelations = relations.filter(r => (!r.enterpriseId || r.enterpriseId === enterpriseId) && ((identity && normalizeUscc(r.usccRaw) === identity) || (selection && !normalizeUscc(r.usccRaw) && r.enterpriseId === enterpriseId && r.verificationStatus === 'confirmed')))
  // Scope by selected query/owner/title/role first; only then read source-specific facts.
  const factsByRelation = new Map<number, PlatformObservationFact>()
  for (const [interfaceName, scopedRows] of Map.groupBy(relevantRelations, row => queriesById.get(row.queryId)!.interface)) {
    for (const [relationId, fact] of (readCandidateTargetFacts)(db, interfaceName, scopedRows.map(row => row.id))) factsByRelation.set(relationId, fact)
  }
  const positions = new Map(batchesOf(relevantRelations.map(r => r.id)).flatMap(ids => [...readCandidateTargetPositions(db, ids)]))
  const relevantExports = exports.filter(r => identity && normalizeUscc(r.usccRaw) === identity)
  const priors = batchesOf(relevantExports.map(r => r.id)).map(ids => inArray(c.exportRowId, ids))
    .flatMap(where => db.select({ id: c.id, eventId: c.eventId, type: c.type, role: c.role, relationId: externalRelationColumn(db), exportRowId: c.exportRowId, revision: c.revision }).from(c).where(where).orderBy(asc(c.id)).all())
  const steps = projectCandidateRows(input, { event, enterprise, queries, batches, relevantRelations, relevantExports,
    factsByRelation, positions, priors, targetPage, selection })
  const pending = steps.next()
  if (pending.done) return pending.value
  const final = steps.next(readPlatformBusinessGroups(db, pending.value))
  if (final.done) return final.value
  throw new Error('Candidate projection did not finish')
}
export { type CandidateInput, projectCandidateRows } from './record-correspondence-candidate-projection'
