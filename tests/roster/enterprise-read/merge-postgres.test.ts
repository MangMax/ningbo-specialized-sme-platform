import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { afterAll, expect, it } from 'vitest'
import { postgresCanonicalEnterpriseId } from '../../../layers/core/server/public'
import { applyPostgresRosterMerge, planPostgresRosterMerge } from '../../../layers/sme-roster/server/utils/roster-merge-postgres'

const url = process.env.TEST_ROSTER_MERGE_POSTGRES_URL
const pool = url ? new pg.Pool({ connectionString: url, options: '-c search_path=business,public' }) : undefined
type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
const code = '91330200MA00000001'
const input = { fromEnterpriseId: 7001, intoUscc: code }
const rolledBack = new Error('Roll back the isolated fixture')

afterAll(async () => { await pool?.end() })

async function fixture(run: (tx: Tx) => Promise<void>) {
  await drizzle(pool!).transaction(async tx => {
    await tx.execute(sql`
      INSERT INTO enterprise (id,name,name_norm,uscc_norm) VALUES
        (7001,'旧企业','旧企业',null), (7002,'规范企业','规范企业',${code});
      INSERT INTO roster_legacy_member (enterprise_id) VALUES (7001);
      INSERT INTO record (id,enterprise_id,title_code,source,name_raw) VALUES
        (7101,7001,'little_giant','jxj','旧企业'),
        (7102,7002,'little_giant','jxj','规范企业'),
        (7103,7001,'specialized_sme','jxj','旧企业');
      INSERT INTO record_event (id,record_id,event_type,year) VALUES
        (7201,7101,'award',2024), (7202,7102,'award',2024), (7203,7103,'award',2025);
      INSERT INTO record_evidence (id,record_event_id,source_file,attachment,page) VALUES
        (7301,7201,'notice.pdf',' 附件一 ',3), (7302,7203,'notice.pdf',null,4)
    `.inlineParams())
    await run(tx)
    throw rolledBack
  }).catch(error => { if (error !== rolledBack) throw error })
}

