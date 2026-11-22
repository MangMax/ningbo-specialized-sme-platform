import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { count, eq } from 'drizzle-orm'
import { createApp, createRouter, defineEventHandler, getRouterParam, readBody, setResponseStatus, toNodeListener } from 'h3'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { job } from '../../../db/postgresql/job-tables'
import { record } from '../../../db/postgresql/ledger-tables'
import { platformBusinessObservation, platformBusinessRecordVersion } from '../../../db/postgresql/platform-tables'
import { readPostgresPlatformQueries } from '../../../layers/sme-roster/lib/platform/postgres-query-read'
import { newJobId } from '../../../layers/core/lib/job'
import { clearJobSpecs, registerJob } from '../../../layers/core/server/utils/job-spec-registry'
import { getPostgresJob } from '../../../layers/core/server/utils/job-store-postgres'
import { stopPostgresJobs } from '../../../layers/core/server/utils/postgres-jobs'
import type { PlatformLiveQueryResult } from '../../../layers/sme-roster/lib/platform/live-query'
import { platformResultToImport } from '../../../layers/sme-roster/lib/platform/recognized-evidence'
import { commitPostgresPlatformCollection } from '../../../layers/sme-roster/server/utils/collection-import-postgres'
import { differenceSnapshotSpec } from '../../../layers/sme-roster/server/utils/difference-snapshot'
import { runPlatformLiveQuery } from '../../../layers/sme-roster/server/utils/platform-live-query'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

const dir = mkdtempSync(join(tmpdir(), 'difference-snapshot-'))
function archive(source: PlatformLiveQueryResult['source'], broken = false): PlatformLiveQueryResult {
  const titles = source === 'queryList' ? [null] : ['1','2','3']
  return { source, status: broken ? 'partial' : 'no_record', effectiveConditions: { uscc: '91330200123456789X', combination: 'and' }, titleScope: { mode: source === 'queryList' ? 'source_default' : 'selected', rdjb: titles.filter((x): x is string => x !== null) }, queriedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z', rows: [], dataRows: [], pages: titles.flatMap(rdjb => (broken ? [1,2] : [1]).map(page => ({ source, rdjb, page, maxPage: broken ? 2 : 1, status: broken && page === 2 ? 'failed' as const : 'success' as const, fetchedCount: broken && page === 1 ? 50 : 0, declaredTotal: broken ? 51 : 0, error: null }))), fetchedCount: 0, declaredTotal: 0, completeness: broken ? 'partial' : 'complete', fullRange: true, unfinished: broken ? [{ source, rdjb: titles[0]!, page: 2 }] : [], error: null, limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 } }
}
vi.mock('../../../layers/sme-roster/server/utils/platform-live-query', () => ({ runPlatformLiveQuery: vi.fn(async (input: {source: PlatformLiveQueryResult['source']}) => ({...archive((input as {source:PlatformLiveQueryResult['source']}).source,true),pages:[],effectiveConditions:{combination:'and'},unfinished:[],completeness:'partial'})) }))
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))

beforeEach(() => {
  // The offline and runtime specs use the same persisted kind on separate databases.
  clearJobSpecs()
  vi.mocked(runPlatformLiveQuery).mockReset()
})

