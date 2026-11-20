import { createRuntimeSchema } from '../../../db/create-runtime'
import { createServer, type Server } from 'node:http'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createApp, defineEventHandler, toNodeListener } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import * as schema from '../../../db/schema'
vi.mock('@nuxtjs/mcp-toolkit/server',()=>({defineMcpTool:(value:unknown)=>value}))
vi.mock('@db',()=>({useDb:()=>db}))
const sqlite=new Database(':memory:'),db=drizzle(sqlite,{schema})
let server:Server,base:string
let refreshTool: (typeof import('../../../layers/sme-roster/server/mcp/tools/refresh_enterprise_differences'))['default']
let readTool: (typeof import('../../../layers/sme-roster/server/mcp/tools/list_enterprise_difference_comparisons'))['default']
beforeAll(async()=>{
 sqlite.pragma('foreign_keys=ON'); createRuntimeSchema(sqlite)
 const e=db.insert(schema.enterprise).values({name:'传输合成',nameNorm:'传输合成'}).returning().get()
 db.insert(schema.record).values({enterpriseId:e.id,titleCode:'specialized_sme',source:'jxj',nameRaw:e.name}).run()
 vi.stubGlobal('useRuntimeConfig',()=>({apiToken:'refresh-test-token'}));vi.stubGlobal('defineEventHandler',defineEventHandler)
 const post=(await import('../../../layers/sme-roster/server/api/roster/differences/refresh.post')).default
 const get=(await import('../../../layers/sme-roster/server/api/roster/differences/refresh.get')).default
 refreshTool=(await import('../../../layers/sme-roster/server/mcp/tools/refresh_enterprise_differences')).default
 readTool=(await import('../../../layers/sme-roster/server/mcp/tools/list_enterprise_difference_comparisons')).default
 const app=createApp();app.use('/api/roster/differences/refresh',defineEventHandler(event=>event.method==='POST'?post(event):get(event)))
 server=createServer(toNodeListener(app));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`
})
afterAll(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));sqlite.close();vi.unstubAllGlobals()})
const request=(method:string,body?:unknown,query='')=>fetch(`${base}/api/roster/differences/refresh${query}`,{method,headers:{authorization:'Bearer refresh-test-token','content-type':'application/json',connection:'close'},...(body===undefined?{}:{body:JSON.stringify(body)})})
it('HTTP and MCP share refresh and persisted read semantics',async()=>{
 const first=await request('POST',{enterpriseIds:[1]});expect(first.status).toBe(200)
 const initial=await first.json();expect(initial.refreshed).toBe(3)
 const toolResult=await refreshTool.handler({enterpriseIds:[1]},{} as never) as {content:{text:string}[]}
 const repeated=JSON.parse(toolResult.content[0]!.text);expect(repeated.refreshed).toBe(0);expect(repeated.unchanged).toBe(3)
 const http=await (await request('GET',undefined,'?enterpriseIds=1')).json()
 const mcp=await readTool.handler({enterpriseIds:[1]},{} as never) as {content:{text:string}[]}
 expect(http).toEqual(JSON.parse(mcp.content[0]!.text));expect(http.enterprises[0].comparisons.every((c:{status:string})=>c.status==='needs_review')).toBe(true)
})
it('HTTP and MCP reject empty duplicate and unknown enterprise scopes',async()=>{
 for(const input of [{enterpriseIds:[]},{enterpriseIds:[1,1]},{enterpriseIds:[999]}]){
  expect((await request('POST',input)).status).toBe(400)
  await expect(refreshTool.handler(input,{} as never)).rejects.toThrow()
 }
 for(const query of ['?enterpriseIds=','?enterpriseIds=1,1','?enterpriseIds=1x','?extra=1'])expect((await request('GET',undefined,query)).status).toBe(400)
})
it('HTTP requires token or same-origin browser provenance',async()=>{
 expect((await fetch(`${base}/api/roster/differences/refresh`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(401)
 const result=await fetch(`${base}/api/roster/differences/refresh`,{method:'POST',headers:{'content-type':'application/json','x-task-center-browser':'1','sec-fetch-site':'same-origin',origin:base},body:'{"enterpriseIds":[1]}'})
 expect(result.status).toBe(200)
 expect(refreshTool.enabled!({context:{mcpAuth:{writeAuthorized:false}}} as never)).toBe(false)
})

it('public refresh keeps frozen lower comparison when only higher qualification changes and never invents platform error',async()=>{
 const e=db.insert(schema.enterprise).values({name:'继承刷新',nameNorm:'继承刷新',usccNorm:'91330200123456789X'}).returning().get()
 const r=db.insert(schema.record).values({enterpriseId:e.id,titleCode:'specialized_sme',source:'jxj',nameRaw:e.name}).returning().get()
 const event=db.insert(schema.recordEvent).values({recordId:r.id,eventType:'award',year:2025,batchSeq:1}).returning().get()
 db.insert(schema.recordEvidence).values({recordEventId:event.id,sourceFile:'synthetic-refresh.pdf'}).run()
 db.insert(schema.record).values({enterpriseId:e.id,titleCode:'innovative_sme',source:'miit',nameRaw:e.name}).run()
 const {readCurrentQualificationAssessment}=await import('../../../layers/sme-roster/lib/roster/current-qualification')
 expect(readCurrentQualificationAssessment(sqlite,e.id,Date.parse('2026-06-01')).titles.find(t=>t.titleCode==='innovative_sme')!.group).toBe('eligible')
 const first=await (await request('POST',{enterpriseIds:[e.id]})).json()
 const lower=first.enterprises[0].comparisons.find((c:{titleCode:string})=>c.titleCode==='innovative_sme')
 expect(lower.status).toBe('needs_review')
 expect(lower.comparisonError).toBe(null)
 expect(lower).toMatchObject({comparisonState:'not_established',reasons:[]})
 sqlite.prepare('update record_event set year=2018 where id=?').run(event.id)
 const second=await (await request('POST',{enterpriseIds:[e.id]})).json()
 const {refreshedAt: _refreshedAt,...business}=lower
 expect(second.enterprises[0].comparisons.find((c:{titleCode:string})=>c.titleCode==='innovative_sme')).toMatchObject(business)
 const readback=await (await request('GET',undefined,`?enterpriseIds=${e.id}`)).json()
 expect(readback.enterprises).toEqual(second.enterprises)
 expect(readCurrentQualificationAssessment(sqlite,e.id,Date.parse('2026-06-01')).titles.find(t=>t.titleCode==='innovative_sme')!.group).not.toBe('eligible')
})

async function seedComparablePlatformAward() {
 const { submitNativePlatformQuery } = await import('../../platform/fixtures/native-query')
 const { appendOfficialEvidenceRevision } = await import('../../../layers/sme-roster/server/utils/official-evidence')
 const { preflightRecordCorrespondences, commitRecordCorrespondences } = await import('../../../layers/sme-roster/server/utils/record-correspondence')
 const enterpriseId = 1, titleCode = 'specialized_sme', uscc = '91330211255994457P', name = '传输合成'
 sqlite.prepare('UPDATE enterprise SET uscc_norm=? WHERE id=?').run(uscc, enterpriseId)
 const { id: recordId } = sqlite.prepare('UPDATE record SET uscc_raw=? WHERE enterprise_id=? RETURNING id').get(uscc, enterpriseId) as { id: number }
 const event = db.insert(schema.recordEvent).values({ recordId, eventType: 'award', year: 2025, decidedYear: 2025, batchSeq: 1 }).returning().get()
 const file = db.insert(schema.storedFile).values({ filename: 'refresh.pdf', ext: 'pdf', relPath: 'refresh.pdf',
  sha256: 'a'.repeat(64), bytes: 22 }).returning().get()
 const evidence = db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: file.relPath, listNo: 1 }).returning().get()
 const batch = db.insert(schema.importBatch).values({ idempotencyKey: 'refresh-source', sourceKind: 'announcement',
  sourceIdentity: file.relPath, status: 'committed' }).returning().get()
 appendOfficialEvidenceRevision(db, {
  evidenceId: evidence.id, eventId: event.id, capturedRecordId: recordId, capturedEnterpriseId: enterpriseId,
  nameRaw: name, usccRaw: uscc, districtRaw: null, sourceDocumentId: null, storedFileId: file.id, path: file.relPath,
  sha256: file.sha256, bytes: file.bytes, attachment: null, sectionKey: null, listNo: 1, page: null, sourceBindingKnown: false,
  actor: { type: 'agent', id: 'fixture' }, basis: '合成捕获', command: { kind: 'import', batchId: batch.id },
 }, 0)
 const queriedAt = '2026-05-31T00:00:00Z', rdjb = '2'
 const raw = { id: 'refresh-award', qymc: name, tyshxydm: uscc, sblx: '申请', sqsj: '2025-02-01', year: '2025', cszt: '终审通过' }
 const collection = submitNativePlatformQuery(db, {
  interface: 'business_list', titleCode, rdjb, queryKey: uscc, queriedAt, status: 'success',
  collectionEvidence: { source: 'businessList', status: 'success', effectiveConditions: { uscc, combination: 'and' },
   titleScope: { mode: 'selected', rdjb: [rdjb] }, queriedAt, completedAt: queriedAt, rows: [raw],
   rawData: { version: 1, rows: [raw], pages: [{ source: 'businessList', rdjb, page: 1, format: 'json',
    body: JSON.stringify({ zrarData: { grid: { businessListGrid: { pageSet: [raw], page: 1, pageSize: 50, maxCount: 1, maxPage: 1 } } } }) }] },
   pages: [{ source: 'businessList', rdjb, page: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }],
   fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null,
   limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 } },
  relations: [{ enterpriseId, sequenceNo: 1, relationKey: raw.id, nameRaw: name, usccRaw: uscc, rawFields: raw,
   matchBasis: 'uscc', verificationStatus: 'confirmed' }],
 })
 const decision = { idempotencyKey: 'refresh-award-binding', sourceIdentity: file.relPath,
  actor: { type: 'agent' as const, id: 'fixture' }, basis: '核对合成来源', ruleId: 'manual', ruleVersion: '1',
  operations: [{ action: 'create' as const, status: 'confirmed' as const,
   edge: { type: 'event_process' as const, role: 'supports_award' as const, eventId: event.id, relationId: collection.relationIds[0]! } }] }
 commitRecordCorrespondences(db, decision, preflightRecordCorrespondences(db, decision).planHash)
}

const pgBin = process.env.TEST_DIFFERENCE_REFRESH_PG_BIN
it.runIf(!!pgBin)('PostgreSQL HTTP and MCP refresh preserve a migrated fingerprint and newer judgment', async () => {
 const { execFileSync } = await import('node:child_process')
 const { mkdtempSync, rmSync } = await import('node:fs')
 const { join } = await import('node:path')
 const { installLeadListSchema } = await import('../../../layers/lead-lists/install-schema')
 const { closePostgresDirectoryDb } = await import('../../../db/postgresql/client')
 const dir = mkdtempSync('/tmp/diff-refresh-')
 const data = join(dir, 'pg')
 const env = { PATH: process.env.PATH, LANG: 'C', PGHOST: dir, PGPORT: '5432', PGDATABASE: 'postgres',
  PGUSER: 'refresh_fixture', PGSQL_BIN: join(pgBin!, 'psql') }
 const run = (command: string, args: string[]) => execFileSync(join(pgBin!, command), args, { env, stdio: 'pipe' })
 let started = false
 try {
  vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
  await seedComparablePlatformAward()
  const input = { enterpriseIds: [1] }
  const baseline = await (await request('POST', input)).json()
  const specialized = (result: typeof baseline) => result.enterprises[0].comparisons.find((c: { titleCode: string }) => c.titleCode === 'specialized_sme')
  expect(specialized(baseline)).toMatchObject({ comparisonState: 'synchronized', reasons: ['same_event_result_agrees'], comparisonError: null })
  installLeadListSchema(sqlite)
  const snapshot = join(dir, 'source.sqlite')
  await sqlite.backup(snapshot)
  sqlite.prepare("UPDATE record SET name_raw='变更公布名' WHERE enterprise_id=1").run()
  vi.setSystemTime(new Date('2026-06-03T00:00:00Z'))
  const sqliteChanged = await (await request('POST', input)).json()
  expect(specialized(sqliteChanged)).toMatchObject({
   status: 'needs_review', comparisonState: 'not_established', reasons: ['source_requires_revalidation'],
  })
  run('initdb', ['-A', 'trust', '-E', 'UTF8', '--locale=C', '-U', env.PGUSER, '-D', data])
  run('pg_ctl', ['-w', '-D', data, '-l', join(dir, 'postgres.log'), '-o', "-c listen_addresses='' -k " + dir, 'start'])
  started = true
  execFileSync(process.execPath, ['upgrade/postgresql/stage-sqlite.mjs', snapshot, 'staged'], { env, stdio: 'pipe' })
  const psql = (command: string) => run('psql', ['-X', '-w', '-v', 'ON_ERROR_STOP=1', '-c', command])
  for (const name of ['enterprise-directory', 'enterprise-identity', 'jobs', 'file-and-lead-lists', 'roster']) {
   run('psql', ['-X', '-w', '-v', 'ON_ERROR_STOP=1', '-v', 'staging=staged', '-f', 'upgrade/postgresql/materialize-' + name + '.sql'])
  }
  vi.stubEnv('NUXT_DB_READONLY', '1')
  vi.stubEnv('NUXT_POSTGRES_ROSTER_READ', '1')
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_WRITE', '1')
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', 'postgresql://refresh_fixture@localhost/postgres?host=' + encodeURIComponent(dir))
  psql(`INSERT INTO business.difference_reason(enterprise_id,title_code,direction,status,recorded_at,created_at)
   VALUES (1,'specialized_sme','missing_in_miit','confirmed_no_diff','2026-06-01T01:00:00Z','2026-06-01T01:00:00Z')`)
  vi.setSystemTime(new Date('2026-06-02T00:00:00Z'))
  const response = await request('POST', input)
  const repeat = await response.json()
  expect(response.status, JSON.stringify(repeat)).toBe(200)
  expect(repeat).toMatchObject({ refreshed: 0, unchanged: 3 })
  expect(repeat.enterprises[0].comparisons.map(({ titleCode, businessFingerprint, changedAt }: Record<string, string>) => ({ titleCode, businessFingerprint, changedAt })))
   .toEqual(baseline.enterprises[0].comparisons.map(({ titleCode, businessFingerprint, changedAt }: Record<string, string>) => ({ titleCode, businessFingerprint, changedAt })))
  expect(specialized(repeat)).toEqual({ ...specialized(baseline), status: 'confirmed_no_diff', refreshedAt: '2026-06-02T00:00:00.000Z' })
  psql("UPDATE business.record SET name_raw='变更公布名' WHERE enterprise_id=1 AND title_code='specialized_sme'")
  vi.setSystemTime(new Date('2026-06-03T00:00:00Z'))
  const [toolResult, competing] = await Promise.all([
   refreshTool.handler(input, {} as never) as Promise<{content:{text:string}[]}>,
   request('POST', input),
  ])
  expect(competing.status).toBe(200)
  const receipts = [JSON.parse(toolResult.content[0]!.text), await competing.json()].sort((a, b) => b.refreshed - a.refreshed)
  expect(receipts[0]).toEqual(sqliteChanged)
  expect(receipts[1]).toEqual({ ...sqliteChanged, refreshed: 0, unchanged: 3 })
  const readback = await (await request('GET', undefined, '?enterpriseIds=1')).json()
  expect(readback.enterprises).toEqual(sqliteChanged.enterprises)
  psql("UPDATE business.record SET name_raw='传输合成' WHERE enterprise_id=1 AND title_code='specialized_sme'")
  vi.setSystemTime(new Date('2026-06-04T00:00:00Z'))
  const restored = await (await request('POST', input)).json()
  expect(restored).toMatchObject({ refreshed: 1, unchanged: 2 })
  expect(specialized(restored)).toEqual({ ...specialized(baseline),
   changedAt: '2026-06-04T00:00:00.000Z', refreshedAt: '2026-06-04T00:00:00.000Z' })

  for (const invalid of [{ enterpriseIds: [1, 1] }, { enterpriseIds: [1, 9001] }]) {
   expect((await request('POST', invalid)).status).toBe(400)
   await expect(refreshTool.handler(invalid, {} as never)).rejects.toMatchObject({ statusCode: 400 })
  }
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_WRITE', '0')
  expect((await request('POST', input)).status).toBe(503)
  await expect(refreshTool.handler(input, {} as never)).rejects.toMatchObject({ statusCode: 503 })
  expect((await (await request('GET', undefined, '?enterpriseIds=1')).json()).enterprises).toEqual(restored.enterprises)
 } finally {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await closePostgresDirectoryDb()
  if (started) run('pg_ctl', ['-w', '-D', data, '-m', 'fast', 'stop'])
  rmSync(dir, { recursive: true, force: true })
 }
}, 60_000)
