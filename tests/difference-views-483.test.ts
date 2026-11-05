import { expect, it } from 'vitest'
import { pageSnapshotQueue } from '../server/utils/difference-queue'
it('shows terminal results and reason filtering before counts and pagination',()=>{
 const queue={unfinished:[9],rows:[
 {enterpriseId:1,titleCode:'innovative_sme',direction:'missing_in_miit' as const,status:'not_queried',reasonCode:null},
 {enterpriseId:2,titleCode:'innovative_sme',direction:'missing_in_miit' as const,status:'confirmed_no_diff',reasonCode:null},
 {enterpriseId:3,titleCode:'innovative_sme',direction:'missing_in_miit' as const,status:'confirmed_reason',reasonCode:'moved_out'},
 {enterpriseId:4,titleCode:'innovative_sme',direction:'missing_in_miit' as const,status:'confirmed_reason',reasonCode:'renamed'}]}
 expect(pageSnapshotQueue(queue,1,1,{view:'judged'})).toMatchObject({total:3,rows:[{enterpriseId:2}],unfinished:[9]})
 expect(pageSnapshotQueue(queue,2,1,{view:'judged'})).toMatchObject({total:3,rows:[{enterpriseId:3}]})
 expect(pageSnapshotQueue(queue,1,1,{view:'judged',reasonCode:'renamed'})).toMatchObject({total:1,rows:[{enterpriseId:4}]})
 expect(pageSnapshotQueue(queue,1,1,{view:'judged',status:'confirmed_no_diff'})).toMatchObject({total:1,rows:[{enterpriseId:2}]})
 expect(pageSnapshotQueue(queue,1,20)).toMatchObject({total:1,rows:[{enterpriseId:1}]})
})

import {vi,afterAll} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {createApp,toNodeListener,defineEventHandler,getQuery,setHeader} from 'h3'
import {initializeDb} from '../db/client'
import {createJob,finishJob} from '../server/utils/job-store'
const dir=mkdtempSync(join(tmpdir(),'views483-')),db=initializeDb({create:true,dbPath:join(dir,'fixture.db')})
vi.mock('../db',()=>({useDb:()=>db}))
vi.mock('@nuxtjs/mcp-toolkit/server',()=>({defineMcpTool:(v:unknown)=>v}))
afterAll(()=>{db.$client.close();rmSync(dir,{recursive:true,force:true});vi.unstubAllGlobals()})
it('public HTTP and MCP filter current terminal overlay before paging and reject invalid statuses',async()=>{
 const id='01M5BEPVCXD5619ZW4C6CAT483'
 createJob(db,{id,kind:'difference-snapshot',params:{},progress:{done:1,total:1}})
 finishJob(db,id,{state:'done',result:{queue:{unfinished:[99],rows:[1,2,3].map(enterpriseId=>({enterpriseId,titleCode:'innovative_sme',direction:'missing_in_miit',status:'not_queried',reasonCode:null}))}}})
 for(const [enterpriseId,status,reasonCode] of [[1,'confirmed_no_diff',null],[2,'confirmed_reason','renamed']] as const) db.$client.prepare('insert into snapshot_judgment values(?,?,?,?,?)').run(id,enterpriseId,'innovative_sme','missing_in_miit',JSON.stringify({status,reasonCode}))
 vi.stubGlobal('defineEventHandler',defineEventHandler);vi.stubGlobal('getQuery',getQuery);vi.stubGlobal('setHeader',setHeader);vi.stubGlobal('getRouterParam',()=>id);vi.stubGlobal('useRuntimeConfig',()=>({apiToken:'fixture'}))
 const handler=(await import('../server/api/task-center/[id]/difference-queue.get')).default
 const tool=(await import('../server/mcp/tools/list_snapshot_difference_queue')).default as unknown as {handler:(v:unknown)=>Promise<{content:{text:string}[]}>}
 const detail=(await import('../server/api/task-center/[id]/difference-detail.get')).default
 const server=createServer(toNodeListener(createApp().use('/queue',handler).use('/detail',detail)));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
 try {
 const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/queue`
 expect((await fetch(url)).status).toBe(401)
 const detailUrl=url.replace('/queue','/detail')+'?enterpriseId=1&titleCode=innovative_sme&direction=missing_in_miit'
 expect((await fetch(detailUrl)).status).toBe(401)
 const read=await fetch(detailUrl,{headers:{authorization:'Bearer fixture'}});expect(read.status).toBe(200);expect(await read.json()).toMatchObject({enterpriseId:1,current:{status:'confirmed_no_diff'},operations:[],platformHistory:[],officialSources:[]})
 for(const [query,expected] of [['',{total:1,rows:[{enterpriseId:3}]}],['view=judged&pageSize=1&page=2',{total:2,rows:[{enterpriseId:2}]}],['view=judged&status=confirmed_no_diff',{total:1,rows:[{enterpriseId:1,status:'confirmed_no_diff'}]}],['view=judged&reasonCode=renamed',{total:1,rows:[{enterpriseId:2,reasonCode:'renamed'}]}]] as const){
 const response=await fetch(`${url}?${query}`,{headers:{authorization:'Bearer fixture'}});expect(response.status).toBe(200)
 const actual=await response.json();expect(actual).toMatchObject({...expected,unfinished:[99]})
 expect(JSON.parse((await tool.handler({jobId:id,...Object.fromEntries(new URLSearchParams(query))})).content[0]!.text)).toEqual(actual)
 }
 expect((await fetch(`${url}?status=withdrawn`,{headers:{authorization:'Bearer fixture'}})).status).toBe(400)
 }finally{await new Promise<void>(r=>server.close(()=>r()))}
})
