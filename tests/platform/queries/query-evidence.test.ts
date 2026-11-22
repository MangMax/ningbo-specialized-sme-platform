import {afterEach,expect,it} from 'vitest'
import {listPlatformQueries,MAX_FULL_QUERY_BYTES} from '../../../layers/sme-roster/lib/platform/read'
import {readPlatformQueryEvidence} from '../../../layers/sme-roster/lib/platform/evidence-read'
import {submitNativePlatformQuery} from '../fixtures/native-query'
import {nativeImportDb,businessSource} from '../../roster/imports/fixtures/native-import'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { readPostgresPlatformQueries } from '../../../layers/sme-roster/lib/platform/postgres-query-read'
import { installLeadListSchema } from '../../../layers/lead-lists/install-schema'
import { insertTargetLegacyProvenance } from '../../../layers/sme-roster/lib/platform/legacy-provenance-command'
import { importBatch } from '../../../db/schema'
const handles:ReturnType<typeof nativeImportDb>[]=[]
afterEach(()=>{for(const db of handles.splice(0))db.$client.close()})
function fixture(){const db=nativeImportDb();handles.push(db);return db}
function bytes(db:ReturnType<typeof fixture>,queryId:number,field:'rawResponse'|'collectionEvidence'|'relation',relationId?:number){
 const parts:Buffer[]=[];let offset=0
 for(;;){const part=readPlatformQueryEvidence(db,{queryId,field,relationId,offset,length:7});if(!('data' in part))throw Error('Expected byte evidence');const data=Buffer.from(part.data,'base64');expect(data.length).toBeLessThanOrEqual(7);parts.push(data);offset+=data.length;if(!part.hasMore){expect(offset).toBe(part.totalBytes);break}}
 return Buffer.concat(parts)
}
it('reassembles exact Unicode originals and pages every repeated relation by immutable public alias',()=>{
 const db=fixture(),raw='完整原文🙂\n\\"尾部',rows=[{sequenceNo:1,relationKey:'same-key',rawFields:{id:'same-key',original:'原行1🙂'},sourceText:'原文1'},{sequenceNo:2,relationKey:'same-key',rawFields:{id:'same-key',original:'原行2🙂'},sourceText:'原文2'}]
 const result=submitNativePlatformQuery(db,{...businessSource('exact',rows),rawResponse:raw})
 expect(bytes(db,result.queryId,'rawResponse')).toEqual(Buffer.from(raw))
 expect(JSON.parse(bytes(db,result.queryId,'relation',result.relationIds[1]).toString())).toMatchObject({id:result.relationIds[1],queryId:result.queryId,sequenceNo:2,relationKey:'same-key',rawFields:rows[1]!.rawFields,sourceText:'原文2'})
 expect(readPlatformQueryEvidence(db,{queryId:result.queryId,field:'relations',pageSize:1,page:2})).toMatchObject({total:2,rows:[{id:result.relationIds[1],sequenceNo:2}]})
 expect(readPlatformQueryEvidence(db,{queryId:result.queryId,field:'rawResponse',offset:Buffer.byteLength(raw),length:1})).toMatchObject({byteLength:0,hasMore:false})
})
it('distinguishes absent source identities from invalid byte ranges',()=>{
 const db=fixture(),q=submitNativePlatformQuery(db,businessSource('ranges'))
 expect(()=>readPlatformQueryEvidence(db,{queryId:9999,field:'rawResponse'})).toThrow(/not found/)
 expect(()=>readPlatformQueryEvidence(db,{queryId:q.queryId,field:'relation',relationId:9999})).toThrow(/not found/)
 for(const input of [{offset:-1},{offset:.5},{length:0},{length:65537},{pageSize:201}])expect(()=>readPlatformQueryEvidence(db,{queryId:q.queryId,field:'rawResponse',...input})).toThrow(/Invalid/)
 expect(readPlatformQueryEvidence(db,{queryId:q.queryId,field:'collectionEvidence'})).toMatchObject({isNull:true,totalBytes:0,data:'',hasMore:false})
})
it('enforces full-read budgets while keeping summary and bounded bytes available',()=>{
 const db=fixture(),exact=submitNativePlatformQuery(db,{...businessSource('exact-budget'),rawResponse:'x'.repeat(MAX_FULL_QUERY_BYTES)})
 expect(listPlatformQueries(db,{queryId:exact.queryId,includeRawResponse:true}).rows[0]!.query.rawResponse!.length).toBe(MAX_FULL_QUERY_BYTES)
 const huge=submitNativePlatformQuery(db,{...businessSource('oversize'),rawResponse:'x'.repeat(MAX_FULL_QUERY_BYTES+1)})
 expect(()=>listPlatformQueries(db,{queryId:huge.queryId,includeRawResponse:true})).toThrow(/summary/)
 expect(listPlatformQueries(db,{queryId:huge.queryId,view:'summary'}).total).toBe(1)
 expect(readPlatformQueryEvidence(db,{queryId:huge.queryId,field:'rawResponse',length:7})).toMatchObject({byteLength:7,hasMore:true})
})

