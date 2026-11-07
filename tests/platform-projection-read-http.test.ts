import { it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createApp, createRouter, toNodeListener, defineEventHandler, setHeader, getQuery, getRouterParam, createError } from 'h3'
import { initializeDb } from '../db/client'
import { schema } from '../db'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { sql } from 'drizzle-orm'
it('three public queries distinguish exact-version missing projections, empty source and literal values', async () => {
 const dir=mkdtempSync(join(tmpdir(),'projection-read-'))
 const dbPath=join(dir,'test.sqlite')
 vi.stubEnv('NUXT_DB_PATH',dbPath)
 const db=initializeDb({create:true,dbPath})
 const enterprise=db.insert(schema.enterprise).values({name:'隔离样本企业',nameNorm:'隔离样本企业'}).returning().get()
 for(const source of ['apply_list','business_list','recognized_list'] as const) {
 for(const mode of ['missing','empty','normal']) {
 const query=db.insert(schema.platformQuery).values({interface:source,queryKey:`${source}-${mode}`,queriedAt:'2026-11-01T00:00:00Z',status:'success'}).returning().get()
 const raw={id:`${source}-${mode}`, ...(mode==='normal'?{qymc:'正常原名',rdjb:'2',sblx:'apply',year:2024,cszt:'unknown-status',rddqrq:'原值日期',whpc:'0'}:{})}
 const rel=db.insert(schema.platformRelation).values({queryId:query.id,sequenceNo:1,relationKey:raw.id,enterpriseId:enterprise.id,rawFields:raw}).returning().get()
 const observation=ensurePlatformObservation(db,rel.id)
 if(mode==='missing') {
 const table=source==='apply_list'?'platform_apply_projection':source==='business_list'?'platform_business_projection':'platform_recognized_projection'
 db.run(sql.raw(`delete from ${table} where version_id=${observation.versionId}`))
 }
 }
 }
 for (const [key,value] of Object.entries({defineEventHandler,setHeader,getQuery,getRouterParam,createError})) vi.stubGlobal(key,value)
 const router=createRouter()
 for(const source of ['declarations','business-processes','recognized-directory']) {
  const list=(await import(`../server/api/platform/${source}.get.ts`)).default
  const detail=(await import(`../server/api/platform/${source}/[recordId].get.ts`)).default
  router.get(`/api/platform/${source}`,list).get(`/api/platform/${source}/:recordId`,detail)
 }
 const server=createServer(toNodeListener(createApp().use(router)))
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const base=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
 try {
 for(const source of ['declarations','business-processes','recognized-directory']) {
  const response=await fetch(`${base}/api/platform/${source}`)
  expect(response.status).toBe(200)
  const data=await response.json()
  expect(data.total).toBe(3)
  const missing=data.rows.find((r:any)=>r.record.platformKey.endsWith('-missing'))
  const empty=data.rows.find((r:any)=>r.record.platformKey.endsWith('-empty'))
  expect(missing.enterpriseNames).toEqual(['隔离样本企业'])
  expect(missing.matchedVersion.ruleVersion).toBeNull()
  expect(empty.matchedVersion.ruleVersion).toBeTruthy()
  expect(empty.matchedVersion.titleRaw).toBeNull()
  const detail=await (await fetch(`${base}/api/platform/${source}/${missing.record.id}`)).json()
  expect(detail.versions).toHaveLength(1)
  expect(detail.versions[0].ruleVersion).toBeNull()
 }
 } finally {
 await new Promise<void>(resolve=>server.close(()=>resolve()))
 db.$client.close();vi.unstubAllEnvs();vi.unstubAllGlobals();rmSync(dir,{recursive:true,force:true})
 }
})