it.skipIf(!url)('folds records without collapsing events or evidence and follows the old enterprise ID and membership', async () => {
  await fixture(async tx => {
    await tx.execute(sql`
      INSERT INTO roster_announcement_intake (id,idempotency_key,digest,request) VALUES (7020,'noticed','fixture','{}');
      INSERT INTO roster_announcement_member (enterprise_id,intake_id) VALUES (7001,7020);
      INSERT INTO import_batch (id,idempotency_key,source_kind,source_identity,status,created_at)
      VALUES (7030,'original-import','announcement','notice.pdf','committed','2026-11-20');
      INSERT INTO official_evidence_row_revision (evidence_id,revision,event_id,captured_record_id,captured_enterprise_id,
        name_raw,source_binding_known,actor,basis,command_kind,import_batch_id,created_at)
      VALUES (7301,1,7201,7101,7001,' 旧企业 ',0,'{"type":"agent","id":"fixture"}',
        '原始公布行','import',7030,'2026-11-20')
    `)
    const originalEvidence = (await tx.execute(sql`SELECT * FROM official_evidence_row_revision WHERE evidence_id=7301`)).rows
    const planned = await planPostgresRosterMerge(tx, input, 0)
    expect(planned.item).toMatchObject({ ok: true, ref: `merge:7001->${code}` })
    expect(await postgresCanonicalEnterpriseId(tx, 7001)).toBe(7001)
    const result = await applyPostgresRosterMerge(tx, planned.plan!)
    expect(result).toMatchObject({ ok: true, ref: 'merge:7001->7002', detail: { rowsWritten: 1, lineage: {
      fromEnterpriseId: 7001, intoEnterpriseId: 7002, canonicalName: '规范企业', rename: null,
      childRowsMoved: { aliases: 0, differences: 0, relations: 0, records: 2 },
      recordsMoved: [7103], recordsFolded: [{ fromRecordId: 7101, intoRecordId: 7102, eventIds: [7201],
        fromRecordSnapshot: { id: 7101, enterpriseId: 7001, nameRaw: '旧企业' } }],
      eventsMoved: [7201, 7203], evidenceMoved: [7301, 7302],
    } } })
    expect(await postgresCanonicalEnterpriseId(tx, 7001)).toBe(7002)
    expect((await tx.execute(sql`SELECT id::int AS id,name FROM enterprise WHERE id IN (7001,7002) ORDER BY id`)).rows)
      .toEqual([{ id: 7001, name: '旧企业' }, { id: 7002, name: '规范企业' }])
    expect((await tx.execute(sql`SELECT enterprise_id::int AS id FROM roster_legacy_member WHERE enterprise_id IN (7001,7002) ORDER BY id`)).rows)
      .toEqual([{ id: 7001 }, { id: 7002 }])
    expect((await tx.execute(sql`SELECT enterprise_id FROM roster_announcement_member WHERE intake_id=7020 ORDER BY enterprise_id`)).rows)
      .toEqual([{ enterprise_id: '7001' }, { enterprise_id: '7002' }])
    expect((await tx.execute(sql`SELECT * FROM official_evidence_row_revision WHERE evidence_id=7301`)).rows).toEqual(originalEvidence)
    expect((await tx.execute(sql`
      SELECT e.id::int,r.id::int AS record,r.enterprise_id::int AS owner,v.id::int AS evidence,v.attachment
      FROM record_event e JOIN record r ON r.id=e.record_id LEFT JOIN record_evidence v ON v.record_event_id=e.id
      WHERE e.id BETWEEN 7201 AND 7203 ORDER BY e.id`)).rows).toEqual([
      { id: 7201, record: 7102, owner: 7002, evidence: 7301, attachment: ' 附件一 ' },
      { id: 7202, record: 7102, owner: 7002, evidence: null, attachment: null },
      { id: 7203, record: 7103, owner: 7002, evidence: 7302, attachment: null },
    ])
  })
})

it.skipIf(!url)('resolves chained merges from either an old ID or an old unified credit code', async () => {
  await fixture(async tx => {
    const newestCode = '91330200MA00000002'
    await tx.execute(sql`INSERT INTO enterprise (id,uscc_norm,name,name_norm) VALUES (7003,${newestCode},'最新规范企业','最新规范企业')`)
    const first = await planPostgresRosterMerge(tx, input, 0)
    expect(await applyPostgresRosterMerge(tx, first.plan!)).toMatchObject({ ok: true })
    const second = await planPostgresRosterMerge(tx, { fromEnterpriseId: 7001, intoUscc: newestCode }, 1)
    expect(second.plan).toMatchObject({ sourceEnterpriseId: 7002, intoEnterpriseId: 7003 })
    expect(await applyPostgresRosterMerge(tx, second.plan!)).toMatchObject({ ok: true, ref: 'merge:7002->7003' })
    expect(await postgresCanonicalEnterpriseId(tx, 7001)).toBe(7003)
    expect(await planPostgresRosterMerge(tx, { fromEnterpriseId: 7003, intoUscc: code }, 2)).toMatchObject({
      plan: null, item: { ok: false, error: { code: 'merge_same_enterprise' } },
    })
  })
})

