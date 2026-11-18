import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { beforeAll, afterEach, expect, it } from 'vitest'
import { preRetirementFixture } from '../runtime-boundary/fixtures/pre-retirement'
import { retirePlatformModel } from '../../../upgrade/retire-platform-model'
import { targetSchema as schema } from '../../../layers/sme-roster/lib/platform/target-schema'
import { writeCollectionTarget } from '../../../layers/sme-roster/lib/platform/collection-target-command'
import { reuseCollectedPlatformResult } from '../../../layers/sme-roster/server/utils/platform-collection-reuse'
import { platformResultToImport } from '../../../layers/sme-roster/lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult } from '../../../layers/sme-roster/lib/platform/live-query'
import type { PlatformRawRow } from '../../../layers/sme-roster/lib/platform/adapter'
const time='2026-11-15T00:00:00Z',later='2026-11-15T01:00:00Z'
const sources=['queryList','businessList','queryBusList'] as const
const connections: Database.Database[]=[]
afterEach(()=>{for(const t of connections.splice(0))if(t.open)t.close()})
beforeAll(()=>{const f=preRetirementFixture();const t=new Database(f.target);try{t.pragma('foreign_keys=ON');retirePlatformModel(t)}finally{t.close()}},120000)
function fixture() {
 const f=preRetirementFixture(),t=new Database(f.target);connections.push(t);t.pragma('foreign_keys=ON');retirePlatformModel(t)
 t.exec("INSERT INTO enterprise(id,name,name_norm,uscc_norm) VALUES(3,'Reuse','Reuse','91330200712345678A')")
 return {t,db:drizzle(t,{schema})}
}
function write(db:ReturnType<typeof drizzle<typeof schema>>,e:PlatformLiveQueryResult) {
 const q=platformResultToImport(e)
 return writeCollectionTarget(db,{queryText:JSON.stringify(q),evidenceText:JSON.stringify(e),createdAt:'original',assignments:(q.relations??[]).map(row=>({enterpriseId:3,nameRaw:row.nameRaw??null,usccRaw:row.usccRaw??null,matchBasis:'uscc' as const,verificationStatus:'pending' as const,origin:'command' as const,actor:{type:'agent' as const,id:'test'},basis:'explicit'}))})
}
function collection(source: PlatformLiveQueryResult['source'] = 'businessList', rows?: PlatformRawRow[]): PlatformLiveQueryResult {
  const raw = rows ?? ['REUSE-A', 'REUSE-B'].map(id => ({ id, rdjb: '2', qymc: 'Reuse', tyshxydm: '91330200712345678A', sblx: '申请',
    cszt: '终审通过', year: '2024', extra: { null: null, list: [false, 17, '尾😀'] }, empty: null }))
  return { source, status: raw.length ? 'success' : 'no_record', effectiveConditions: { uscc: '91330200712345678A', combination: 'and' },
    titleScope: source === 'queryList' ? { mode: 'source_default', rdjb: [] } : { mode: 'selected', rdjb: ['2'] },
    queriedAt: time, completedAt: time,
    rows: raw.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)]))),
    dataRows: raw, pages: [{ source, rdjb: source === 'queryList' ? null : '2', page: 1, maxPage: 1, fetchedCount: raw.length, declaredTotal: raw.length, status: 'success', error: null }],
    fetchedCount: raw.length, declaredTotal: raw.length, completeness: 'complete', fullRange: true, unfinished: [], error: null,
    limits: { maxRequests: 10, maxRows: 100, maxDurationMs: 1000, pageSize: 50 } }
}

