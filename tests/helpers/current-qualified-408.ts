import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../../db/schema'
import { TITLE_SEED } from '../../db/titles'

export const AS_OF_408 = '2026-06-01T00:00:00.000Z'

/** Private synthetic SQLite setup only; never an announcement import payload.
 * No DB is opened until a future test explicitly calls this factory.
 */
export function currentQualified408Fixture() {
  const sqlite = new Database(':memory:')
  try {
    sqlite.pragma('foreign_keys = ON')
    const db = drizzle(sqlite, { schema })
    migrate(db, { migrationsFolder: 'db/migrations' })
    db.insert(schema.title).values([...TITLE_SEED]).run()

    function formalEnterprise(name: string, pendingReview: boolean) {
      // NULL identity is deliberate: no unvalidated dummy USCC is reusable as evidence.
      const enterprise = db.insert(schema.enterprise).values({
        name, nameNorm: name, usccNorm: null, district: '鄞州区', city: '宁波市',
      }).returning().get()
      const record = db.insert(schema.record).values({
        enterpriseId: enterprise.id, titleCode: 'innovative_sme', source: 'jxj', nameRaw: name,
      }).returning().get()
      const award = db.insert(schema.recordEvent).values({
        recordId: record.id, eventType: 'award', year: pendingReview ? 2022 : 2025,
        decidedYear: pendingReview ? 2022 : 2025, batchSeq: 1,
      }).returning().get()
      const evidenceFor = (eventId: number, listNo: number) => db.insert(schema.recordEvidence).values({
        recordEventId: eventId, sourceFile: 'synthetic/408/official-announcement.pdf',
        attachment: 'synthetic_408_formal_roster', listNo,
      }).returning().get()
      const awardEvidence = evidenceFor(award.id, 1)
      const review = pendingReview ? db.insert(schema.recordEvent).values({
        recordId: record.id, eventType: 'review', year: 2022, batchSeq: 1,
        decidedYear: null, reviewOutcome: null,
      }).returning().get() : null
      const reviewEvidence = review ? evidenceFor(review.id, 2) : null
      return { enterprise, record, award, awardEvidence, review, reviewEvidence }
    }

    function failedNameQuery(name: string) {
      return db.insert(schema.platformQuery).values({
        interface: 'business_list', queryKey: `name:${name}`, titleCode: 'innovative_sme',
        rdjb: '1', queriedAt: '2026-05-01T00:00:00.000Z', status: 'failed',
      }).returning().get()
    }

    function totalChanges() {
      return (sqlite.prepare('select total_changes() as changes').get() as { changes: number }).changes
    }

    return { sqlite, formalEnterprise, failedNameQuery, totalChanges, close: () => sqlite.close() }
  } catch (error) {
    sqlite.close()
    throw error
  }
}

// Additional matrix capabilities; the original fixture and its seeds above stay byte-for-byte intact.
import { eq } from 'drizzle-orm'
import type { CurrentTitle } from '../../lib/roster/current-titles'
import type { PlatformRow } from '../../lib/platform/types'
import { reviewCurrentExportDecision } from './current-export-decisions'
import { preflightRecordCorrespondences, commitRecordCorrespondences } from '../../server/utils/record-correspondence'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type MatrixEvent408 = { eventType: 'award' | 'review'; year: number | null; batchSeq?: number | null; decidedYear?: number | null; reviewOutcome?: 'passed' | 'failed' | null }

