import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as schema from '../fixtures/postgres-tables'
import { allPostgresRosterEnterprises, listPostgresRosterEnterprises } from '../../../layers/sme-roster/lib/roster/enterprise-list-postgres'
import { parseRosterEnterpriseQuery } from '../../../layers/sme-roster/server/utils/roster-read-query'

const directory=mkdtempSync(join(tmpdir(),'rl20-reason-filter-'))
let db: ReturnType<typeof usePostgresDirectoryDb>
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
const ids: Record<string,number>={}
async function company(key:string) {
  const name=`宁波${key}企业`
  ids[key]=(await db.insert(schema.enterprise).values({name,nameNorm:name}).returning({id:schema.enterprise.id}))[0]!.id
  await db.insert(schema.rosterLegacyMember).values({ enterpriseId: ids[key]! })
  return ids[key]!
}
async function reason(enterpriseId:number,titleCode:'specialized_sme'|'little_giant',reasonCode:'other'|'platform_stale'|'pending_review') {
  const record=(await db.insert(schema.record).values({enterpriseId,titleCode,source:'miit'}).returning({id:schema.record.id}))[0]!
  await db.insert(schema.recordEvent).values({recordId:record.id,eventType:'maintain',year:2025})
  await db.insert(schema.differenceReason).values({enterpriseId,titleCode,direction:'extra_in_miit',status:'confirmed_reason',reasonCode,verificationStatus:'confirmed',recordedAt:'2026-10-17',createdAt:'2026-10-17'})
}
beforeAll(async () => {
  postgres = await postgresRuntimeFixture({ dir: directory })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  db = usePostgresDirectoryDb()
  vi.stubGlobal('createError',(options:{statusMessage?:string;statusCode?:number})=>Object.assign(new Error(options.statusMessage),options))
  await reason((await company('其他')),'specialized_sme','other')
  await reason((await company('未更新')),'specialized_sme','platform_stale')
  const hidden=await company('隐藏其他')
  await reason(hidden,'specialized_sme','other')
  await reason(hidden,'little_giant','platform_stale')
  await reason((await company('待审核')),'specialized_sme','pending_review')
  await company('无差异')
}, 60_000)
afterAll(async () => {
  await closePostgresDirectoryDb()
  postgres?.close()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

describe('企业列表差异原因筛选',()=>{
  it('待审核可按独立原因筛选，解析器接受',async ()=>{
    const query=parseRosterEnterpriseQuery({diffStatus:'pending_review'})
    expect(query.diffStatus).toEqual(['pending_review'])
    expect((await listPostgresRosterEnterprises(db,query)).rows.map(row=>row.enterpriseId)).toEqual([ids['待审核']])
  })
  it('其他按当前可见摘要筛选，隐藏的低优先原因不误入',async ()=>{
    const result=await listPostgresRosterEnterprises(db,{diffStatus:['other']})
    expect(result.rows.map(row=>row.enterpriseId)).toEqual([ids['其他']])
    expect(result.rows.every(row=>row.difference.reasonCode==='other')).toBe(true)
    expect(result.counts.total).toBe(1)
  })
  it('原因和无差异多选取或，分页计数和全量导出使用同一集合',async ()=>{
    const filter={diffStatus:['other','none'],sort:'name' as const}
    const all=await allPostgresRosterEnterprises(db,filter)
    expect(new Set(all.rows.map(row=>row.enterpriseId))).toEqual(new Set([ids['其他'],ids['无差异']]))
    const first=await listPostgresRosterEnterprises(db,{...filter,page:1,pageSize:1})
    const second=await listPostgresRosterEnterprises(db,{...filter,page:2,pageSize:1})
    expect([...first.rows,...second.rows].map(row=>row.enterpriseId)).toEqual(all.rows.map(row=>row.enterpriseId))
    expect(first.counts).toEqual(all.counts)
    expect(second.counts).toEqual(all.counts)
    expect(first.counts.total).toBe(2)
  })
  it('新增原因值被共同解析器接受，未知值仍返回400',()=>{
    expect(parseRosterEnterpriseQuery({diffStatus:'other,query_failed,none'}).diffStatus).toEqual(['other','query_failed','none'])
    expect(()=>parseRosterEnterpriseQuery({diffStatus:'invalid_reason'})).toThrowError(expect.objectContaining({statusCode:400,message:expect.stringContaining('Unknown diffStatus')}))
  })
})