it.skipIf(!url)('binds staged platform evidence by its public IDs and appends a new assignment revision', async () => {
  await fixture(async tx => {
    await tx.execute(sql`
      INSERT INTO platform_collection (id,interface,query_key,rdjb,queried_at,created_at,status,
        completeness,provenance_state,parse_state,rule_version)
      VALUES (7401,'recognized_list','fixture','3','2026-11-20','2026-11-20','success',
        'complete','captured','valid','fixture');
      INSERT INTO platform_legacy_query_alias (old_id,collection_id) VALUES (8401,7401);
      INSERT INTO platform_business_observation (id,collection_id,sequence_no,position_state,source_relation_key,identity_state,content_state)
      VALUES (7501,7401,1,'unknown','original','not_indexed','not_indexed'),
             (7502,7401,2,'unknown','different','not_indexed','not_indexed');
      INSERT INTO platform_legacy_relation_alias (old_id,observation_id) VALUES (8501,7501),(8502,7502);
      INSERT INTO platform_observation_assignment (observation_id,revision,enterprise_id,match_basis,verification_status,
        uscc_raw,name_raw,alias_name_raw,origin)
      VALUES (7501,1,7001,'alias','confirmed',' raw code ',' raw name ',' captured alias ','migrated_current'),
             (7502,1,7001,'manual','pending',null,'another name',null,'migrated_current');
      INSERT INTO platform_observation_assignment (observation_id,revision,enterprise_id,match_basis,verification_status,name_raw,origin)
      VALUES (7502,2,7002,'manual','confirmed','another name','command')
    `)
    const query = { interface: 'recognized_list' as const, queryKey: 'fixture', rdjb: '3', queriedAt: '2026-11-20' }
    const merge = { ...input, canonicalName: '规范企业新名', note: '已核实同一主体',
      sourceRelationRef: { ...query, sequenceNo: 1, relationKey: 'original' }, evidenceQueryRef: query }
    const mismatch = await planPostgresRosterMerge(tx, {
      ...merge, sourceRelationRef: { ...merge.sourceRelationRef, relationKey: 'different' },
    }, 0)
    expect(mismatch).toMatchObject({ plan: null, item: { ok: false, error: { code: 'relation_ref_mismatch' } } })
    const before = (await tx.execute(sql`SELECT * FROM platform_observation_assignment ORDER BY observation_id,revision`)).rows
    const planned = await planPostgresRosterMerge(tx, merge, 0)
    expect(planned.item).toMatchObject({ ok: true })
    expect(await applyPostgresRosterMerge(tx, planned.plan!)).toMatchObject({ ok: true, detail: { rowsWritten: 2, lineage: {
      evidenceQueryId: 8401, canonicalName: '规范企业新名', rename: { from: '规范企业', to: '规范企业新名' },
      childRowsMoved: { relations: 1 },
    } } })
    const after = (await tx.execute(sql`SELECT * FROM platform_observation_assignment ORDER BY observation_id,revision`)).rows
    expect(after.filter(row => row.observation_id !== '7501' || row.revision === '1')).toEqual(before)
    expect(after[1]).toMatchObject({ observation_id: '7501', revision: '2', enterprise_id: '7002',
      origin: 'command', actor: null, basis: '已核实同一主体', match_basis: 'alias', verification_status: 'confirmed',
      uscc_raw: ' raw code ', name_raw: ' raw name ', alias_name_raw: ' captured alias ', command_receipt_id: null })
    expect((await tx.execute(sql`SELECT name,source_ref_id FROM enterprise_alias WHERE enterprise_id=7002 ORDER BY id`)).rows)
      .toEqual([{ name: '规范企业', source_ref_id: '8501' }, { name: '旧企业', source_ref_id: '8501' }])
  })
})

