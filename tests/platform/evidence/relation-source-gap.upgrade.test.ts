import { readFileSync, writeFileSync } from 'node:fs'
import { finalEvidenceFixture } from '../fixtures/completed-upgrade'
import { readPlatformQueryEvidence as readLegacyEvidence } from '../oracles/legacy-evidence'
/** #743 bounded structural witness, not a replacement DTO implementation. */
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { readSource } from '../../../server/utils/record-correspondence-read'
import { witnessReaderFixture } from '../fixtures/recognized-witness-upgrade'
import { targetSchema } from '../../../lib/platform/target-schema'
import { readTargetRelationEvidenceDisplay } from '../../../server/utils/platform-relation-evidence-display-target'

async function migrated(page: number) {
  const fixture = await witnessReaderFixture(old => {
    // One query and one unindexed relation. Only the supplement page differs.
    old.prepare(`INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,collection_evidence,created_at)
      VALUES(1,'business_list','Q','2','t','success',?,'c')`).run(JSON.stringify({
      pages: [{ status: 'success', rdjb: '2', page: 1, fetchedCount: 1 }],
    }))
    old.exec(`INSERT INTO platform_relation(id,query_id,sequence_no,raw_fields,name_raw,created_at)
      VALUES(1,1,1,'{"rdjb":"2"}','Original','c');
      INSERT INTO import_batch(id,idempotency_key,source_kind,source_identity,created_at)
      VALUES(1,'synthetic','platform_archive','synthetic','c');`)
    old.prepare(`INSERT INTO platform_query_legacy_provenance(query_id,source_identity,source_sha256,segment_index,
      collection,input_fingerprint,import_batch_id,created_at) VALUES(1,'synthetic',?,0,?,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',1,'c')`)
      .run('a'.repeat(64), JSON.stringify({ source: 'businessList', pages: [{ status: 'success', rdjb: '2', page, fetchedCount: 1 }] }))
  })
  const native=finalEvidenceFixture(fixture)
  const target=native.t
  const stages=JSON.parse(readFileSync(join(native.root,'native-completion','stages.json'),'utf8')) as {stage:string;result:unknown}[]
  const receipt=stages.find(stage=>stage.stage==='retirement')?.result
  expect(receipt).toEqual({state:'complete',version:71613})
  try {
    const dto = readSource(native.db, 'relation', 1)
    if (!dto) throw new Error('Expected retained source')
    const { correspondences: _links, ...expected } = dto
    const display = readTargetRelationEvidenceDisplay(drizzle(target, { schema: targetSchema }), [{ relationId: 1, queryId: 1 }])
    expect(display.purpose).toBe('platform_relation_evidence_display')
    expect(display.sources.get(1)).toEqual(expected)
    const original=readLegacyEvidence(native.old,{queryId:1,relationId:1,field:'relation'})
    if(!('data' in original))throw new Error('Expected original bytes')
    const originalDto=JSON.parse(Buffer.from(original.data,'base64').toString())
    expect(expected).toMatchObject({...originalDto,normalizationConflicts:[],sourceRdjb:'2',sourcePage:page})
    // Complete rows of every possible structured source DTO owner, not selected matching columns.
    const tables = [
      'platform_collection', 'platform_collection_page', 'platform_collection_condition', 'platform_collection_unfinished',
      'platform_query_title_scope', 'platform_query_title_scope_error',
      'platform_business_observation', 'platform_observation_assignment',
      'platform_business_record', 'platform_business_record_version',
      'platform_apply_projection', 'platform_business_projection', 'platform_recognized_projection',
      'platform_legacy_query_alias', 'platform_legacy_relation_alias',
      'platform_collection_legacy_provenance', 'platform_observation_fingerprint_basis',
    ]
    const structured = Object.fromEntries(tables.map(table => [table, target.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
    const archiveBefore = target.prepare('SELECT id,sha256,hex(bytes) bytes FROM platform_archive_value ORDER BY id').all()
    expect(readSource(native.db, 'relation', 1)).toEqual(dto)
    expect(target.prepare('SELECT id,sha256,hex(bytes) bytes FROM platform_archive_value ORDER BY id').all()).toEqual(archiveBefore)
    expect(target.pragma('user_version', { simple: true })).toBe(71613)
    expect(target.prepare('SELECT schema_version FROM platform_runtime_completion WHERE id=1').get()).toEqual({schema_version:71613})
    expect(target.pragma('foreign_key_check')).toEqual([])
    expect(target.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    const evidence = { page, dto, structured, archiveBefore, receipt, root: fixture.root }
    const output = process.env.H1B_WITNESS_DIR
    if (output) writeFileSync(join(output, `page-${page}.json`), JSON.stringify(evidence, null, 2))
    return evidence
  } finally {
    native.close()
  }
}

it('preserves different legacy source pages through full migration while all structured DTO owners are identical', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  try {
    const first = await migrated(7)
    const second = await migrated(8)
    expect(first.dto).toMatchObject({ id: 1, queryId: 1, nameRaw: 'Original', sourceRdjb: '2', sourcePage: 7 })
    expect(second.dto).toMatchObject({ id: 1, queryId: 1, nameRaw: 'Original', sourceRdjb: '2', sourcePage: 8 })
    expect(first.structured).toEqual(second.structured)
    expect(first.structured.platform_collection).toMatchObject([{ provenance_state: 'conflict' }])
    expect(first.structured.platform_collection_page).toMatchObject([{ page_no: 1, position_state: 'verified' }])
    expect(first.structured.platform_business_observation).toMatchObject([{ identity_state: 'not_indexed', content_state: 'not_indexed' }])
    expect(first.archiveBefore).not.toEqual(second.archiveBefore)
  } finally {
    vi.useRealTimers()
  }
}, 60000)
