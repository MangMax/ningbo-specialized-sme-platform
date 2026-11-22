import { expect, it } from 'vitest'
import { readPostgresRecordComparisonSources } from '../../../layers/sme-roster/server/utils/record-comparison-catalog-postgres'
import { readPostgresCorrespondenceRefs } from '../../../layers/sme-roster/server/utils/record-correspondence-postgres-refs'
import { pg19Bin, withHistoricalImportDatabase } from '../imports/fixtures/postgres-historical-import'

it.runIf(!!pg19Bin)('preserves official source IDs, query condition visibility, and correspondence references after materialization', async () => {
  await withHistoricalImportDatabase(`
    INSERT INTO enterprise(id,name,name_norm) VALUES (1,'合成企业','合成企业');
    INSERT INTO record(id,enterprise_id,title_code,source) VALUES (1,1,'specialized_sme','jxj');
    INSERT INTO record_event(id,record_id,event_type,year) VALUES (1,1,'award',2025);
    INSERT INTO record_evidence(id,record_event_id,source_file) VALUES
      (1,1,'official.pdf'), (2,1,'unregistered.pdf'), (3,1,'unregistered.pdf');
    INSERT INTO source_document(id,source,title,path) VALUES
      (5,'jxj','后登记标题','official.pdf'), (4,'jxj','首份正式出处','official.pdf'), (6,'jxj','仅有文档','other.pdf');
    INSERT INTO platform_collection(id,interface,query_key,rdjb,queried_at,created_at,
      status,completeness,provenance_state,parse_state,rule_version) VALUES
      (11,'recognized_list','known empty','2','2026-11-20','2026-11-20','success','complete','captured','valid','fixture'),
      (12,'recognized_list','missing conditions','2','2026-11-20','2026-11-20','success','complete','captured','valid','fixture'),
      (13,'recognized_list','conflicting conditions','2','2026-11-20','2026-11-20','success','partial','conflict','valid','fixture');
    INSERT INTO platform_legacy_query_alias(old_id,collection_id) VALUES (31,11),(32,12),(33,13);
    INSERT INTO platform_collection_condition(collection_id,name,value_kind,text_value,integer_value) VALUES
      (11,'name','absent',NULL,NULL),(13,'combination','text','and',NULL),(13,'rddqrq','array',NULL,NULL),
      (13,'uscc','boolean',NULL,0);
    UPDATE platform_collection_condition SET witness_kind='array',witness_value='[1,2]'
      WHERE collection_id=13 AND name='rddqrq';
  `, async (pool, db) => {
    await pool.query(`
      INSERT INTO business.stored_file(id,rel_path,filename,ext,bytes,sha256,created_at)
      VALUES (4,'official.pdf','official.pdf','pdf',12,repeat('a',64),'2026-11-20T00:00:00Z');
      INSERT INTO business.platform_export_batch(id,title_code,year,collected_on,original_filename,sha256,row_count,import_status,created_at)
      VALUES (1,'specialized_sme',2025,'2026-11-20','export.xlsx',repeat('b',64),1,'imported','2026-11-20T00:00:00Z');
      INSERT INTO business.platform_export_row(id,batch_id,source_row_no,name_raw,created_at)
      VALUES (1,1,2,'合成企业','2026-11-20T00:00:00Z');
      INSERT INTO business.record_correspondence(
        edge_key,type,role,event_id,export_row_id,enterprise_id,title_code,status,revision,target_identity,provenance,
        source_fingerprint,rule_id,rule_version,created_at
      ) VALUES ('test','event_export_context','current_snapshot_context',1,1,1,'specialized_sme','candidate',1,'{}','{}',
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
    const queries = await readPostgresRecordComparisonSources(db, { kind: 'query', page: 1, pageSize: 10 })
    expect(queries.rows.map(row => [row.id, 'conditions' in row ? row.conditions : undefined])).toEqual([
      [31, {}], [32, null], [33, { combination: 'and', rddqrq: null, uscc: false }],
    ])
    expect(JSON.stringify(queries)).not.toMatch(/"conditionFacts"|"unfinishedPositions"|"witnesses"/)
    const filtered = await readPostgresRecordComparisonSources(db, { kind: 'official_document', ids: [-2], page: 1, pageSize: 1 })
    expect(filtered).toMatchObject({ total: 1, rows: [{ id: -2 }] })
    expect(await readPostgresCorrespondenceRefs(db, { eventIds: [1], relationIds: [], exportRowIds: [] })).toMatchObject([
      { eventId: 1, enterpriseId: 1, status: 'candidate', relationId: null, exportRowId: 1, requiresRevalidation: false },
    ])
  })
}, 30_000)