it.skipIf(!url)('deduplicates equal aliases and differences while retaining original audit bytes and correspondence provenance', async () => {
  await fixture(async tx => {
    await tx.execute(sql`
      INSERT INTO enterprise_alias (id,enterprise_id,name,name_norm,source_kind,verification_status,created_at)
      VALUES (7601,7001,'共同曾用名','共同曾用名','manual','confirmed','2026-11-10'),
             (7602,7002,'共同曾用名','共同曾用名','manual','confirmed','2026-11-10'),
             (7603,7001,'独立曾用名','独立曾用名','manual','confirmed','2026-11-10');
      UPDATE enterprise_former_name SET renamed_year=2019 WHERE alias_id=7603;
      INSERT INTO enterprise_alias_audit (id,alias_id,enterprise_id,action,actor,basis,idempotency_key,request_hash,before,after,created_at)
      VALUES (7701,7601,7001,'confirm','{"id":"fixture"}',' 核实 ','audit-fixture','hash',' {"old":1} ',' {"new":2} ','2026-11-11');
      INSERT INTO difference_reason (id,enterprise_id,title_code,direction,reason_note,recorded_at,created_at)
      VALUES (7801,7001,'little_giant','missing_in_miit',' duplicate ','2026-11-12','2026-11-13'),
             (7802,7002,'little_giant','missing_in_miit',' duplicate ','2026-11-12','2026-11-14'),
             (7803,7001,'specialized_sme','missing_in_miit',' unique ','2026-11-15','2026-11-16');
      INSERT INTO record_correspondence (id,edge_key,type,role,event_id,enterprise_id,title_code,status,revision,target_identity,
        provenance,source_fingerprint,rule_id,rule_version,created_at)
      VALUES (7901,'fixture-edge','official_platform','award',7201,7001,'little_giant','confirmed',2,
        ' original identity ',' original provenance ',' source fingerprint ','fixture','1','2026-11-20')
    `)
    const planned = await planPostgresRosterMerge(tx, { ...input, fromEnterpriseName: '旧企业' }, 0)
    const before = (await tx.execute(sql`SELECT * FROM enterprise_alias_audit WHERE id=7701`)).rows[0]
    expect(await applyPostgresRosterMerge(tx, planned.plan!)).toMatchObject({ ok: true, detail: { lineage: {
      childRowsMoved: { aliases: 1, differences: 1 },
    } } })
    expect((await tx.execute(sql`SELECT id,enterprise_id FROM enterprise_alias WHERE id BETWEEN 7601 AND 7603 ORDER BY id`)).rows)
      .toEqual([{ id: '7602', enterprise_id: '7002' }, { id: '7603', enterprise_id: '7002' }])
    expect((await tx.execute(sql`SELECT * FROM enterprise_alias_audit WHERE id=7701`)).rows)
      .toEqual([{ ...before, alias_id: '7602', enterprise_id: '7001' }])
    expect((await tx.execute(sql`SELECT uscc,renamed_year FROM enterprise_former_name WHERE alias_id=7603`)).rows)
      .toEqual([{ uscc: code, renamed_year: '2019' }])
    expect((await tx.execute(sql`SELECT id,enterprise_id,reason_note FROM difference_reason ORDER BY id`)).rows)
      .toEqual([{ id: '7802', enterprise_id: '7002', reason_note: ' duplicate ' },
        { id: '7803', enterprise_id: '7002', reason_note: ' unique ' }])
    expect((await tx.execute(sql`SELECT enterprise_id,event_id,revision,target_identity,provenance,source_fingerprint
      FROM record_correspondence WHERE id=7901`)).rows).toEqual([{ enterprise_id: '7002', event_id: '7201', revision: '2',
      target_identity: ' original identity ', provenance: ' original provenance ', source_fingerprint: ' source fingerprint ' }])
    expect((await tx.execute(sql`SELECT enterprise_id,metadata FROM evidence_revision_113 WHERE source_key='identity:merge:7001:7002'`)).rows)
      .toEqual([{ enterprise_id: '7002', metadata: JSON.stringify({ fromEnterpriseId: 7001 }) }])
  })
})

