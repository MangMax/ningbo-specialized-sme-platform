import { createRuntimeSchema } from '../../../db/create-runtime'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createApp, defineEventHandler, toNodeListener } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import * as schema from '../../../db/schema'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { record, recordEvent, recordEvidence } from '../../../db/postgresql/ledger-tables'
import { readPostgresCurrentQualification } from '../../../layers/sme-roster/lib/roster/current-qualification-postgres'
import { refreshEnterpriseDifferences } from '../../../layers/sme-roster/server/utils/enterprise-difference-refresh'
import { readPostgresRefreshFingerprints } from '../../../layers/sme-roster/server/utils/enterprise-difference-refresh-fingerprint-postgres'
import { installPlatformRefreshV2 } from '../../../upgrade/pg/2026-11-data-compaction/steps/support/platform-refresh-v2-migration'
import { readPostgresCandidateSourceBytes } from '../../../layers/sme-roster/server/utils/candidate-source-bytes-postgres'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
vi.mock('@nuxtjs/mcp-toolkit/server',()=>({defineMcpTool:(value:unknown)=>value}))
const sqlite=new Database(':memory:'),db=drizzle(sqlite,{schema})
const dir = mkdtempSync(join(tmpdir(), 'difference-refresh-'))
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
let server:Server,base:string
let refreshTool: (typeof import('../../../layers/sme-roster/server/mcp/tools/refresh_enterprise_differences'))['default']
let readTool: (typeof import('../../../layers/sme-roster/server/mcp/tools/list_enterprise_difference_comparisons'))['default']
beforeAll(async()=>{
 sqlite.pragma('foreign_keys=ON'); createRuntimeSchema(sqlite)
 const e=db.insert(schema.enterprise).values({name:'传输合成',nameNorm:'传输合成'}).returning().get()
 db.insert(schema.record).values({enterpriseId:e.id,titleCode:'specialized_sme',source:'jxj',nameRaw:e.name}).run()
 postgres = await postgresRuntimeFixture({ dir })
 vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
 vi.stubEnv('NUXT_DB_READONLY', '0')
 const native = usePostgresDirectoryDb()
 await native.insert(enterprise).values({name:e.name,nameNorm:e.nameNorm})
 await native.insert(record).values({enterpriseId:e.id,titleCode:'specialized_sme',source:'jxj',nameRaw:e.name})
 vi.stubGlobal('useRuntimeConfig',()=>({apiToken:'refresh-test-token'}));vi.stubGlobal('defineEventHandler',defineEventHandler)
 const post=(await import('../../../layers/sme-roster/server/api/roster/differences/refresh.post')).default
 const get=(await import('../../../layers/sme-roster/server/api/roster/differences/refresh.get')).default
 refreshTool=(await import('../../../layers/sme-roster/server/mcp/tools/refresh_enterprise_differences')).default
 readTool=(await import('../../../layers/sme-roster/server/mcp/tools/list_enterprise_difference_comparisons')).default
 const app=createApp();app.use('/api/roster/differences/refresh',defineEventHandler(event=>event.method==='POST'?post(event):get(event)))
 server=createServer(toNodeListener(app));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`
}, 30_000)
afterAll(async () => {
 if (server) await new Promise<void>(resolve=>server.close(()=>resolve()))
 await closePostgresDirectoryDb()
 postgres?.close()
 sqlite.close()
 vi.unstubAllEnvs()
 vi.unstubAllGlobals()
 rmSync(dir,{recursive:true,force:true})
})
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
 const native = usePostgresDirectoryDb()
 const [e] = await native.insert(enterprise).values({name:'继承刷新',nameNorm:'继承刷新',usccNorm:'91330200123456789X'}).returning()
 const [r] = await native.insert(record).values({enterpriseId:e!.id,titleCode:'specialized_sme',source:'jxj',nameRaw:e!.name}).returning()
 const [event] = await native.insert(recordEvent).values({recordId:r!.id,eventType:'award',year:2025,batchSeq:1}).returning()
 await native.insert(recordEvidence).values({recordEventId:event!.id,sourceFile:'synthetic-refresh.pdf'})
 await native.insert(record).values({enterpriseId:e!.id,titleCode:'innovative_sme',source:'miit',nameRaw:e!.name})
 const assessment = () => native.transaction(tx => readPostgresCurrentQualification(tx,e!.id,Date.parse('2026-06-01')), {isolationLevel:'repeatable read',accessMode:'read only'})
 expect((await assessment())!.titles.find(t=>t.titleCode==='innovative_sme')!.group).toBe('eligible')
 const first=await (await request('POST',{enterpriseIds:[e!.id]})).json()
 const lower=first.enterprises[0].comparisons.find((c:{titleCode:string})=>c.titleCode==='innovative_sme')
 expect(lower.status).toBe('needs_review')
 expect(lower.comparisonError).toBe(null)
 expect(lower).toMatchObject({comparisonState:'not_established',reasons:[]})
 await native.update(recordEvent).set({year:2018}).where(eq(recordEvent.id,event!.id))
 const second=await (await request('POST',{enterpriseIds:[e!.id]})).json()
 const {refreshedAt: _refreshedAt,...business}=lower
 expect(second.enterprises[0].comparisons.find((c:{titleCode:string})=>c.titleCode==='innovative_sme')).toMatchObject(business)
 const readback=await (await request('GET',undefined,`?enterpriseIds=${e!.id}`)).json()
 expect(readback.enterprises).toEqual(second.enterprises)
 expect((await assessment())!.titles.find(t=>t.titleCode==='innovative_sme')!.group).not.toBe('eligible')
})

function addHistoricalDuplicateStatus(relationId: number, status: string) {
 const archive = sqlite.prepare(`
  SELECT v.id, v.bytes FROM platform_archive_value v
  JOIN platform_observation_archive_ref r ON r.archive_id=v.id AND r.field='legacyRowSnapshot'
  JOIN platform_legacy_relation_alias a ON a.observation_id=r.owner_id WHERE a.old_id=?
 `).get(relationId) as { id: number; bytes: Buffer }
 const snapshot = JSON.parse(archive.bytes.toString()) as { fields: { name: string; hex: string }[] }
 const raw = snapshot.fields.find(cell => cell.name === 'raw_fields')!
 const original = Buffer.from(raw.hex, 'hex').toString()
 raw.hex = Buffer.from(original.replace(/}$/, ',"cszt":' + JSON.stringify(status) + '}')).toString('hex')
 const bytes = Buffer.from(JSON.stringify(snapshot))
 sqlite.transaction(() => {
  const trigger = sqlite.prepare("SELECT sql FROM sqlite_schema WHERE name='platform_archive_no_update'").pluck().get() as string
  sqlite.exec('DROP TRIGGER platform_archive_no_update')
  sqlite.prepare('UPDATE platform_archive_value SET bytes=?,byte_length=?,sha256=? WHERE id=?')
   .run(bytes, bytes.length, createHash('sha256').update(bytes).digest('hex'), archive.id)
  sqlite.exec(trigger)
 })()
}

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
    body: JSON.stringify({ transportDetails: 'x'.repeat(256 * 1024),
     zrarData: { grid: { businessListGrid: { pageSet: [raw], page: 1, pageSize: 50, maxCount: 1, maxPage: 1 } } } }) }] },
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

async function seedHistoricalStatusArchive() {
 const { submitNativePlatformQuery } = await import('../../platform/fixtures/native-query')
 const name = '历史重复状态'
 const { id: enterpriseId } = db.insert(schema.enterprise).values({ name, nameNorm: name }).returning().get()
 const collection = submitNativePlatformQuery(db, {
  interface: 'business_list', titleCode: 'specialized_sme', rdjb: '2', queryKey: 'name:' + name,
  queriedAt: '2026-05-31T00:00:00Z', status: 'success', rawResponse: '{}',
  relations: [{ enterpriseId, sequenceNo: 1, relationKey: 'historical-status', nameRaw: name,
   sourceText: 'PLATFORM-VERIFY-ACLASS 从 QYMC 转写',
   rawFields: { cszt: '终审通过', CSZT: 'case-sensitive extra field', transportDetails: 'x'.repeat(256 * 1024),
    rdxx: { retained: '\u0000', literal: '\\|u0000|', surrogate: '\ud800' } } }],
 })
 return { enterpriseId, relationId: collection.relationIds[0]! }
}

it('PostgreSQL HTTP and MCP refresh preserve migrated fingerprints and judgments with projected archive reads', async () => {
 const { types } = await import('pg')
 const { installLeadListSchema } = await import('../../../layers/lead-lists/install-schema')
 let migrated: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
 let restoreParser: (() => void) | undefined
 try {
  vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
  await seedComparablePlatformAward()
  const input = { enterpriseIds: [1] }
  const baseline = refreshEnterpriseDifferences(db, input)
  const specialized = (result: typeof baseline) => result.enterprises[0]!.comparisons.find(c => c.titleCode === 'specialized_sme')
  expect(specialized(baseline)).toMatchObject({ comparisonState: 'synchronized', reasons: ['same_event_result_agrees'], comparisonError: null })
  const historical = await seedHistoricalStatusArchive()
  const historicalInput = { enterpriseIds: [historical.enterpriseId] }
  const historicalBaseline = refreshEnterpriseDifferences(db, historicalInput)
  expect(historicalBaseline).toMatchObject({ refreshed: 3, unchanged: 0 })
  addHistoricalDuplicateStatus(historical.relationId, '终审不通过')
  expect(refreshEnterpriseDifferences(db, historicalInput)).toEqual({ ...historicalBaseline, refreshed: 0, unchanged: 3 })
  const [stale] = db.insert(schema.enterprise).values({ name: '待重新核对', nameNorm: '待重新核对' }).returning().all()
  refreshEnterpriseDifferences(db, { enterpriseIds: [stale!.id] })
  sqlite.prepare(`
   UPDATE enterprise_difference_comparison SET business_fingerprint=?
   WHERE enterprise_id=? AND title_code='specialized_sme'
  `).run('0'.repeat(64), stale!.id)
  installLeadListSchema(sqlite)
  const snapshot = join(dir, 'source.sqlite')
  await sqlite.backup(snapshot)
  sqlite.prepare("UPDATE record SET name_raw='变更公布名' WHERE enterprise_id=1").run()
  vi.setSystemTime(new Date('2026-06-03T00:00:00Z'))
  const sqliteChanged = refreshEnterpriseDifferences(db, input)
  expect(specialized(sqliteChanged)).toMatchObject({
   status: 'needs_review', comparisonState: 'not_established', reasons: ['source_requires_revalidation'],
  })
  await closePostgresDirectoryDb()
  migrated = await postgresRuntimeFixture({ dir, sourcePath: snapshot })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', migrated.url)
  const psql = (command: string) => migrated!.psql(['-c', command])
  psql(`INSERT INTO business.difference_reason(enterprise_id,title_code,direction,status,recorded_at,created_at)
   VALUES (1,'specialized_sme','missing_in_miit','confirmed_no_diff','2026-06-01T01:00:00Z','2026-06-01T01:00:00Z')`)
  expect(await installPlatformRefreshV2(usePostgresDirectoryDb())).toEqual({ status: 'already_native', existing: 9 })
  expect(migrated.psql(['-At', '-c', 'SELECT count(state_fingerprint),count(*) FROM business.enterprise_difference_comparison']).trim())
   .toBe('8|9')
  expect(migrated.psql(['-At', '-c', `
   SELECT business_fingerprint,state_fingerprint IS NULL FROM business.enterprise_difference_comparison
   WHERE enterprise_id=${stale!.id} AND title_code='specialized_sme'
  `]).trim()).toBe('0'.repeat(64) + '|t')
  vi.setSystemTime(new Date('2026-06-02T00:00:00Z'))
  let largestFieldBytes = 0
  const originalParser = types.getTypeParser
  const parser = vi.spyOn(types, 'getTypeParser').mockImplementation((oid, format) => {
   const parse = originalParser(oid, format)
   return (value: string) => {
    largestFieldBytes = Math.max(largestFieldBytes, Buffer.byteLength(value))
    return parse(value)
   }
  })
  restoreParser = () => parser.mockRestore()
  const response = await request('POST', input)
  const repeat = await response.json()
  expect(response.status, JSON.stringify(repeat)).toBe(200)
  expect(repeat).toMatchObject({ refreshed: 0, unchanged: 3 })
  type Comparison = typeof baseline.enterprises[number]['comparisons'][number]
  const coordinates = ({ titleCode, businessFingerprint, changedAt }: Comparison) => ({ titleCode, businessFingerprint, changedAt })
  expect(repeat.enterprises[0].comparisons.map(coordinates)).toEqual(baseline.enterprises[0]!.comparisons.map(coordinates))
  expect(specialized(repeat)).toEqual({ ...specialized(baseline), status: 'confirmed_no_diff', refreshedAt: '2026-06-02T00:00:00.000Z' })
  const historicalResponse = await request('POST', historicalInput)
  const historicalRepeat = await historicalResponse.json()
  expect(historicalResponse.status, JSON.stringify(historicalRepeat)).toBe(200)
  expect(historicalRepeat).toEqual({ refreshed: 0, unchanged: 3, enterprises: [{
   enterpriseId: historical.enterpriseId,
   comparisons: historicalBaseline.enterprises[0]!.comparisons.map(row => ({ ...row, refreshedAt: '2026-06-02T00:00:00.000Z' })),
  }] })
  const readFingerprints = () => usePostgresDirectoryDb().transaction(tx =>
   readPostgresRefreshFingerprints(tx, [1, historical.enterpriseId]), { isolationLevel: 'repeatable read', accessMode: 'read only' })
  expect(await readFingerprints()).toHaveLength(2)
  const expectedBytes = Number(migrated.psql(['-At', '-c', `
   SELECT SUM(a.byte_length)
   FROM fixture_business.platform_legacy_relation_alias l
   JOIN fixture_business.platform_business_observation o ON o.id=l.observation_id
   JOIN fixture_business.platform_archive_value a ON a.id IN (
    SELECT archive_id FROM fixture_business.platform_collection_archive_ref WHERE owner_id=o.collection_id AND field IN ('rawResponse','collectionEvidence')
    UNION ALL SELECT archive_id FROM fixture_business.platform_observation_archive_ref WHERE owner_id=o.id AND field='rawFields'
   )
   WHERE l.old_id=${historical.relationId}
  `]).trim())
  expect(expectedBytes).toBeGreaterThan(256 * 1024)
  expect(migrated.psql(['-At', '-c', `SELECT identity_only_source FROM business.platform_business_observation o
   WHERE o.public_id=${historical.relationId}
  `]).trim()).toBe('t')
  expect(migrated.psql(['-At', '-c', "SELECT to_regclass('business.platform_archive_value') IS NULL"]).trim()).toBe('t')
  expect(await readPostgresCandidateSourceBytes(usePostgresDirectoryDb(), historical.relationId)).toBe(expectedBytes)
  psql("UPDATE business.record SET name_raw='变更公布名' WHERE enterprise_id=1 AND title_code='specialized_sme'")
  vi.setSystemTime(new Date('2026-06-03T00:00:00Z'))
  const [toolResult, competing] = await Promise.all([
   refreshTool.handler(input, {} as never) as Promise<{content:{text:string}[]}>,
   request('POST', input),
  ])
  expect(competing.status).toBe(200)
  const receipts = [JSON.parse(toolResult.content[0]!.text), await competing.json()].sort((a, b) => b.refreshed - a.refreshed)
  const nativeDigest = (await readFingerprints())[0]!.fingerprints.get('specialized_sme')
  expect(nativeDigest).not.toBe(specialized(sqliteChanged)!.businessFingerprint)
  const expectedChanged = { ...sqliteChanged, enterprises: sqliteChanged.enterprises.map(enterprise => ({
   ...enterprise, comparisons: enterprise.comparisons.map(comparison => comparison.titleCode === 'specialized_sme'
    ? { ...comparison, businessFingerprint: nativeDigest } : comparison),
  })) }
  expect(receipts[0]).toEqual(expectedChanged)
  expect(receipts[1]).toEqual({ ...expectedChanged, refreshed: 0, unchanged: 3 })
  const readback = await (await request('GET', undefined, '?enterpriseIds=1')).json()
  expect(readback.enterprises).toEqual(expectedChanged.enterprises)
  psql("UPDATE business.record SET name_raw='传输合成' WHERE enterprise_id=1 AND title_code='specialized_sme'")
  vi.setSystemTime(new Date('2026-06-04T00:00:00Z'))
  const restored = await (await request('POST', input)).json()
  expect(restored).toMatchObject({ refreshed: 1, unchanged: 2 })
  expect(specialized(restored)).toEqual({ ...specialized(baseline),
   businessFingerprint: (await readFingerprints())[0]!.fingerprints.get('specialized_sme'),
   changedAt: '2026-06-04T00:00:00.000Z', refreshedAt: '2026-06-04T00:00:00.000Z' })
  const revalidated = await (await request('POST', { enterpriseIds: [stale!.id] })).json()
  expect(revalidated).toMatchObject({ refreshed: 1, unchanged: 2 })

  for (const invalid of [{ enterpriseIds: [1, 1] }, { enterpriseIds: [1, 9001] }]) {
   expect((await request('POST', invalid)).status).toBe(400)
   await expect(refreshTool.handler(invalid, {} as never)).rejects.toMatchObject({ statusCode: 400 })
  }
  vi.stubEnv('NUXT_DB_READONLY', '1')
  expect((await request('POST', input)).status).toBe(503)
  await expect(refreshTool.handler(input, {} as never)).rejects.toMatchObject({ statusCode: 503 })
  expect((await (await request('GET', undefined, '?enterpriseIds=1')).json()).enterprises).toEqual(restored.enterprises)
  expect(largestFieldBytes).toBeGreaterThan(0)
  expect(largestFieldBytes).toBeLessThan(16 * 1024)
 } finally {
  restoreParser?.()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await closePostgresDirectoryDb()
  migrated?.close()
 }
}, 60_000)