export function matrix408(sqlite: Database.Database) {
  const db = drizzle(sqlite, { schema })
  function formal(name: string, events: MatrixEvent408[] = [{ eventType: 'award', year: 2025, decidedYear: 2025, batchSeq: 1 }], options: { title?: CurrentTitle; enterpriseId?: number; uscc?: string; district?: string } = {}) {
    const enterprise = options.enterpriseId == null ? db.insert(schema.enterprise).values({
      name, nameNorm: name, usccNorm: options.uscc ?? null, city: '宁波市', district: options.district ?? '鄞州区',
    }).returning().get() : db.select().from(schema.enterprise).where(eq(schema.enterprise.id, options.enterpriseId)).get()!
    const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, source: 'jxj', titleCode: options.title ?? 'innovative_sme', nameRaw: enterprise.name, usccRaw: enterprise.usccNorm }).returning().get()
    const saved = events.map((event, index) => {
      const row = db.insert(schema.recordEvent).values({ recordId: record.id, ...event }).returning().get()
      db.insert(schema.recordEvidence).values({ recordEventId: row.id, sourceFile: 'synthetic/408/matrix.pdf', listNo: index + 1 }).run()
      return row
    })
    return { enterprise, record, events: saved }
  }
  function subject(enterpriseId: number, reasonCode: 'deregistered' | 'moved_out' | 'moved_in', titleCode: CurrentTitle = 'innovative_sme', effectiveAt = '2026-01-01T00:00:00Z') {
    const decision = db.insert(schema.differenceReason).values({ enterpriseId, titleCode, direction: 'missing_in_miit', status: 'confirmed_reason', reasonCode, verificationStatus: 'confirmed', lifecycleAction: 'replace', basis: 'synthetic_408_subject_evidence', effectiveAt, recordedAt: effectiveAt, measureCode: 'keep_history' }).returning().get()
    reviewCurrentExportDecision(db, decision)
    return decision
  }
  function alias(enterpriseId: number, name: string, verificationStatus: 'confirmed' | 'pending') {
    db.insert(schema.enterpriseAlias).values({ enterpriseId, name, nameNorm: name, verificationStatus, sourceKind: 'manual' }).run()
  }
  function platform(enterpriseId: number, status: 'no_record' | 'failed' | 'not_queried' | 'success', rowStatus?: string) {
    const enterprise = db.select().from(schema.enterprise).where(eq(schema.enterprise.id, enterpriseId)).get()!
    const query = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: enterprise.usccNorm ?? `name:${enterprise.nameNorm}`, titleCode: 'innovative_sme', rdjb: '1', queriedAt: '2026-05-01T00:00:00Z', status }).returning().get()
    if (rowStatus != null) db.insert(schema.platformRelation).values({ queryId: query.id, enterpriseId, sequenceNo: 1, nameRaw: enterprise.name, usccRaw: enterprise.usccNorm, status: rowStatus, verificationStatus: 'confirmed', matchBasis: 'manual' }).run()
    return query
  }
  function recognized(enterpriseId: number, eventId: number, rawFields: PlatformRow) {
    const enterprise = db.select().from(schema.enterprise).where(eq(schema.enterprise.id, enterpriseId)).get()!
    const event = db.select().from(schema.recordEvent).where(eq(schema.recordEvent.id, eventId)).get()!
    const record = db.select().from(schema.record).where(eq(schema.record.id, event.recordId)).get()!
    const titleCode = record.titleCode as CurrentTitle
    const rdjb = { innovative_sme: '1', specialized_sme: '2', little_giant: '3' }[titleCode]
    // Different observations retain independent rows and event bindings.
    const ordinal = (sqlite.prepare('select count(*) n from platform_query').get() as { n: number }).n
    const stamp = `2026-05-01T00:00:${String(ordinal).padStart(2, '0')}Z`
    const query = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: enterprise.usccNorm ?? `name:${enterprise.nameNorm}`, titleCode, rdjb, queriedAt: stamp, status: 'success', collectionEvidence: {
      source: 'queryBusList', status: 'success', effectiveConditions: { combination: 'and' }, titleScope: { mode: 'selected', rdjb: [rdjb] }, queriedAt: stamp, completedAt: stamp, rows: [rawFields], pages: [{ source: 'queryBusList', rdjb, page: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, maxPage: 1, error: null }], fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 },
    } }).returning().get()
    const relation = db.insert(schema.platformRelation).values({ queryId: query.id, enterpriseId, sequenceNo: 1, nameRaw: enterprise.name, usccRaw: enterprise.usccNorm, rawFields, verificationStatus: 'confirmed', matchBasis: 'manual' }).returning().get()
    const request = { idempotencyKey: `synthetic408-${relation.id}`, sourceIdentity: `synthetic/408/${relation.id}`, actor: { type: 'agent' as const, id: 'synthetic408' }, basis: 'synthetic_408_confirmed_row', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'create' as const, status: 'confirmed' as const, edge: { type: 'event_recognized' as const, eventId, relationId: relation.id, role: 'recognized_corrob' as const } }] }
    const plan = preflightRecordCorrespondences(db, request)
    commitRecordCorrespondences(db, request, plan.planHash)
    return relation
  }
  return { db, formal, subject, alias, platform, recognized }
}

/** Isolated file DB for the later two-connection snapshot control, never a business DB copy. */
export function fileMatrix408() {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic408-snapshot-'))
  const path = join(dir, 'synthetic.sqlite')
  const sqlite = new Database(path)
  try {
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    const db = drizzle(sqlite, { schema })
    migrate(db, { migrationsFolder: 'db/migrations' })
    db.insert(schema.title).values([...TITLE_SEED]).run()
    return { sqlite, ...matrix408(sqlite), writer: () => new Database(path), close() { sqlite.close(); rmSync(dir, { recursive: true, force: true }) } }
  } catch (error) { sqlite.close(); rmSync(dir, { recursive: true, force: true }); throw error }
}