const pgBin = process.env.TEST_PLATFORM_HISTORY_PG_BIN
it.skipIf(!pgBin)('materializes query history as structured facts and leaves original bytes in the offline source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-history-'))
  const sqlite = fixture()
  sqlite.$client.transaction(() => installLeadListSchema(sqlite.$client))()
  const key = 'full-history'
  const rawRows = [{ id: 'original', qymc: '合成🙂企业', rdjb: '2', cszt: '终审通过' }, { id: 'repeated', rdjb: '2' }]
  const sourceQuery = businessSource(key, [
    { sequenceNo: 1, relationKey: 'original', rawFields: rawRows[0],
      sourceText: '页面一原文', nameRaw: '合成🙂企业', aliasNameRaw: '原名' },
    { sequenceNo: 2, relationKey: 'repeated', rawFields: rawRows[1], sourceText: '页面二原文' },
  ])
  const rawResponse = '原始\\文本🙂'
  const observed = submitNativePlatformQuery(sqlite, {
    ...sourceQuery, rawResponse,
  })
  const date = sourceQuery.queriedAt!
  const supplemental = sqlite.insert(importBatch).values({
    idempotencyKey: 'legacy-meta', sourceKind: 'platform_archive', sourceIdentity: 'legacy-meta-source', status: 'committed', createdAt: date,
  }).returning({ id: importBatch.id }).get()
  insertTargetLegacyProvenance(sqlite, {
    queryId: observed.queryId, interface: 'business_list', queryKey: key, rdjb: '2', queriedAt: date,
    sourceIdentity: 'archived/source.json', sourceSha256: 'a'.repeat(64), segmentIndex: 0,
    collection: { source: 'businessList', status: 'success', effectiveConditions: { combination: 'and' },
      titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: date, completedAt: date, rows: rawRows as Record<string,string>[],
      pages: [1, 2].map(page => ({ source: 'businessList', rdjb: '2', page, status: 'success', fetchedCount: 1, declaredTotal: 2, error: null })),
      fetchedCount: 2, declaredTotal: 2, completeness: 'complete', fullRange: true, unfinished: [], error: null,
      limits: { maxRequests: 5, maxRows: 20, maxDurationMs: 1_000, pageSize: 1 } },
    relations: rawRows.map((rawFields, index) => ({ sequenceNo: index + 1, relationKey: rawFields.id, rawFields: rawFields as Record<string,string> })),
  }, supplemental.id, 'b'.repeat(64))
  const large = submitNativePlatformQuery(sqlite, { ...businessSource('full-history-limit'), rawResponse: 'x'.repeat(MAX_FULL_QUERY_BYTES + 1) })
  const source = join(dir, 'source.sqlite')
  const pgEnv = { ...process.env, PGHOST: dir, PGPORT: '5432', PGDATABASE: 'postgres', PGUSER: 'history_fixture', PGSQL_BIN: join(pgBin!, 'psql') }
  const ctl = (...args: string[]) => execFileSync(join(pgBin!, 'pg_ctl'), ['-D', join(dir, 'pg'), '-w', ...args], { env: pgEnv })
  let started = false
  let pool: pg.Pool | undefined
  try {
    await sqlite.$client.backup(source)
    execFileSync(join(pgBin!, 'initdb'), ['-A', 'trust', '-E', 'UTF8', '--locale=C', '-U', 'history_fixture', '-D', join(dir, 'pg')], { env: pgEnv })
    ctl('-l', join(dir, 'pg.log'), '-o', `-h '' -k ${dir}`, 'start')
    started = true
    execFileSync(process.execPath, ['upgrade/pg/sqlite-import/stage-sqlite.mjs', source, 'staged'], { env: pgEnv })
    for (const layer of ['enterprise-directory', 'enterprise-identity', 'jobs', 'file-and-lead-lists', 'roster']) {
      execFileSync(pgEnv.PGSQL_BIN, ['-Xqw', '-v', 'staging=staged', '-f', `upgrade/pg/sqlite-import/materialize-${layer}.sql`], { env: pgEnv })
    }
    pool = new pg.Pool({ user: pgEnv.PGUSER, database: pgEnv.PGDATABASE, host: dir, port: 5432, options: '-c search_path=business,public' })
    const db = drizzle({ client: pool })
    const summary = { queryId: observed.queryId, view: 'summary' as const }
    expect(await readPostgresPlatformQueries(db, summary)).toEqual(listPlatformQueries(sqlite, summary))
    const saved = (await readPostgresPlatformQueries(db, { queryId: observed.queryId })).rows[0]!
    expect(saved.query.collectionEvidence).toMatchObject({ fetchedCount: 2, pages: [{ page: 1 }, { page: 2 }] })
    expect(saved.relations.map(row => [row.sourceRdjb, row.sourcePage])).toEqual([['2', 1], ['2', 2]])
    expect(saved.relations[0]).toMatchObject({ id: observed.relationIds[0], nameRaw: '合成🙂企业', status: '终审通过', aliasNameRaw: '原名' })
    expect(JSON.stringify(saved)).not.toContain('页面一原文')
    expect(JSON.stringify(saved)).not.toContain(rawResponse)
    expect((await readPostgresPlatformQueries(db, { queryId: large.queryId })).total).toBe(1)
    expect((await pool.query("SELECT to_regclass('business.platform_archive_value') IS NULL AS absent")).rows).toEqual([{ absent: true }])
    expect(bytes(sqlite, observed.queryId, 'rawResponse')).toEqual(Buffer.from(rawResponse))
  } finally {
    await pool?.end()
    if (started) ctl('-m', 'fast', 'stop')
    rmSync(dir, { recursive: true, force: true })
  }
}, 90_000)
