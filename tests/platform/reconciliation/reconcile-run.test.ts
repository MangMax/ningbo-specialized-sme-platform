import {afterEach,expect,it} from 'vitest'
import * as schema from '../../../db/schema'
import {runPlatformReconcile} from '../../../layers/sme-roster/server/utils/platform-reconcile-sqlite'
import { runPostgresPlatformReconcile } from '../../../layers/sme-roster/server/utils/platform-reconcile-postgres'
import { pg19Bin, withHistoricalImportDatabase } from '../../roster/imports/fixtures/postgres-historical-import'
import {preflightRosterImport,commitRosterImport} from '../../../layers/sme-roster/server/utils/roster-import'
import {nativeImportDb} from '../../roster/imports/fixtures/native-import'
import {platformReplay,emptyReply,platformFixture} from '../fixtures/source-replay'
const handles:ReturnType<typeof nativeImportDb>[]=[]
afterEach(()=>{for(const db of handles.splice(0))db.$client.close()})
function fixture(){
 const db=nativeImportDb();handles.push(db)
 const e=db.insert(schema.enterprise).values({name:'Native reconcile',nameNorm:'native reconcile',usccNorm:'91330211255994457P'}).returning().get()
 db.insert(schema.record).values({enterpriseId:e.id,source:'miit',titleCode:'specialized_sme'}).run()
 const replay=platformReplay(emptyReply)
 const options={db,titles:['specialized_sme'],cookie:'synthetic-cookie',fetchImpl:replay.fetchImpl,now:()=>new Date('2026-06-01T00:00:00Z'),writer:{async preflight(request:Parameters<typeof preflightRosterImport>[1]){return preflightRosterImport(db,request)},async commit(request:Parameters<typeof commitRosterImport>[1]){return commitRosterImport(db,request,[],{deferCandidateTasks:true})}}}
 return {db,replay,options}
}
it('collects all four source slots without writes during preview',async()=>{
 const {db,options}=fixture(),before=db.$client.serialize(),progress:number[][]=[]
 const result=await runPlatformReconcile({...options,write:false,onProgress:(done,total)=>{progress.push([done,total])}})
 expect(result).toMatchObject({usccCount:1,queries:{network:4,reused:0},relations:0})
 expect(progress[0]).toEqual([0,1]);expect(progress.at(-1)).toEqual([1,1]);expect(db.$client.serialize().equals(before)).toBe(true)
})
it('commits native source evidence atomically and reuses fresh complete slots without a credential',async()=>{
 const {db,options,replay}=fixture(),first=await runPlatformReconcile(options)
 expect(first.write?.status).toBe('committed');expect(db.select().from(schema.platformCollection).all()).toHaveLength(4)
 expect(db.select().from(schema.platformBusinessObservation).all()).toEqual([])
 const archives=db.select().from(schema.platformArchiveValue).all(),calls=replay.calls.length
 const again=await runPlatformReconcile({...options,cookie:null})
 expect(again.queries).toMatchObject({network:0,reused:4});expect(replay.calls).toHaveLength(calls)
 expect(db.select().from(schema.platformArchiveValue).all()).toEqual(archives)
})
it('archives expired-session failures distinctly from complete empty queries',async()=>{
 const {db,options}=fixture(),replay=platformReplay(()=>({text:'{"statusCode":"301","message":"session expired"}'}))
 const result=await runPlatformReconcile({...options,fetchImpl:replay.fetchImpl,retries:0})
 expect(result.write?.status).toBe('committed')
 expect(db.select().from(schema.platformCollection).all().map(row=>row.status)).toEqual(['failed','failed','failed','failed'])
 expect(db.select().from(schema.platformBusinessObservation).all()).toEqual([])
})
it('cancels before transmission without manufacturing evidence',async()=>{
 const {db,options}=fixture(),result=await runPlatformReconcile({...options,shouldCancel:()=>true})
 expect(result.cancelled).toBe(true);expect(result.queries.network).toBe(0)
 expect(db.select().from(schema.platformCollection).all()).toEqual([])
})

it.skipIf(!pg19Bin)('collects fresh PostgreSQL slots even when prior slots are complete', async () => {
  await withHistoricalImportDatabase(`
    INSERT INTO enterprise(id,name,name_norm,uscc_norm)
      VALUES (1,'宁波上航测绘股份有限公司','宁波上航测绘股份有限公司','91330211255994457P');
    INSERT INTO record(enterprise_id,source,title_code) VALUES (1,'miit','specialized_sme');
  `, async (pool, db) => {
    const replay = platformReplay(call => call.interface === 'apply_list'
      ? { text: platformFixture('apply-list.json') } : emptyReply(call))
    const options = { titles: ['specialized_sme'], now: () => new Date('2026-06-01T00:00:00Z') }
    const first = await runPostgresPlatformReconcile(db, { ...options, fetchImpl: replay.fetchImpl, cookie: 'fixture' })
    expect(first).toMatchObject({ usccCount: 1, queries: { network: 4, reused: 0 }, relations: 2, write: { status: 'committed' } })
    const archived = await pool.query("SELECT interface,status FROM platform_collection ORDER BY interface,rdjb")
    expect(archived.rows).toEqual([
      { interface: 'apply_list', status: 'success' },
      ...Array.from({ length: 3 }, () => ({ interface: 'business_list', status: 'no_record' })),
    ])
    const nextTime = () => new Date('2026-06-01T01:00:00Z')
    const again = await runPostgresPlatformReconcile(db, { ...options, now: nextTime, fetchImpl: replay.fetchImpl, cookie: 'fixture' })
    expect(again).toMatchObject({ usccCount: 1, queries: { network: 4, reused: 0 }, relations: 2, write: { status: 'committed' } })
    expect(replay.calls).toHaveLength(8)
    expect((await pool.query('SELECT DISTINCT queried_at FROM platform_collection ORDER BY queried_at')).rows).toEqual([
      { queried_at: '2026-06-01T00:00:00.000Z' }, { queried_at: '2026-06-01T01:00:00.000Z' },
    ])
  })
}, 90_000)