// Appended after the frozen 41-case fixture prefix: literal reference/scope controls.
import { createHash } from 'node:crypto'
export function refLiterals408(sqlite: Database.Database) {
  const db = drizzle(sqlite, { schema })
  type Page = NonNullable<typeof schema.platformQuery.$inferInsert.collectionEvidence>['pages'][number]
  function query(titleCode: CurrentTitle | null, rdjb: string, pages?: Page[]) {
    const ordinal = (sqlite.prepare('select count(*) n from platform_query').get() as { n: number }).n
    const stamp = `2026-05-02T00:00:${String(ordinal).padStart(2, '0')}Z`
    return db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: 'synthetic_408_ref_scope', titleCode, rdjb, queriedAt: stamp, status: 'success', collectionEvidence: pages ? {
      source: 'businessList', status: 'success', effectiveConditions: { combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['1', '2', '3'] }, queriedAt: stamp, completedAt: stamp,
      rows: [], pages, fetchedCount: pages.reduce((n, page) => n + page.fetchedCount, 0), declaredTotal: null, completeness: 'complete', fullRange: true, unfinished: [], error: null,
      limits: { maxRequests: 10, maxRows: 100, maxDurationMs: 1000, pageSize: 50 },
    } : null }).returning().get()
  }
  function relation(queryId: number, sequenceNo: number, enterpriseId: number | null, usccRaw: string | null, status: string) {
    return db.insert(schema.platformRelation).values({ queryId, sequenceNo, enterpriseId, usccRaw, status, year: 2025, batch: '2025-1', verificationStatus: 'confirmed', matchBasis: 'manual' }).returning().get()
  }
  function officialFile() {
    const bytes = Buffer.from('synthetic_408_formal_source_bytes')
    return db.insert(schema.storedFile).values({ relPath: 'synthetic/408/matrix.pdf', filename: 'matrix.pdf', ext: 'pdf', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), source: 'jxj', kind: 'announcement' }).returning().get()
  }
  // Only legacy non-confirmed states are constructed directly. Confirmed edges
  // in the new controls always use the existing preflight/commit capability.
  function legacyRef(key: string, status: 'candidate' | 'rejected' | 'unlinked', enterpriseId: number, titleCode: CurrentTitle, fields: { eventId?: number; predecessorEventId?: number; relationId?: number } = {}) {
    return db.insert(schema.recordCorrespondence).values({ edgeKey: `synthetic408-${key}`, type: 'later_process', role: 'followup_review', enterpriseId, titleCode, status, revision: 1,
      eventId: null, predecessorEventId: null, relationId: null, exportRowId: null, ...fields,
      targetIdentity: {}, provenance: {}, sourceFingerprint: createHash('sha256').update(`synthetic408-${key}`).digest('hex'), ruleId: 'synthetic_legacy', ruleVersion: '1', createdAt: AS_OF_408,
    }).returning().get()
  }
  return { db, query, relation, officialFile, legacyRef }
}

// Private #408 adapter for complete current-qualified JSON rows across requests.
import assert408 from 'node:assert/strict'
import { assertEnterpriseDetailSnapshotEqual } from './enterprise-detail-snapshot'

function currentQualifiedObject408(value: unknown, label: string): Record<string, unknown> {
  assert408(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  assert408.equal(Object.getPrototypeOf(value), Object.prototype, `${label} must be a plain object`)
  return value as Record<string, unknown>
}

/** Validate complete T2 first; only the shared helper may normalize asOf/digest.
 * Every other own enumerable row field, including future or wrapper-named keys,
 * stays inside currentQualifiedRow and participates in strict deep equality.
 */
export function assertCurrentQualifiedRowsSnapshotEqual408(actual: unknown, expected: unknown): void {
  assert408(Array.isArray(actual), 'actual current-qualified rows must be an array')
  assert408(Array.isArray(expected), 'expected current-qualified rows must be an array')
  assert408.equal(actual.length, expected.length, 'current-qualified row counts must agree')
  const wrap = (value: unknown, label: string) => {
    const row = currentQualifiedObject408(value, label)
    assert408(Object.hasOwn(row, 'enterpriseId'), `${label} must own enterpriseId`)
    assert408(Object.hasOwn(row, 'qualificationAssessment'), `${label} must own qualificationAssessment`)
    const { qualificationAssessment, ...currentQualifiedRow } = row
    const assessment = currentQualifiedObject408(qualificationAssessment, `${label}.qualificationAssessment`)
    assert408(Array.isArray(assessment.titles), `${label}.titles must be an array`)
    const titles: unknown[] = assessment.titles
    const titleCodes = titles.map((value, index) => {
      const title = currentQualifiedObject408(value, `${label}.titles[${index}]`)
      const versions = currentQualifiedObject408(title.versions, `${label}.titles[${index}].versions`)
      for (const field of ['facts', 'sources', 'decisions', 'observations'] as const) {
        const version = versions[field]
        assert408(Object.hasOwn(versions, field) && typeof version === 'string' && version.trim().length > 0, `${label}.${field} version is required`)
      }
      return title.titleCode
    })
    assert408.deepStrictEqual(titleCodes, ['little_giant', 'specialized_sme', 'innovative_sme'], `${label} must retain all three titles in canonical order`)
    return { enterprise: { enterpriseId: row.enterpriseId }, qualificationAssessment: assessment, currentQualifiedRow }
  }
  for (let index = 0; index < actual.length; index++) {
    assertEnterpriseDetailSnapshotEqual(wrap(actual[index], `actual row ${index}`), wrap(expected[index], `expected row ${index}`))
  }
}
