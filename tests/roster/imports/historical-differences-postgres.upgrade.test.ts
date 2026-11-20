import { sql } from 'drizzle-orm'
import { expect, test } from 'vitest'
import type { RosterImportDifference } from '../../../layers/sme-roster/lib/roster-import-client'
import { planPostgresImportDifference, writePostgresImportDifference } from '../../../layers/sme-roster/server/utils/difference-import-postgres'
import { pg19Bin, withHistoricalImportDatabase } from './fixtures/postgres-historical-import'

const uscc = '91330200717865622U'
const difference: RosterImportDifference = {
  enterpriseName: '企业甲', titleCode: 'specialized_sme', direction: 'missing_in_miit',
  status: 'confirmed_reason', reasonCode: 'pending_review', measureCode: 'follow_review',
  verificationStatus: 'confirmed', recordedAt: '2024-12-01',
  evidenceQueryRef: { interface: 'recognized_list', queryKey: uscc, rdjb: '2', queriedAt: '2024-11-29' },
}

test.runIf(Boolean(pg19Bin))('stores native evidence IDs while retaining legacy query IDs in historical difference items', async () => {
  await withHistoricalImportDatabase(`
    INSERT INTO enterprise(id,name,name_norm,uscc_norm) VALUES (7,'企业甲','企业甲','${uscc}');
    INSERT INTO platform_collection(id,interface,query_key,rdjb,queried_at,created_at,status,completeness,provenance_state,parse_state,rule_version)
    VALUES (11,'recognized_list','${uscc}','2','2024-11-29','2024-11-29','success','complete','captured','valid','fixture');
    INSERT INTO platform_legacy_query_alias(old_id,collection_id) VALUES (91,11);
  `, async (pool, db) => {
    const save = (input: RosterImportDifference) => db.transaction(async tx => {
      const plan = await planPostgresImportDifference(tx, input, 0)
      return writePostgresImportDifference(tx, plan)
    })
    expect(await save(difference)).toMatchObject({ ok: true, kind: 'difference', detail: {
      enterpriseId: 7, evidenceQueryId: 91, evidenceRelationId: null, rowsWritten: 1,
    } })
    expect(await save({ ...difference, reasonNote: 'must not replace the original' }))
      .toMatchObject({ ok: true, detail: { enterpriseId: 7, rowsWritten: 0 } })
    const relationRef = { ...difference.evidenceQueryRef!, sequenceNo: 1, relationKey: 'published' }
    await expect(db.transaction(async tx => {
      await tx.execute(sql`
        INSERT INTO platform_collection_page(collection_id,ordinal,rdjb,status,fetched_count,position_state)
          VALUES (11,0,'2','success',1,'unknown');
        INSERT INTO platform_business_observation(id,collection_id,sequence_no,position_state,source_relation_key,identity_state,content_state)
          VALUES (22,11,1,'unknown','published','not_indexed','not_indexed');
        INSERT INTO platform_legacy_relation_alias(old_id,observation_id) VALUES (99,22);
        INSERT INTO platform_observation_assignment(observation_id,revision,enterprise_id,match_basis,verification_status,uscc_raw,origin)
          VALUES (22,1,7,'uscc','confirmed','91330200717865622U','migrated_current');
      `)
      const command = { ...difference, recordedAt: '2024-12-02', evidenceRelationRef: relationRef }
      const valid = await planPostgresImportDifference(tx, command, 1)
      expect(await writePostgresImportDifference(tx, valid)).toMatchObject({ ok: true, detail: { evidenceRelationId: 99, rowsWritten: 1 } })
      const invalid = await planPostgresImportDifference(tx, { ...command, uscc: '91330200717865622X' }, 2)
      expect(invalid.item).toMatchObject({ ok: false, error: { code: 'evidence_subject_mismatch' } })
      throw new Error('batch rejected')
    })).rejects.toThrow('batch rejected')
    expect((await pool.query('SELECT id FROM platform_business_observation')).rows).toEqual([])
    expect((await pool.query(`SELECT enterprise_id, title_code, direction, evidence_query_id, reason_code, reason_note
      FROM difference_reason`)).rows).toEqual([
      { enterprise_id: '7', title_code: 'specialized_sme', direction: 'missing_in_miit', evidence_query_id: '11',
        reason_code: 'pending_review', reason_note: null },
    ])
    await pool.query(`INSERT INTO difference_reason(enterprise_id,title_code,direction,recorded_at,created_at,lifecycle_action)
      VALUES (7,'specialized_sme','missing_in_miit','2024-12-10','2024-12-10','save')`)
    expect(await save(difference)).toMatchObject({ok: false, error: { code: 'decision_lifecycle_required' } })
  })
}, 90_000)