it.skipIf(!url)('rejects different legacy versions and rechecks adopted difference scope at apply time', async () => {
  await fixture(async tx => {
    await tx.execute(sql`
      INSERT INTO difference_reason (id,enterprise_id,title_code,direction,reason_note,recorded_at,created_at)
      VALUES (7801,7001,'little_giant','missing_in_miit',' source ','2026-11-12','2026-11-13'),
             (7802,7002,'little_giant','missing_in_miit',' target ','2026-11-12','2026-11-14')
    `)
    expect(await planPostgresRosterMerge(tx, input, 0)).toMatchObject({
      plan: null, item: { ok: false, error: { code: 'merge_difference_conflict' } },
    })
    await tx.execute(sql`UPDATE difference_reason SET recorded_at='2026-11-16' WHERE id=7802`)
    const planned = await planPostgresRosterMerge(tx, input, 0)
    expect(planned.item.ok).toBe(true)
    await tx.execute(sql`
      INSERT INTO evidence_review_receipt_114 (idempotency_key,request_hash,kind,enterprise_id,title_code,direction,
        decision_id,reviewed_revision_id,actor,basis,response,recorded_at)
      VALUES ('adopt-merge-fixture','hash','maintain',7002,'little_giant','missing_in_miit',
        7802,1,'{}','fixture','{}','2026-11-20')
    `)
    expect(await applyPostgresRosterMerge(tx, planned.plan!)).toMatchObject({
      ok: false, error: { code: 'merge_difference_lifecycle_conflict' },
    })
    expect(await postgresCanonicalEnterpriseId(tx, 7001)).toBe(7001)
    expect((await tx.execute(sql`SELECT id,enterprise_id FROM difference_reason ORDER BY id`)).rows)
      .toEqual([{ id: '7801', enterprise_id: '7001' }, { id: '7802', enterprise_id: '7002' }])
  })
})

it.skipIf(!url)('rejects alias conflicts that would lose a decision or share an audit key', async () => {
  await fixture(async tx => {
    await tx.execute(sql`
      INSERT INTO enterprise_alias (id,enterprise_id,name,name_norm,source_kind,verification_status,created_at)
      VALUES (7601,7001,'共同曾用名','共同曾用名','manual','withdrawn','2026-11-10'),
             (7602,7002,'共同曾用名','共同曾用名','manual','confirmed','2026-11-10');
      INSERT INTO enterprise_alias_audit (alias_id,enterprise_id,action,actor,basis,idempotency_key,request_hash,before,after,created_at)
      VALUES (7601,7001,'withdraw','{}','fixture','shared','hash1','{}','{}','2026-11-11'),
             (7602,7002,'confirm','{}','fixture','shared','hash2','{}','{}','2026-11-12')
    `)
    expect(await planPostgresRosterMerge(tx, input, 0)).toMatchObject({
      plan: null, item: { ok: false, error: { code: 'merge_alias_lifecycle_conflict' } },
    })
    await tx.execute(sql`UPDATE enterprise_alias SET verification_status='confirmed' WHERE id=7601`)
    expect(await planPostgresRosterMerge(tx, input, 0)).toMatchObject({
      plan: null, item: { ok: false, error: { code: 'merge_alias_audit_key_conflict' } },
    })
    expect(await postgresCanonicalEnterpriseId(tx, 7001)).toBe(7001)
  })
})

it.skipIf(!url)('rolls back merge lineage, membership and ownership with the caller transaction', async () => {
  await fixture(async tx => {
    const laterItemFailure = new Error('Later mixed import item failed')
    await expect(tx.transaction(async nested => {
      const planned = await planPostgresRosterMerge(nested, input, 0)
      expect(await applyPostgresRosterMerge(nested, planned.plan!)).toMatchObject({ ok: true })
      expect(await postgresCanonicalEnterpriseId(nested, 7001)).toBe(7002)
      throw laterItemFailure
    })).rejects.toBe(laterItemFailure)
    expect(await postgresCanonicalEnterpriseId(tx, 7001)).toBe(7001)
    expect((await tx.execute(sql`SELECT enterprise_id,source_key FROM evidence_revision_113 WHERE source_key='identity:merge:7001:7002'`)).rows)
      .toEqual([])
    expect((await tx.execute(sql`SELECT enterprise_id FROM roster_legacy_member WHERE enterprise_id IN (7001,7002)`)).rows)
      .toEqual([{ enterprise_id: '7001' }])
    expect((await tx.execute(sql`SELECT record_id FROM record_event WHERE id=7201`)).rows).toEqual([{ record_id: '7101' }])
  })
})