it.each(sources)('reuses complete %s after retirement with original IDs bytes and reordered rows',source=>{
 const {t,db}=fixture(),e=collection(source),written=write(db,e)
 const immutable=()=>['platform_business_observation','platform_archive_value','platform_observation_assignment','platform_legacy_relation_alias'].map(table=>t.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
 const before=immutable()
 expect(reuseCollectedPlatformResult(db,{...e,queriedAt:later,completedAt:later,dataRows:e.dataRows!.toReversed(),rows:e.rows.toReversed()},3)).toBe(true)
 expect(immutable()).toEqual(before)
 expect(t.prepare('SELECT queried_at,last_collected_at FROM platform_collection WHERE id=?').get(written.collectionId)).toEqual({queried_at:time,last_collected_at:later})
 expect(reuseCollectedPlatformResult(db,collection(source,[{...e.dataRows![0]!,empty:false},e.dataRows![1]!]),3)).toBe(false)
 expect(immutable()).toEqual(before)
 expect(t.pragma('foreign_key_check')).toEqual([])
})
it.each(sources)('reuses complete empty %s after retirement without manufacturing observations',source=>{
 const {t,db}=fixture(),e=collection(source,[]),written=write(db,e)
 expect(reuseCollectedPlatformResult(db,{...e,queriedAt:later,completedAt:later},3)).toBe(true)
 expect(t.prepare('SELECT count(*) n FROM platform_business_observation WHERE collection_id=?').get(written.collectionId)).toEqual({n:0})
})
it.each(sources)('latest partial %s blocks reuse of an older complete collection after retirement',source=>{
 const {t,db}=fixture(),e=collection(source);write(db,e)
 const partial=collection(source,[e.dataRows![0]!]);partial.queriedAt=later;partial.completedAt=later;partial.status='partial';partial.completeness='partial';partial.limits.pageSize=1;partial.declaredTotal=2;partial.pages[0]!.declaredTotal=2;partial.pages[0]!.maxPage=2;partial.unfinished=[{source,rdjb:source==='queryList'?null:'2',page:2}];partial.error={code:'safety_limit',message:'stopped'}
 write(db,partial)
 const before=t.serialize()
 expect(reuseCollectedPlatformResult(db,{...e,queriedAt:'2026-11-15T02:00:00Z',completedAt:'2026-11-15T02:01:00Z'},3)).toBe(false)
 expect(t.serialize().equals(before)).toBe(true)
})
it('caller rollback restores reuse recency and permits retry on the retired target',()=>{
 const {t,db}=fixture(),e=collection();const result=write(db,e)
 expect(()=>db.transaction(tx=>{expect(reuseCollectedPlatformResult(tx,{...e,queriedAt:later,completedAt:later},3)).toBe(true);throw new Error('caller failure')})).toThrow('caller failure')
 expect(t.prepare('SELECT last_collected_at value FROM platform_collection WHERE id=?').get(result.collectionId)).toEqual({value:null})
 expect(reuseCollectedPlatformResult(db,{...e,queriedAt:later,completedAt:later},3)).toBe(true)
})
it.each(sources)('reuse %s follows current assignment revisions without rewriting original ownership',source=>{
 const {t,db}=fixture(),e=collection(source),written=write(db,e)
 const observation=written.observations[0]!.observationId
 for(const [revision,owner] of [[2,1],[3,3]]) {
  t.prepare("INSERT INTO platform_observation_assignment(observation_id,revision,enterprise_id,match_basis,verification_status,origin,basis) VALUES(?,?,?,'manual','pending','command','correction')").run(observation,revision,owner)
  expect(reuseCollectedPlatformResult(db,{...e,queriedAt:later,completedAt:later},3)).toBe(owner===3)
 }
 expect(t.prepare('SELECT enterprise_id FROM platform_observation_assignment WHERE observation_id=? AND revision=1').get(observation)).toEqual({enterprise_id:3})
})
it.each(sources)('latest changed %s content blocks reuse of an older complete collection',source=>{
 const {t,db}=fixture(),e=collection(source);write(db,e)
 const changed=collection(source,[{...e.dataRows![0]!,year:'2025'},e.dataRows![1]!]);changed.queriedAt=later;changed.completedAt=later;write(db,changed)
 const before=t.serialize()
 expect(reuseCollectedPlatformResult(db,{...e,queriedAt:'2026-11-15T02:00:00Z',completedAt:'2026-11-15T02:01:00Z'},3)).toBe(false)
 expect(t.serialize().equals(before)).toBe(true)
})
it('reuse keeps exact query conditions and title scopes separate',()=>{
 const {db}=fixture(),e=collection();write(db,e)
 expect(reuseCollectedPlatformResult(db,{...e,effectiveConditions:{...e.effectiveConditions,uscc:'91330200712345678B'}},3)).toBe(false)
 expect(reuseCollectedPlatformResult(db,{...e,titleScope:{mode:'selected',rdjb:['3']},pages:[{...e.pages[0]!,rdjb:'3'}]},3)).toBe(false)
})
