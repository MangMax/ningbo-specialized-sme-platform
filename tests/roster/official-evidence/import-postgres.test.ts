import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { OfficialPublishedRow, RosterImportRequest } from '../../../layers/sme-roster/lib/roster-import-client'
import { planPostgresAnnouncement } from '../../../layers/sme-roster/server/utils/announcement-plan-postgres'
import { writePostgresAnnouncement } from '../../../layers/sme-roster/server/utils/announcement-write-postgres'
import {
  applyPostgresOfficialImport, createPostgresOfficialImportState, finishPostgresOfficialImport, planPostgresOfficialImport,
} from '../../../layers/sme-roster/server/utils/official-evidence-import-postgres'
import {
  readPostgresExactEvidence, readPostgresOfficialPlanFacts,
} from '../../../layers/sme-roster/server/utils/official-evidence-postgres'

const source = 'synthetic official publication\n'
const sha256 = createHash('sha256').update(source).digest('hex')
const published = (listNo: number): OfficialPublishedRow => ({
  nameRaw: ' 原文企业 ', usccRaw: ' 91330211255994457P ', districtRaw: ' 原公布区县 ',
  declaration: { kind: 'existing', sourceDocumentId: 1, basis: 'original declaration' },
  storedFileId: 1, path: 'notice.txt', sha256, bytes: Buffer.byteLength(source),
  attachment: null, sectionKey: 'awards', listNo, page: null, sourceBindingKnown: true,
  actor: { type: 'agent', id: 'row-reviewer' }, basis: 'verified published row',
})
const coordinate = (listNo: number) => ({ sourceFile: 'notice.txt', attachment: null, listNo, page: null })
const append = (listNo: number, expectedVersion = 1) => ({
  eventId: 1, recordId: 1, enterpriseId: 1, expectedVersion,
  evidence: { ...coordinate(listNo), publishedRow: published(listNo) },
})
const request = (payload: RosterImportRequest['payload'], idempotencyKey = 'official-import'): RosterImportRequest =>
  ({ idempotencyKey, sourceKind: 'alias_evidence', sourceIdentity: 'synthetic-official', payload })

