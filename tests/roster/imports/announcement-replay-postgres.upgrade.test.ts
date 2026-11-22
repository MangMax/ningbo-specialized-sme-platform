import { expect, test } from 'vitest'
import type { RosterImportRequest } from '../../../layers/sme-roster/lib/roster-import-client'
import { planPostgresAnnouncementReplay, writePostgresAnnouncementReplay } from '../../../layers/sme-roster/server/utils/announcement-replay-postgres'
import { evidenceRepointPlanFingerprint, publicRosterImportItems } from '../../../layers/sme-roster/server/utils/roster-import'
import { pg19Bin, withHistoricalImportDatabase } from './fixtures/postgres-historical-import'

const hash = 'a'.repeat(64)
const request: RosterImportRequest = {
  idempotencyKey: 'announcement', sourceKind: 'announcement', sourceIdentity: 'library.xlsx', sourceSha256: hash,
  payload: { announcement: { sourceDocument: { source: 'jxj', title: '名单' }, records: [
    { enterprise: { name: '企业甲' }, titleCode: 'specialized_sme', events: [
      { eventType: 'award', year: 2024, evidence: [{ sourceFile: 'library.xlsx', attachment: '原名', listNo: 3 }] },
      { eventType: 'award', year: 2025, evidence: [{ sourceFile: 'library.xlsx' }] },
    ] },
    { enterprise: { name: '未知企业' }, titleCode: 'specialized_sme' },
  ] }, differences: [{ titleCode: 'specialized_sme', direction: 'missing_in_miit', recordedAt: '2024-12-01' }] },
}

const seed = `
  INSERT INTO enterprise(id,name,name_norm) VALUES (7,'企业甲','企业甲');
  INSERT INTO record(id,enterprise_id,title_code,source) VALUES (17,7,'specialized_sme','jxj');
  INSERT INTO record_event(id,record_id,event_type,year) VALUES (29,17,'award',2024);
  INSERT INTO record_evidence(id,record_event_id,source_file,attachment,list_no,page)
    VALUES (37,29,'outside.pdf','原名',3,9);
  INSERT INTO stored_file(id,rel_path,filename,ext,bytes,sha256,created_at)
    VALUES (40,'library.xlsx','library.xlsx','xlsx',5,'${hash}','2025-01-01');
  INSERT INTO import_batch(id,idempotency_key,source_kind,source_identity,source_sha256,status,created_at)
    VALUES (51,'historical','announcement','outside.pdf','${hash}','committed','2025-01-01');
`

test.runIf(Boolean(pg19Bin))('repoints only existing equal-content evidence and advances the revision when a page is cleared', async () => {
  await withHistoricalImportDatabase(seed, async (pool, db) => {
    const replay = (originalBatch?: Parameters<typeof planPostgresAnnouncementReplay>[2]) => db.transaction(async tx => {
      const plan = await planPostgresAnnouncementReplay(tx, request, originalBatch)
      expect(plan.preflight.conflicts).toEqual([])
      return writePostgresAnnouncementReplay(tx, request, plan)
    })
    const mismatched = structuredClone(request)
    mismatched.sourceIdentity = 'other.xlsx'
    mismatched.sourceSha256 = 'b'.repeat(64)
    mismatched.payload.announcement!.records[0]!.events![0]!.evidence![0]!.sourceFile = 'other.xlsx'
    await db.transaction(async tx => {
      const plan = await planPostgresAnnouncementReplay(tx, mismatched)
      expect(plan.preflight.conflicts).toMatchObject([{ error: { code: 'evidence_content_hash_mismatch' } }])
      expect(await writePostgresAnnouncementReplay(tx, mismatched, plan)).toMatchObject({ update: 0, evidenceRepointed: 0 })
    })

    let ledgerItems: Awaited<ReturnType<typeof writePostgresAnnouncementReplay>>['items'] = []
    await expect(db.transaction(async tx => {
      const plan = await planPostgresAnnouncementReplay(tx, request)
      const result = await writePostgresAnnouncementReplay(tx, request, plan)
      expect(result).toMatchObject({ update: 1, evidenceRepointed: 1 })
      ledgerItems = result.items
      expect(ledgerItems[0]?.detail?.evidenceRepointTargets).toEqual([
        { id: 37, recordId: 17, recordEventId: 29, fromSourceFile: 'outside.pdf', sourceFile: 'library.xlsx' },
      ])
      expect(publicRosterImportItems(ledgerItems)[0]?.detail).not.toHaveProperty('evidenceRepointTargets')
      throw new Error('receipt failed')
    })).rejects.toThrow('receipt failed')
    expect((await pool.query('SELECT source_file,page FROM record_evidence')).rows)
      .toEqual([{ source_file: 'outside.pdf', page: '9' }])
    expect((await pool.query('SELECT revision FROM record_event WHERE id=29')).rows).toEqual([{ revision: '1' }])

    const originalBatch = {
      status: 'committed', kind: 'announcement', identity: 'library.xlsx', sha256: hash,
      items: [{ detail: { evidenceRepointPlanFingerprint: evidenceRepointPlanFingerprint(request), evidenceRepointTargets: [] } }],
    }
    await db.transaction(async tx => {
      const plan = await planPostgresAnnouncementReplay(tx, request, originalBatch)
      expect(await writePostgresAnnouncementReplay(tx, request, plan)).toMatchObject({ update: 0, evidenceRepointed: 0 })
    })
    expect(await replay({ ...originalBatch, items: ledgerItems })).toMatchObject({ evidenceRepointed: 1, update: 1, items: [
      { ok: true, kind: 'record', ref: 'record:17', detail: { enterpriseId: 7, recordId: 17, rowsWritten: 0 } },
      { ok: true, kind: 'record', ref: 'record:1', detail: { enterpriseId: null } },
    ] })
    expect(await replay()).toMatchObject({ evidenceRepointed: 0, update: 0 })
    expect((await pool.query(`SELECT v.id,v.source_file,v.attachment,v.list_no,v.page,e.revision
      FROM record_evidence v JOIN record_event e ON e.id=v.record_event_id`)).rows).toEqual([
      { id: '37', source_file: 'library.xlsx', attachment: '原名', list_no: '3', page: null, revision: '2' },
    ])
    expect((await pool.query(`SELECT (SELECT count(*) FROM enterprise) AS enterprises,
      (SELECT count(*) FROM record_event) AS events, (SELECT count(*) FROM difference_reason) AS differences`)).rows)
      .toEqual([{ enterprises: '1', events: '1', differences: '0' }])
  })
}, 90_000)
