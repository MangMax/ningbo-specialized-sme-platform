import { it, expect } from 'vitest'
import { runPostgresMixedImport } from '../../../layers/sme-roster/server/utils/roster-mixed-import-postgres'
import { reusePostgresCollectedPlatformResult } from '../../../layers/sme-roster/server/utils/platform-collection-reuse'
import { platformResultToImport } from '../../../layers/sme-roster/lib/platform/recognized-evidence'
import { snapshotInput } from '../../../layers/sme-roster/server/utils/difference-snapshot'
import type { PlatformLiveQueryResult } from '../../../layers/sme-roster/lib/platform/live-query'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'

const openCase = useIsolatedPostgresCases()
function evidence(source: PlatformLiveQueryResult['source'], revision=0): PlatformLiveQueryResult {
 const raw={id:'original-1',qymc:'fixture',tyshxydm:'91330201753252106U',sblx:'1',year:2026,whpcyear:2026,whpc:revision?'补全':null,unknown:{nested:[null,17,false]},empty:null}
 const rows=[Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,v===null?'':typeof v==='object'?JSON.stringify(v):String(v)]))]
 return {source,status:'success',effectiveConditions:{uscc:raw.tyshxydm,combination:'and'},titleScope:{mode:source==='queryList'?'source_default':'selected',rdjb:source==='queryList'?[]:['1']},queriedAt:`2026-11-06T00:00:0${revision}Z`,completedAt:`2026-11-06T00:00:0${revision+1}Z`,rows,dataRows:[raw],pages:[{source,rdjb:source==='queryList'?null:'1',page:1,status:'success',fetchedCount:1,declaredTotal:1,error:null}],fetchedCount:1,declaredTotal:1,completeness:'complete',fullRange:true,unfinished:[],error:null,limits:{maxRequests:100,maxRows:5000,maxDurationMs:60000,pageSize:50}} as PlatformLiveQueryResult
}
it('validates exact selected enterprise IDs and rejects empty or excessive scopes',()=>{
 expect(snapshotInput.safeParse({action:'create',clientRequestId:'x',enterpriseIds:[1,1,2]}).success).toBe(true)
 for(const enterpriseIds of [[],[0],[-1],[1.5],Array.from({length:201},(_,i)=>i+1)])expect(snapshotInput.safeParse({action:'create',clientRequestId:'x',enterpriseIds}).success).toBe(false)
})
it('rejects typed row count and projection mismatches without relaxing raw response validation',()=>{
 const count=evidence('queryList');count.dataRows=[]
 expect(()=>platformResultToImport(count)).toThrow('cover every accepted row')
 const projection=evidence('queryList');projection.rows[0]!.year='1999'
 expect(()=>platformResultToImport(projection)).toThrow('match their string projection')
 const both=evidence('queryList');both.rawData={version:1,rows:both.dataRows!,pages:[]}
 expect(()=>platformResultToImport(both)).toThrow('never both')
})


it('archives changed typed rows once per version for each source and replays the same import receipt', async () => {
 const db = openCase()
 for (const source of ['queryList', 'businessList', 'queryBusList'] as const) {
  for (const revision of [0, 1, 2]) {
   const result = evidence(source, revision === 2 ? 1 : revision)
   if (revision === 2) {
    result.queriedAt = '2026-11-06T00:00:03Z'
    result.completedAt = '2026-11-06T00:00:04Z'
   }
   const request = { idempotencyKey: `collection:${source}:${revision}`, sourceKind: 'platform_archive' as const,
    sourceIdentity: 'synthetic-collection', payload: { platformQueries: [platformResultToImport(result)] } }
   expect(await runPostgresMixedImport('preflight', request)).toMatchObject({ status: 'preflight' })
   const receipt = await runPostgresMixedImport('commit', request)
   expect(receipt).toMatchObject({ status: 'committed' })
   expect(await runPostgresMixedImport('commit', request)).toEqual(receipt)
  }
 }
 const { rows } = await db.$client.query(`
   SELECT c.interface, count(*)::int AS observations, count(DISTINCT o.record_id)::int AS records,
          count(DISTINCT o.version_id)::int AS versions
   FROM platform_collection c JOIN platform_business_observation o ON o.collection_id=c.id
   GROUP BY c.interface ORDER BY c.interface
 `)
 expect(rows).toEqual(['apply_list', 'business_list', 'recognized_list'].map(interfaceName => ({
  interface: interfaceName, observations: 3, records: 1, versions: 2,
 })))
 const content = await db.$client.query('SELECT business_fields FROM platform_business_record_version ORDER BY id')
 expect(content.rows).toHaveLength(6)
 for (const row of content.rows) {
  expect(row.business_fields).toMatchObject({ id: 'original-1', qymc: 'fixture', tyshxydm: '91330201753252106U', year: 2026 })
  expect(row.business_fields).not.toHaveProperty('rawData')
  expect(row.business_fields).not.toHaveProperty('unknown')
  expect(row.business_fields).not.toHaveProperty('empty')
 }
})

it('advances collection recency for complete matching content and refuses changed scope or content', async () => {
 const db = openCase()
 const { rows: [owner] } = await db.$client.query<{id: string}>(`
  INSERT INTO enterprise(name,name_norm,uscc_norm) VALUES ('fixture','fixture','91330201753252106U') RETURNING id
 `)
 const enterpriseId = Number(owner!.id)
 const first = evidence('queryBusList')
 const reuse = (input: PlatformLiveQueryResult, ownerId = enterpriseId) =>
  db.transaction(tx => reusePostgresCollectedPlatformResult(tx, input, ownerId))
 expect(await reuse(first)).toBe(false)
 const query = platformResultToImport(first)
 for (const relation of query.relations ?? []) relation.enterpriseId = enterpriseId
 const request = { idempotencyKey: 'reuse-recognized', sourceKind: 'platform_archive' as const, sourceIdentity: 'synthetic-reuse',
  payload: { platformQueries: [query] } }
 expect(await runPostgresMixedImport('commit', request)).toMatchObject({ status: 'committed' })
 const repeated = { ...first, queriedAt: '2026-11-06T00:00:10Z', completedAt: '2026-11-06T00:00:11Z' }
 expect(await reuse(repeated)).toBe(true)
 expect(await reuse(first)).toBe(true)
 expect(await reuse(evidence('queryBusList', 1))).toBe(false)
 expect(await reuse({ ...repeated, completeness: 'partial', fullRange: false })).toBe(false)
 expect(await reuse(repeated, enterpriseId + 1)).toBe(false)
 expect((await db.$client.query(`
  SELECT c.queried_at, c.last_collected_at, count(o.id)::int AS observations
  FROM platform_collection c JOIN platform_business_observation o ON o.collection_id=c.id
  GROUP BY c.id
 `)).rows).toEqual([{ queried_at: first.queriedAt, last_collected_at: repeated.queriedAt, observations: 1 }])
})