describe('PostgreSQL official evidence import transaction', () => {
  let dir: string
  let pool: pg.Pool
  let db: NodePgDatabase
  let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined

  beforeAll(async () => {
    dir = mkdtempSync('/tmp/official-import-')
    writeFileSync(join(dir, 'notice.txt'), source)
    postgres = await postgresRuntimeFixture({ dir })
    pool = new pg.Pool({ connectionString: postgres.url, options: '-c search_path=business,public' })
    db = drizzle({ client: pool })
    await pool.query(`
      INSERT INTO enterprise(id,name,name_norm) VALUES(1,'企业甲','企业甲'),(2,'企业乙','企业乙');
      INSERT INTO record(id,enterprise_id,title_code,source) VALUES(1,1,'specialized_sme','jxj'),(2,2,'specialized_sme','jxj');
      INSERT INTO record_event(id,record_id,event_type,year) VALUES(1,1,'award',2024),(2,2,'award',2024);
      INSERT INTO record_evidence(id,record_event_id,source_file,list_no) VALUES(1,1,'notice.txt',1),(10,2,'notice.txt',3);
      INSERT INTO source_document(id,source,title,path) VALUES(1,'jxj','Declared publication','notice.txt');
      INSERT INTO stored_file(id,rel_path,filename,ext,bytes,sha256,created_at)
        VALUES(1,'notice.txt','notice.txt','txt',${Buffer.byteLength(source)},'${sha256}','2025-01-01');
      INSERT INTO roster_file_classification(file_id,source,kind,title_code) VALUES(1,'jxj','announcement','specialized_sme');
      INSERT INTO import_batch(id,idempotency_key,source_kind,source_identity,created_at)
        VALUES(1,'official-import','alias_evidence','synthetic-official','2025-01-01');
      SELECT setval(pg_get_serial_sequence('record_evidence', 'id'), 10);
      SELECT setval(pg_get_serial_sequence('record_event', 'id'), 2);
    `)
  }, 60_000)

  afterAll(async () => {
    try {
      await pool?.end()
    } finally {
      try { postgres?.close() }
      finally { if (dir) rmSync(dir, { recursive: true, force: true }) }
    }
  })

  it('binds an append to the preflight hash and preserves the original row and import provenance', async () => {
    const input = request({ officialEvidenceAppends: [append(2)] })
    const hash = (await db.transaction(tx => planPostgresOfficialImport(tx, input, { filesDir: dir }),
      { isolationLevel: 'repeatable read' }))?.planHash
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    const result = await db.transaction(async tx => {
      const plan = await planPostgresOfficialImport(tx, input, { filesDir: dir })
      expect(plan?.planHash).toBe(hash)
      return applyPostgresOfficialImport(tx, plan!, 1, hash!)
    }, { isolationLevel: 'serializable' })
    expect(result).toMatchObject({ ok: true, kind: 'official_evidence', detail: {
      evidence: [{ evidenceId: 11, eventId: 1, revision: 1 }], rowsWritten: 1,
    } })
    expect(await readPostgresExactEvidence(db, 1)).toMatchObject({ coordinate: coordinate(1), event: { revision: 2 } })
    expect(await readPostgresExactEvidence(db, 11)).toMatchObject({ coordinate: coordinate(2), event: { revision: 2 } })
    expect(await readPostgresOfficialPlanFacts(db, { id: 11 })).toMatchObject({
      nameRaw: ' 原文企业 ', usccRaw: ' 91330211255994457P ', districtRaw: ' 原公布区县 ',
      capturedEnterpriseId: 1, capturedRecordId: 1, sourceDocumentId: 1, command: { kind: 'import', batchId: 1 },
    })
  })

  it('resolves an append and correction together, rejects a stale plan, and rolls back staged facts with its caller', async () => {
    const before = await readPostgresExactEvidence(db, 10)
    const correction = {
      evidenceId: 10, eventId: 2, recordId: 2, enterpriseId: 2, expectedVersion: before.version,
      coordinate: coordinate(4), expectedRowRevision: 0, publishedRow: published(4),
    }
    const input = request({
      officialEvidenceAppends: [{ ...append(4), eventId: 2, recordId: 2, enterpriseId: 2 }],
      officialEvidenceCorrections: { actor: { type: 'user', id: 'coordinate-reviewer' }, basis: 'original row 4', operations: [correction] },
    })
    const hash = (await db.transaction(tx => planPostgresOfficialImport(tx, input, { filesDir: dir }),
      { isolationLevel: 'repeatable read' }))?.planHash
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    const runImport = (submittedHash: string, rejectAfterWrite?: Error) => db.transaction(async tx => {
      const plan = await planPostgresOfficialImport(tx, input, { filesDir: dir })
      expect(plan?.planHash).toBe(hash)
      const result = await applyPostgresOfficialImport(tx, plan!, 1, submittedHash)
      if (rejectAfterWrite) {
        expect(await readPostgresExactEvidence(tx, 10)).toMatchObject({ coordinate: coordinate(4), event: { revision: 2 } })
        throw rejectAfterWrite
      }
      return result
    }, { isolationLevel: 'serializable' })

    await expect(runImport('f'.repeat(64))).rejects.toMatchObject({ code: 'plan_mismatch' })
    const laterFailure = new Error('A later import item failed')
    await expect(runImport(hash!, laterFailure)).rejects.toBe(laterFailure)
    expect(await readPostgresExactEvidence(db, 10)).toEqual(before)
    expect(await readPostgresOfficialPlanFacts(db, { id: 10 })).toBeNull()
    await expect(runImport(hash!)).resolves.toMatchObject({ ok: true, detail: {
      evidence: [{ evidenceId: 10, eventId: 2, unchanged: true }, { evidenceId: 10, eventId: 2, revision: 1 }], rowsWritten: 0,
    } })
    expect(await readPostgresExactEvidence(db, 10)).toMatchObject({ coordinate: coordinate(4), event: { revision: 2 } })
    expect(await readPostgresOfficialPlanFacts(db, { id: 10 })).toMatchObject({
      command: { kind: 'import', batchId: 1 }, listNo: 4, revision: 1,
    })
    const { rows } = await pool.query(`SELECT actor::json, batch_key, before::json, after::json FROM evidence_correction_audit
      WHERE evidence_id=10 ORDER BY id`)
    expect(rows).toMatchObject([{ actor: { type: 'user', id: 'coordinate-reviewer' }, batch_key: null,
      before: { coordinate: coordinate(3), eventRevision: 1, importBatchId: 1 },
      after: { coordinate: coordinate(4), eventRevision: 2, rowRevision: 1, importBatchId: 1 },
    }])
  })

  it('checks announcement coordinates and explicit evidence against one final source claim set', async () => {
    const before = await readPostgresExactEvidence(db, 1)
    const input = (link: ReturnType<typeof coordinate> & { publishedRow?: OfficialPublishedRow }) => request({
      announcement: {
        sourceDocument: { source: 'jxj', title: 'Declared publication' },
        records: [{ titleCode: 'specialized_sme', enterprise: { name: '企业乙' },
          events: [{ eventType: 'award', year: 2025, evidence: [link] }] }],
      },
      officialEvidenceAppends: [append(5, before.event.revision)],
    })
    const owners = new Map([[0, 2]]), created = new Set<number>()
    const review = 'synthetic-reviewed-decision'
    const ambiguous = await db.transaction(tx =>
      planPostgresAnnouncement(tx, input(coordinate(5)), owners, created, review, dir),
    { isolationLevel: 'serializable' })
    expect(ambiguous.errors).toMatchObject([{ kind: 'official_evidence', error: { code: 'ambiguity' } }])
    expect(ambiguous.official).toBeNull()

    const accepted = input({ ...coordinate(6), publishedRow: published(6) })
    const preview = await db.transaction(tx => planPostgresAnnouncement(tx, accepted, owners, created, review, dir),
      { isolationLevel: 'serializable' })
    expect(preview.errors).toEqual([])
    expect(preview.official).toMatch(/^[a-f0-9]{64}$/)
    expect(preview.officialPlan?.operations).toBe(2)

    const written = await db.transaction(async tx => {
      const plan = await planPostgresAnnouncement(tx, accepted, owners, created, review, dir)
      const state = createPostgresOfficialImportState()
      const [announcement] = await writePostgresAnnouncement(tx, accepted, 1, plan, state)
      const item = await applyPostgresOfficialImport(tx, plan.officialPlan!, 1, preview.official!, state)
      await finishPostgresOfficialImport(tx, state)
      return { announcement, item }
    }, { isolationLevel: 'serializable' })
    const capturedId = (written.announcement?.detail?.evidence as number[])[0]!
    const appendId = (written.item.detail?.evidence as { evidenceId: number }[])[0]!.evidenceId
    expect(await readPostgresOfficialPlanFacts(db, { id: capturedId })).toMatchObject({
      capturedEnterpriseId: 2, listNo: 6, command: { kind: 'import', batchId: 1 },
    })
    expect(await readPostgresOfficialPlanFacts(db, { id: appendId })).toMatchObject({
      capturedEnterpriseId: 1, listNo: 5, command: { kind: 'import', batchId: 1 },
    })
    expect(await readPostgresExactEvidence(db, 1)).toMatchObject({ event: { revision: before.event.revision + 1 } })
  })
})