describe('PostgreSQL snapshot public handlers', () => {
  let fixture: Awaited<ReturnType<typeof postgresRuntimeFixture>>
  let server: Server
  let snapshotUrl: string
  let db: ReturnType<typeof usePostgresDirectoryDb>
  let scenario = 0
  const headers = { authorization: 'Bearer fixture-token', 'content-type': 'application/json' }

  beforeAll(async () => {
    fixture = await postgresRuntimeFixture({ dir })
    vi.stubGlobal('useRuntimeConfig', () => ({ filesDir: join(dir, 'files'), apiToken: 'fixture-token' }))
    vi.stubGlobal('defineEventHandler', defineEventHandler)
    vi.stubGlobal('readBody', readBody)
    vi.stubGlobal('setResponseStatus', setResponseStatus)
    vi.stubGlobal('getRouterParam', getRouterParam)
    const post = (await import('../../../layers/sme-roster/server/api/roster/difference-snapshots/index.post')).default
    const get = (await import('../../../layers/sme-roster/server/api/roster/difference-snapshots/[id].get')).default
    const router = createRouter().post('/snapshot', post).get('/snapshot/:id', get)
    server = createServer(toNodeListener(createApp().use(router)))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    snapshotUrl = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/snapshot'
  }, 30_000)

  beforeEach(() => {
    registerJob(differenceSnapshotSpec)
    // Clone the native template so each scenario owns its tasks and history.
    const database = 'snapshot_case_' + ++scenario
    fixture.psql(['-c', 'CREATE DATABASE ' + database + ' TEMPLATE postgres'])
    vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', databaseUrl(database))
    vi.stubEnv('NUXT_POSTGRES_BIN', fixture.env.NUXT_POSTGRES_BIN)
    vi.stubEnv('NUXT_DB_READONLY', '0')
    vi.stubEnv('MIIT_COOKIE', 'fixture-cookie')
    db = usePostgresDirectoryDb()
  })

  afterEach(async () => {
    try { await stopPostgresJobs() }
    finally {
      await closePostgresDirectoryDb()
      vi.unstubAllEnvs()
    }
  })

  afterAll(async () => {
    try {
      if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    } finally {
      vi.unstubAllGlobals()
      fixture?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function databaseUrl(database: string) {
    const url = new URL(fixture.url)
    url.pathname = '/' + database
    return url.href
  }

  async function publishedEnterprise(name: string, usccNorm?: string) {
    const [owner] = await db.insert(enterprise).values({ name, nameNorm: name, usccNorm }).returning()
    await db.insert(record).values({ enterpriseId: owner!.id, titleCode: 'innovative_sme', source: 'jxj' })
    return owner!
  }

  async function importHistoricalCollection(archive: PlatformLiveQueryResult) {
    const outcome = await commitPostgresPlatformCollection(db, {
      idempotencyKey: 'history:' + archive.source,
      sourceKind: 'platform_archive',
      sourceIdentity: 'historical-empty-fixture',
      payload: { platformQueries: [platformResultToImport(archive)] },
    }, async () => {})
    expect(outcome.status).toBe('committed')
  }

  async function publicHttp(body: unknown) {
    const response = await fetch(snapshotUrl, { method: 'POST', headers, body: JSON.stringify(body) })
    const result = await response.json()
    expect(response.status, JSON.stringify(result)).toBe(202)
    return result
  }

  async function settledPostgres(id: string) {
    let job: NonNullable<Awaited<ReturnType<typeof getPostgresJob>>>['row']
    await vi.waitFor(async () => {
      job = (await getPostgresJob(db, id))!.row
      expect(['done', 'failed', 'cancelled']).toContain(job.state)
    }, { timeout: 15_000 })
    return job!
  }

  async function readMcp(jobId: string) {
    const tool = (await import('../../../layers/sme-roster/server/mcp/tools/difference_snapshot')).default as unknown as {
      handler: (input: unknown) => Promise<{ content: { text: string }[] }>
    }
    return JSON.parse((await tool.handler({ action: 'read', jobId })).content[0]!.text)
  }

  async function observationCount() {
    const [value] = await db.select({ rows: count() }).from(platformBusinessObservation)
    return value!.rows
  }

  it('creates and reads the same snapshot through authenticated HTTP and MCP public handlers', async () => {
    const owner = await publishedEnterprise('unmatched published enterprise')
    expect((await fetch(snapshotUrl, { method: 'POST', body: '{}' })).status).toBe(401)
    const row = await publicHttp({ action: 'create', clientRequestId: 'public' })
    const done = await settledPostgres(row.id)
    const readback = await fetch(snapshotUrl + '/' + row.id, { headers })
    expect(readback.status).toBe(200)
    expect(await readback.json()).toEqual(done)
    const mcp = await readMcp(row.id)
    expect(mcp).toEqual(done)
    expect(mcp.result).toMatchObject({
      scope: [{ enterpriseId: owner.id }],
      counts: { enterprises: 1, unfinished: 7 },
      collectionPolicy: 'per_enterprise_fresh_same_job_resume',
    })

    const backup = row.params.backup as { path: string; sha256: string }
    expect(createHash('sha256').update(readFileSync(backup.path)).digest('hex')).toBe(backup.sha256)
    fixture.psql(['-c', 'CREATE DATABASE snapshot_restore'])
    const restored = databaseUrl('snapshot_restore')
    fixture.psql(['--dbname=' + restored, '-c', 'CREATE EXTENSION pg_trgm'])
    execFileSync(join(fixture.env.NUXT_POSTGRES_BIN, 'pg_restore'), [
      '--no-password', '--exit-on-error', '--dbname=' + restored, backup.path,
    ], { stdio: 'pipe' })
    const facts = fixture.psql(['--dbname=' + restored, '-At', '-c',
      "SELECT e.id, e.name FROM business.enterprise e JOIN business.record r ON r.enterprise_id=e.id WHERE r.source='jxj'"])
    expect(facts.trim()).toBe(owner.id + '|unmatched published enterprise')
    expect(fixture.psql(['--dbname=' + restored, '-At', '-c', 'SELECT count(*) FROM business.job']).trim()).toBe('0')
    appendFileSync(backup.path, 'tamper')
    const retry = await fetch(snapshotUrl, {
      method: 'POST', headers, body: JSON.stringify({ action: 'retry', jobId: row.id }),
    })
    expect(retry.status).toBe(409)
    expect(await readMcp(row.id)).toEqual(done)
  })

  it('fresh tasks query all interfaces despite historical empty completion and reuse only identical clientRequestId', async () => {
    await publishedEnterprise('fixture', '91330200123456789X')
    for (const source of ['queryList','businessList','queryBusList'] as const)
      await importHistoricalCollection(archive(source))
    await db.insert(job).values({ id: newJobId(), kind: 'platform-query-batch', params: '{}', state: 'done',
      progress: '{"done":1,"total":1}', createdAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:00:01Z',
      result: JSON.stringify({items:[{itemId:'old-empty',segments:['queryList','businessList','queryBusList'].map(source=>archive(source as PlatformLiveQueryResult['source']))}]}),
    })
    const calls:string[]=[]
    vi.mocked(runPlatformLiveQuery).mockImplementation(async raw=>{
      const q=raw as {source:PlatformLiveQueryResult['source'];rdjb?:string|string[]}
      calls.push(q.source)
      const r=archive(q.source)
      const title=q.source==='queryList'?null:Array.isArray(q.rdjb)?q.rdjb[0]!:q.rdjb!
      r.pages=r.pages.filter(p=>p.rdjb===title).map(p=>({...p,fetchedCount:1,declaredTotal:1}))
      r.status='success'
      r.titleScope={mode:q.source==='queryList'?'source_default':'selected',rdjb:title?[title]:[]}
      r.rows=[{id:`${q.source}-${title}`,qymc:'fixture',tyshxydm:'91330200123456789X'}]
      r.dataRows=r.rows
      r.fetchedCount=1;r.declaredTotal=1
      r.queriedAt=new Date(Date.now()+calls.length).toISOString();r.completedAt=r.queriedAt
      return r
    })
    for (const clientRequestId of ['fresh-one','fresh-two']) {
      const row=await publicHttp({action:'create',clientRequestId})
      const done=await settledPostgres(row.id)
      expect(done.state).toBe('done')
      expect(done.result).toMatchObject({counts:{rows:7,requests:7,unfinished:0}})
      const before=calls.length
      expect((await publicHttp({action:'create',clientRequestId})).id).toBe(row.id)
      expect(calls).toHaveLength(before)
    }
    expect(calls).toEqual(['queryList','businessList','businessList','businessList','queryBusList','queryBusList','queryBusList', 'queryList','businessList','businessList','businessList','queryBusList','queryBusList','queryBusList'])
  })

  it('collects missing per-enterprise title pages and resumes only failed positions through HTTP retry and MCP read', async () => {
    const e = await publishedEnterprise('collect', '91330200111111111X')
    let failedOnce=false
    const calls:{source:string;startPage:number;rdjb:unknown}[]=[]
    vi.mocked(runPlatformLiveQuery).mockImplementation(async raw => {
      const q=raw as {source:PlatformLiveQueryResult['source'];uscc?:string;rdjb?:string|string[];startPage:number}
      if(q.uscc!=='91330200111111111X') return {...archive(q.source,true),pages:[],completeness:'partial'}
      calls.push({source:q.source,startPage:q.startPage,rdjb:q.rdjb})
      const title=q.source==='queryList'?null:Array.isArray(q.rdjb)?q.rdjb[0]!:q.rdjb!
      const broken=q.source==='businessList'&&title==='2'&&!failedOnce
      if(broken)failedOnce=true
      const r=archive(q.source,broken)
      r.effectiveConditions.uscc=q.uscc
      r.titleScope.rdjb=title?[title]:[]
      r.limits.pageSize=1
      r.fullRange=q.startPage===1
      r.pages=[1,2].filter(p=>p>=q.startPage).map(page=>({source:q.source,rdjb:title,page,maxPage:2,status:broken&&page===2?'failed':'success',fetchedCount:broken&&page===2?0:1,declaredTotal:2,error:null}))
      r.unfinished=broken?[{source:q.source,rdjb:title,page:2}]:[]
      r.titleScope.mode=q.source==='queryList'?'source_default':'selected'
      r.rows=r.pages.filter(p=>p.status==='success').map(p=>({id:`${q.source}-${title}-${p.page}`,qymc:'collect',tyshxydm:q.uscc!}))
      r.dataRows=r.rows;r.fetchedCount=r.rows.length;r.declaredTotal=2
      r.status=broken?'partial':'success';r.completeness=broken?'partial':'complete'
      r.queriedAt=new Date(Date.now()+calls.length).toISOString();r.completedAt=r.queriedAt
      return r
    })
    const row=await publicHttp({action:'create',clientRequestId:'collect'})
    const first=await settledPostgres(row.id)
    const target=(first.result as {items:{enterpriseId:number;complete:boolean;rows:number|null}[]}).items.filter(i=>i.enterpriseId===e.id)
    expect(target.filter(i=>i.complete)).toHaveLength(6)
    expect(target.filter(i=>!i.complete)[0]!.rows).toBeNull()
    expect(calls).toHaveLength(7)
    await publishedEnterprise('later')
    await importHistoricalCollection({ ...archive('businessList'), effectiveConditions: { uscc: e.usccNorm!, combination: 'and' }, queriedAt: '2099-01-01T00:00:00Z', completedAt: '2099-01-01T00:00:01Z' })
    const beforeRetry=await observationCount()
    await publicHttp({action:'retry',jobId:row.id})
    const done=await settledPostgres(row.id)
    expect(await observationCount()).toBe(beforeRetry+1)
    expect(calls).toHaveLength(8)
    expect(calls.at(-1)).toEqual({source:'businessList',rdjb:'2',startPage:2})
    expect((done.result as {items:{enterpriseId:number;complete:boolean;rows:number}[]}).items.filter(i=>i.enterpriseId===e.id).every(i=>i.complete&&i.rows===2)).toBe(true)
    await publicHttp({action:'retry',jobId:row.id})
    await settledPostgres(row.id)
    expect(calls).toHaveLength(8)
    expect(await observationCount()).toBe(beforeRetry+1)
    expect(done.state).toBe('done')
    const read = await readMcp(row.id)
    expect(read.result.counts).toMatchObject({enterprises:1,unfinished:0,rows:14})
  })

  // One source crosses the real 50-row page boundary; the other six slots prove empty completion.
  // Bound the integration runner at 30s, below the source's explicit 60s budget;
  // metadata and selected-scope tests retain the default 5s.
  it('runs real provider pagination with metadata-only checkpoints and complete business rows', async () => {
    await publishedEnterprise('fixture provider', '91330200222222222X')
    const actual=await vi.importActual<typeof import('../../../layers/sme-roster/server/utils/platform-live-query')>('../../../layers/sme-roster/server/utils/platform-live-query')
    const calls:{source:string;page:number}[]=[]
    vi.mocked(runPlatformLiveQuery).mockImplementation((input,ctx)=>actual.runPlatformLiveQuery(input,{...ctx,cookie:'fixture-cookie',transport:{fetchImpl:async (url,init)=>{
      const source=String(url).includes('queryBusList')?'queryBusList':String(url).includes('businessList')?'businessList':'queryList'
      const body=new URLSearchParams(String(init?.body)),page=Number(body.get('pageNum'))
      calls.push({source,page})
      const grid=source==='queryBusList'?'businessGrid':source==='businessList'?'businessListGrid':'applyGrid'
      return {ok:true,status:200,text:async()=>JSON.stringify({zrarData:{grid:{[grid]:{page,pageSize:50,maxCount:source==='queryList'?51:0,maxPage:source==='queryList'?2:1,pageSet:Array.from({length:source!=='queryList'?0:page===1?50:1},(_,i)=>({id:`${source}-${page}-${i}`,qymc:'fixture provider',tyshxydm:'91330200222222222X',unknown:{nested:[null,false,17]},blank:null}))}}}})}
    }}}))
    const row=await publicHttp({action:'create',clientRequestId:'real-provider-fixture'})
    const done=await settledPostgres(row.id)
    expect(done.state).toBe('done')
    expect(calls).toHaveLength(8)
    expect(calls.filter(c=>c.page===2)).toEqual([{source:'queryList',page:2}])
    expect(done.result).toMatchObject({counts:{enterprises:1,unfinished:0,rows:51,requests:8}})
    const result=done.result as {items:{segments:PlatformLiveQueryResult[]}[]}
    expect(result.items.every(i=>i.segments.every(segment=>!Object.hasOwn(segment,'rows')&&!Object.hasOwn(segment,'rawData')&&!Object.hasOwn(segment,'dataRows')))).toBe(true)
    const versions = await db.select({ id: platformBusinessRecordVersion.id }).from(platformBusinessRecordVersion)
    expect(versions).toHaveLength(51)
    const facts = await db.select({ fields: platformBusinessRecordVersion.businessFields }).from(platformBusinessRecordVersion)
    expect(facts).toHaveLength(51)
    expect(facts.every(({ fields }) => fields?.qymc === 'fixture provider' && !('blank' in fields) && !('unknown' in fields))).toBe(true)
  }, 30_000)

  it('reads identical current display fields after moving repeated capture rows to one version payload', async () => {
    const name = '共享版本合成企业'
    const shared = { id: 'shared-version', qymc: name, accepted: true, blank: '', nested: { offline: true } }
    const versionless = { qymc: name, count: 9 }
    for (const day of ['01', '02']) {
      const result = await commitPostgresPlatformCollection(db, {
        idempotencyKey: 'version-payload:' + day, sourceKind: 'platform_archive', sourceIdentity: name,
        payload: { platformQueries: [{
          interface: 'apply_list', queryKey: 'name:' + name, queriedAt: '2026-06-' + day + 'T00:00:00Z',
          status: 'success', rawResponse: '{}', relations: [
            { sequenceNo: 1, relationKey: shared.id, nameRaw: name, rawFields: shared },
            { sequenceNo: 2, relationKey: shared.id, nameRaw: name, rawFields: shared },
            { sequenceNo: 3, nameRaw: name, rawFields: versionless },
          ],
        }] },
      }, async () => {})
      expect(result.status).toBe('committed')
    }
    const listing = async () => (await readPostgresPlatformQueries(db, { page: 1, pageSize: 10, view: 'full' }))
      .rows.map(row => row.relations.map(relation => relation.rawFields))
    const verified = { id: shared.id, qymc: name, accepted: true }
    const before = await listing()
    expect(before).toEqual([[verified, verified, versionless], []])
    const target = '--dbname=' + process.env.NUXT_POSTGRES_DIRECTORY_URL!
    const sql = (statement: string) => fixture.psql([target, '-At', '-c', statement]).trim()
    expect(sql(`
      SELECT count(*) FILTER (WHERE version_id IS NOT NULL AND business_fields IS NULL),
        count(*) FILTER (WHERE version_id IS NULL AND business_fields IS NOT NULL)
      FROM business.platform_business_observation
    `)).toBe('2|2')
    expect(sql('SELECT count(*) FROM business.platform_business_record_version WHERE business_fields IS NOT NULL')).toBe('1')

    sql('ALTER TABLE business.platform_business_observation DROP CONSTRAINT platform_observation_business_fields_owner')
    sql(`UPDATE business.platform_business_observation o SET business_fields=v.business_fields
      FROM business.platform_business_record_version v WHERE v.id=o.version_id`)
    sql('ALTER TABLE business.platform_business_record_version DROP COLUMN business_fields')
    const conflicted = sql(`UPDATE business.platform_business_observation SET business_fields=NULL
      WHERE id=(SELECT min(id) FROM business.platform_business_observation WHERE version_id IS NOT NULL) RETURNING id`)
      .split('\n')[0]!
    const migrate = () => fixture.psql([target, '-f', 'upgrade/pg/2026-11-data-compaction/steps/05-install-platform-version-business-fields.sql'])
    expect(migrate).toThrow('conflicting observation business fields')
    expect(sql("SELECT count(*) FROM information_schema.columns WHERE table_schema='business' AND table_name='platform_business_record_version' AND column_name='business_fields'")).toBe('0')
    sql(`UPDATE business.platform_business_observation SET business_fields='{"id":"shared-version","qymc":"共享版本合成企业","accepted":true}'::jsonb WHERE id=${Number(conflicted)}`)
    const size = () => Number(sql(`SELECT coalesce(sum(pg_column_size(business_fields)),0)
      FROM business.platform_business_observation`))
    const legacySize = size()
    migrate()
    migrate()
    expect(await listing()).toEqual(before)
    expect(size() + Number(sql('SELECT sum(pg_column_size(business_fields)) FROM business.platform_business_record_version')))
      .toBeLessThan(legacySize)
  }, 30_000)

  it.each(['short-tail','retained-total'] as const)('real provider public snapshot handles %s across retry without erasing attempts', async mode => {
    await publishedEnterprise('fixture provider', '91330200222222222X')
    const actual=await vi.importActual<typeof import('../../../layers/sme-roster/server/utils/platform-live-query')>('../../../layers/sme-roster/server/utils/platform-live-query')
    const calls:number[]=[]
    let retry=false
    vi.mocked(runPlatformLiveQuery).mockImplementation((input,ctx)=>actual.runPlatformLiveQuery(input,{...ctx,cookie:'fixture-cookie',transport:{fetchImpl:async (url,init)=>{
      const source=String(url).includes('queryBusList')?'queryBusList':String(url).includes('businessList')?'businessList':'queryList'
      const page=Number(new URLSearchParams(String(init?.body)).get('pageNum'))
      if(source==='queryList')calls.push(page)
      if(source==='queryList'&&mode==='retained-total'&&page===3&&!retry) return {ok:false,status:503,text:async()=>''}
      const grid=source==='queryBusList'?'businessGrid':source==='businessList'?'businessListGrid':'applyGrid'
      const count=source!=='queryList'?0:page===1?50:page===2?(mode==='short-tail'?10:50):0
      return {ok:true,status:200,text:async()=>JSON.stringify({zrarData:{grid:{[grid]:{page,pageSize:50,...(source!=='queryList'?{maxCount:0,maxPage:1}:mode==='retained-total'?{maxPage:3,...(page===1?{maxCount:101}:{})}:{}),pageSet:Array.from({length:count},(_,i)=>({id:page+'-'+i,qymc:'fixture provider'}))}}}})}
    }}}))
    const row=await publicHttp({action:'create',clientRequestId:mode})
    const first=await settledPostgres(row.id)
    expect(first.state).toBe(mode==='short-tail'?'done':'failed')
    retry=true
    await publicHttp({action:'retry',jobId:row.id})
    const done=await settledPostgres(row.id)
    const read = await readMcp(row.id)
    expect(read.result).toEqual(done.result)
    const item=read.result.items.find((i:{source:string})=>i.source==='queryList')
    if(mode==='short-tail') {
      expect(calls).toEqual([1,2,3])
      expect(item).toMatchObject({complete:true,rows:60})
      expect(item.segments[0].pages.map((p:{declaredTotal:number|null})=>p.declaredTotal)).toEqual([null,null,null])
    } else {
      expect(calls).toEqual([1,2,3,3])
      expect(done.state).toBe('failed')
      expect(item).toMatchObject({complete:false,rows:null})
      expect(item.segments[0].pages.map((p:{status:string})=>p.status)).toEqual(['success','success','failed'])
      expect(item.segments[0].pages[0].declaredTotal).toBe(101)
      expect(item.segments[0].pages[1].declaredTotal).toBeNull()
      expect(item.segments[1].unfinished).toContainEqual({source:'queryList',rdjb:null,page:3})
    }
  }, 30_000)
  it('freezes exactly selected published enterprise IDs and rejects unknown IDs without creating a task', async () => {
    const selected = await publishedEnterprise('selected')
    const excluded = await publishedEnterprise('excluded')
    const body = { action: 'create', clientRequestId: 'selected', enterpriseIds: [selected.id, selected.id] }
    const row = await publicHttp(body)
    const done = await settledPostgres(row.id)
    expect((done.result as { scope: { enterpriseId: number }[] }).scope.map(item => item.enterpriseId)).toEqual([selected.id])
    expect((await publicHttp(body)).id).toBe(row.id)
    const otherScope = await fetch(snapshotUrl, { method: 'POST', headers, body: JSON.stringify({ ...body, enterpriseIds: [excluded.id] }) })
    expect(otherScope.status).toBe(409)
    const before = await db.$count(job)
    const unknown = await fetch(snapshotUrl, { method: 'POST', headers, body: JSON.stringify({ ...body, clientRequestId: 'unknown', enterpriseIds: [99999] }) })
    expect(unknown.status).toBe(400)
    expect(await db.$count(job)).toBe(before)
  })
})
