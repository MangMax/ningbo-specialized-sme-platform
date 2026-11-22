import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createError, createRouter, defineEventHandler, getQuery, readBody, toWebHandler } from 'h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

const oldName = '宁波金叶机械有限公司'
const code = '91330211255994457P'
const batch = 'discovery'
const twin = { existingEnterpriseId: 9, existingEnterpriseName: oldName, name: oldName, nameNorm: oldName, newUscc: code }
const unidentified = { ...twin, existingEnterpriseId: 6 }
const candidateItems = [twin, twin, unidentified].map(candidate => ({
  ok: true, ref: 'synthetic-twin', kind: 'duplicate_candidate', detail: { candidate },
}))

describe('PostgreSQL roster identity discovery over HTTP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-discovery-pg-'))
  let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
  let dispatch: ReturnType<typeof toWebHandler>
  const psql = (sql: string) => postgres!.psql(['-qAt', '-c', sql])

  beforeAll(async () => {
    postgres = await postgresRuntimeFixture({ dir })
    vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
    const db = usePostgresDirectoryDb()
    psql(`
      ALTER TABLE business.platform_collection ALTER COLUMN public_id RESTART WITH 110;
      ALTER TABLE business.platform_business_observation ALTER COLUMN public_id RESTART WITH 210;
    `)
    await seedPostgresPlatformQuery(db, {
      interface: 'business_list', queryKey: '\u200b' + code.toLowerCase() + '\u3000', rdjb: '3',
      queriedAt: '2024-01-01', status: 'success', rawResponse: 'synthetic stored platform evidence',
      relations: [
        { sequenceNo: 1, relationKey: 'wrong-code', nameRaw: oldName, usccRaw: '91330110MA2GMDFH58' },
        { sequenceNo: 2, relationKey: 'original-authority', nameRaw: oldName, usccRaw: code },
      ],
    })
    await seedPostgresPlatformQuery(db, {
      interface: 'apply_list', queryKey: code, queriedAt: '2025-01-01', status: 'success',
      rawResponse: 'synthetic later evidence',
      relations: [{ sequenceNo: 1, relationKey: 'later-query', nameRaw: oldName, usccRaw: code }],
    })
    await seedPostgresPlatformQuery(db, {
      interface: 'apply_list', queryKey: 'name:' + oldName, queriedAt: '2025-02-01', status: 'partial',
      rawResponse: 'synthetic partial name query',
      relations: [{ sequenceNo: 1, relationKey: 'name-trace', nameRaw: oldName }],
    })
    psql(`
      SET search_path TO business, public;
      INSERT INTO enterprise (id,name,name_norm,uscc_norm,district,city) VALUES
        (1,'宁波金叶机械股份有限公司','宁波金叶机械股份有限公司','${code}',NULL,'宁波市'),
        (2,'${oldName}','${oldName}',NULL,NULL,'宁波市'),
        (3,'宁波未确认文创有限公司','宁波未确认文创有限公司',U&'\\200B\\3000',NULL,'宁波市'),
        (4,'宁波历史移除有限公司','宁波历史移除有限公司',NULL,NULL,'宁波市'),
        (6,'宁波独立主体有限公司','宁波独立主体有限公司','91330110MA2GMDFH58',NULL,'宁波市'),
        (9,'旧行','旧行',NULL,NULL,NULL),(10,'中间行','中间行',NULL,NULL,NULL);
      INSERT INTO enterprise_merge (from_enterprise_id,into_enterprise_id,basis,recorded_at)
      VALUES (9,10,'合成归并','2024-01-01'),(10,2,'合成归并','2024-01-01');
      INSERT INTO enterprise_alias (id,enterprise_id,name,name_norm,verification_status,source_kind,created_at) VALUES
        (1,2,'查证别名','查证别名','confirmed','manual','2024-01-01'),(2,2,'无效别名','无效别名','pending','manual','2024-01-01');
      INSERT INTO record (id,enterprise_id,title_code,source,district) VALUES
        (21,2,'little_giant','jxj','海曙区'),(31,3,'specialized_sme','jxj',NULL),
        (41,4,'specialized_sme','miit',NULL);
      INSERT INTO record_event (id,record_id,event_type,year) VALUES (22,21,'award',2024);
      INSERT INTO record_evidence (record_event_id,source_file,attachment,list_no,page) VALUES (22,'公布名单.pdf','附件一',3,7);
      INSERT INTO difference_reason (id,enterprise_id,title_code,direction,status,reason_code,recorded_at,created_at) VALUES
        (1,2,'little_giant','official_only','not_queried','old','2024-01-01','2024-01-01'),
        (2,2,'little_giant','official_only','pending','new','2025-01-01','2025-01-01');
      INSERT INTO platform_export_batch (id,title_code,year,collected_on,original_filename,sha256,created_at) VALUES
        (1,'specialized_sme',2024,'2024-01-01','old.xlsx',repeat('a',64),'2024-01-01'),
        (2,'specialized_sme',2025,'2025-01-01','new.xlsx',repeat('b',64),'2025-01-01');
      INSERT INTO platform_export_row (batch_id,source_row_no,uscc_raw,name_raw,created_at) VALUES
        (1,1,NULL,'宁波历史移除有限公司','2024-01-01'),
        (2,2,'${code}','宁波金叶机械集团有限公司','2025-01-01');
      INSERT INTO platform_observation_assignment (observation_id,revision,match_basis,verification_status,uscc_raw,name_raw,origin)
      SELECT id,2,'manual','confirmed','${code}','改派现名','command' FROM platform_business_observation WHERE public_id=211;
      INSERT INTO import_batch (id,idempotency_key,source_kind,source_identity,status,item_results,preflight_result,created_at) VALUES
        (31,'${batch}','announcement','fixture','committed','${JSON.stringify(candidateItems)}',NULL,'2025-01-01'),
        (32,'prior-merge','alias_evidence','roster/duplicate-merge/${batch}','committed',NULL,NULL,'2025-01-02'),
        (33,'preflight-only','announcement','fixture','preflight',NULL,'${JSON.stringify({ duplicateCandidates: [twin] })}','2025-01-02');
    `)
    vi.stubEnv('NUXT_DB_READONLY', '1')
    vi.stubGlobal('defineEventHandler', defineEventHandler)
    vi.stubGlobal('getQuery', getQuery)
    vi.stubGlobal('readBody', readBody)
    vi.stubGlobal('createError', createError)
    const get = (await import('../../../layers/sme-roster/server/api/roster/uscc-research.get')).default
    const post = (await import('../../../layers/sme-roster/server/api/roster/uscc-research.post')).default
    const duplicate = (await import('../../../layers/sme-roster/server/api/roster/import/duplicate-candidates.get')).default
    dispatch = toWebHandler(createApp().use(createRouter()
      .get('/api/roster/uscc-research', get)
      .post('/api/roster/uscc-research', post)
      .get('/api/roster/import/duplicate-candidates', duplicate)))
  }, 30_000)

  afterAll(async () => {
    try {
      await closePostgresDirectoryDb()
    } finally {
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
      postgres?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  async function request(path: string, body?: object, status = 200) {
    const response = await dispatch(new Request('http://localhost/api/roster/' + path, body === undefined ? undefined : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }))
    const result = await response.json()
    expect(response.status, JSON.stringify(result)).toBe(status)
    return result
  }

  it('keeps checklist filters, official evidence and counts independent of pagination', async () => {
    const result = await request('uscc-research?pageSize=1')
    expect(result.checklist).toMatchObject({ counts: { total: 2 }, page: 1, pageSize: 1, rows: [{
      enterpriseId: 2, name: oldName, district: '海曙区', titles: ['little_giant'], aliasNames: ['查证别名'],
      evidence: [{ sourceFile: '公布名单.pdf', attachment: '附件一', listNo: 3, page: 7 }],
      traces: [{ explanationId: 2, reasonCode: 'new' }],
      queries: [{ status: 'partial', relationCount: 1 }],
    }] })
    expect(result.plan).toMatchObject({
      counts: { targets: 2, filled: 1, notFound: 1 },
      ready: [{ evidence: { relationId: 211, queryId: 110, relationKey: 'original-authority', sequenceNo: 2 },
        merge: { fromEnterpriseId: 2, intoUscc: code, canonicalName: '宁波金叶机械集团有限公司' } }],
    })
    expect((await request('uscc-research?q=查证别名&title=little_giant&district=海曙区')).checklist.counts.total).toBe(1)
    expect((await request('uscc-research?q=无效别名')).checklist.counts.total).toBe(0)
    await request('uscc-research?title=unknown', undefined, 400)
  })

  it('accepts stored platform evidence, rejects source-free claims and leaves the database untouched', async () => {
    const result = await request('uscc-research', { platformClaims: [
      { enterpriseId: 2, uscc: code, observedAt: '2025-02-01' },
      { enterpriseId: 3, uscc: '91330110MA2GMDFH58', observedAt: '2025-02-01',
        evidence: [{ interface: 'apply_list', nameRaw: '宁波未确认文创有限公司', sequenceNo: 1 }] },
    ] })
    expect(result.plan.ready).toMatchObject([{ targetId: 2, route: 'platform_claim', evidence: { relationId: 211 } }])
    expect(result.plan.pending).toMatchObject([{ targetId: 3, code: 'query_source_required' }])
    expect(result.plan.request.payload.platformQueries).toBeUndefined()
    expect(psql('SELECT count(*) FROM business.import_batch; SELECT count(*) FROM business.platform_collection;')).toBe('6\n3\n')
  })

  it('returns a scoped public-source backfill for an accepted verdict file and keeps the checklist intact', async () => {
    const name = '宁波未确认文创有限公司'
    const uscc = '91330211MA2CL6FP24'
    const url = 'https://www.creditchina.gov.cn/xinyong/example'
    const basis = '企业登记信息中的主体名和统一社会信用代码'
    const result = await request('uscc-research', {
      verdictFiles: [{
        file: 'public-source.json', value: {
          batch: 1, generatedAt: '2025-03-01T12:00:00Z', items: [
            { enterpriseId: 3, name, candidateUscc: uscc, verdict: 'found',
              sources: [{ url, fetchedAt: '2025-03-01T10:00:00Z', basis }] },
            { enterpriseId: 2, name: oldName, verdict: 'not_found', reason: '无公开来源' },
          ],
        },
      }],
    })
    expect(result.verdicts).toMatchObject({ accepted: 0, foundClaims: 1, problems: [],
      untouched: [{ enterpriseId: 2, verdict: 'not_found' }] })
    expect(result.checklist.counts.total).toBe(2)
    expect(result.plan).toMatchObject({
      counts: { targets: 1, filled: 1, byRoute: { public_source: 1 } },
      ready: [{ targetId: 3, route: 'public_source', uscc }],
      request: { payload: { usccBackfills: [{ enterpriseId: 3, uscc,
        source: { url, checkedOn: '2025-03-01', basis, name } }] } },
    })
    expect(result.plan.request.payload.merges).toBeUndefined()
    await request('uscc-research', { claims: 'invalid' }, 400)
  })

  it('discovers deduplicated candidates from committed and preflight batches with merge ancestry and authority', async () => {
    const result = await request('import/duplicate-candidates?batchKey=discovery')
    expect(result).toMatchObject({
      batchId: 31, counts: { candidates: 2, ready: 1, pending: 1 },
      previous: { batchId: 32, idempotencyKey: 'prior-merge' },
      ready: [{ evidence: { relationId: 211, queryId: 110, nameRaw: oldName } }],
      pending: [{ candidate: { existingEnterpriseId: 6 }, reason: 'source_has_uscc' }],
      request: { sourceIdentity: 'roster/duplicate-merge/discovery',
        payload: { merges: [{ fromEnterpriseId: 9, intoUscc: code, sourceRefId: 211, canonicalName: '宁波金叶机械集团有限公司' }] } },
    })
    expect((await request('import/duplicate-candidates?batchKey=preflight-only')).counts).toEqual({ candidates: 1, ready: 1, pending: 0 })
    await request('import/duplicate-candidates?batchKey=missing', undefined, 404)
    await request('import/duplicate-candidates', undefined, 400)
  })
})
