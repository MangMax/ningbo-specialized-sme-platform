import { expect, it } from 'vitest'
import { readPostgresRecordComparisonSources } from '../../../layers/sme-roster/server/utils/record-comparison-catalog-postgres'
import { readPostgresCorrespondenceRefs } from '../../../layers/sme-roster/server/utils/record-correspondence-postgres-refs'
import { pg19Bin, withHistoricalImportDatabase } from '../imports/fixtures/postgres-historical-import'

it.runIf(!!pg19Bin)('keeps persisted and negative official source IDs and reads correspondence references', async () => {
  await withHistoricalImportDatabase(`
    INSERT INTO enterprise(id,name,name_norm) VALUES (1,'合成企业','合成企业');
    INSERT INTO record(id,enterprise_id,title_code,source) VALUES (1,1,'specialized_sme','jxj');
    INSERT INTO record_event(id,record_id,event_type,year) VALUES (1,1,'award',2025);
    INSERT INTO record_evidence(id,record_event_id,source_file) VALUES
      (1,1,'official.pdf'), (2,1,'unregistered.pdf'), (3,1,'unregistered.pdf');
    INSERT INTO source_document(id,source,title,path) VALUES
      (5,'jxj','后登记标题','official.pdf'), (4,'jxj','首份正式出处','official.pdf'), (6,'jxj','仅有文档','other.pdf');
  `, async (pool, db) => {
    await pool.query(`
      INSERT INTO business.stored_file(id,rel_path,filename,ext,bytes,sha256,created_at)
      VALUES (4,'official.pdf','official.pdf','pdf',12,repeat('a',64),'2026-11-20T00:00:00Z');
      INSERT INTO business.record_correspondence(
        edge_key,type,role,event_id,enterprise_id,title_code,status,revision,target_identity,provenance,
        source_fingerprint,rule_id,rule_version,created_at
      ) VALUES ('test','event_process','review',1,1,'specialized_sme','candidate',1,'{}','{}',
        'synthetic','test','1','2026-11-20T00:00:00Z');
    `)
    const catalog = await readPostgresRecordComparisonSources(db, { kind: 'official_document', page: 1, pageSize: 10 })
    expect(catalog).toMatchObject({
      total: 2,
      rows: [
        { id: -2, label: 'unregistered.pdf', path: 'unregistered.pdf', contentIdentity: { registered: null } },
        { id: 4, label: '首份正式出处', path: 'official.pdf', contentIdentity: { registered: { fileId: 4, bytes: 12 } } },
      ],
    })
    const filtered = await readPostgresRecordComparisonSources(db, { kind: 'official_document', ids: [-2], page: 1, pageSize: 1 })
    expect(filtered).toMatchObject({ total: 1, rows: [{ id: -2 }] })
    expect(await readPostgresCorrespondenceRefs(db, { eventIds: [1], relationIds: [], exportRowIds: [] })).toMatchObject([
      { eventId: 1, enterpriseId: 1, status: 'candidate', relationId: null, requiresRevalidation: false },
    ])
  })
}, 30_000)
