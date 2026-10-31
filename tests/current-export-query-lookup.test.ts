import { afterAll, expect, it, vi } from 'vitest'
import { currentExport118Fixture } from './helpers/current-export-118'
import { schema as s } from '../db/client'
import { readQueryAssessment } from '../lib/roster/query-assessment'
import { readIdentityKeyVariants } from '../lib/roster/current-identity-keys'
const f=currentExport118Fixture()
afterAll(()=>f.close())
it('preserves coverage ordering deduplication truncation and legacy identity keys through indexed snapshot lookup',()=>{
  const c=f.candidate('Query lookup synthetic',[]),id=c.enterprise.id
  f.db.$client.prepare('update enterprise set uscc_norm=? where id=?').run('SYNTHETIC-LOOKUP',id)
  let serial=0
  for(const key of ['SYNTHETIC-LOOKUP','synthetic-lookup',' \tSYNTHETIC-LOOKUP\u3000','name:'+c.enterprise.name,'UNRELATED']){
    for(let i=0;i<27;i++){
      const q=f.db.insert(s.platformQuery).values({interface:'business_list',queryKey:key,titleCode:i%3===0?'little_giant':'specialized_sme',rdjb:i%3===0?'3':'2',queriedAt:new Date(1700000000000+(serial++)).toISOString(),status:i%2?'failed':'no_record'}).returning().get()
      if(key==='UNRELATED')for(let j=0;j<60;j++)f.db.insert(s.platformRelation).values({queryId:q.id,enterpriseId:id,sequenceNo:j+1,verificationStatus:'pending'}).run()
    }
  }
  const scope={enterpriseId:id,titleCode:'specialized_sme',direction:'extra_in_miit' as const}
  const expected=readQueryAssessment(f.db,scope)
  const variants=readIdentityKeyVariants(f.db.$client,'queries')
  const actual=readQueryAssessment(f.db,scope,variants)
  expect(actual).toEqual(expected)
  expect(actual.queryCoverage.sources).toHaveLength(50)
  expect(actual.queryCoverage.truncated).toBe(true)
  expect(new Set(actual.queryCoverage.sources.map(q=>q.queryId)).size).toBe(50)
  expect(actual.queryCoverage.sources[0]!.queryId).toBe(135)
  const names=readQueryAssessment(f.db,{...scope,titleCode:'innovative_sme'},variants)
  expect(names.queryCoverage.sources).toEqual([])
})
it('does not retain identity variants across export snapshots or read source bodies',()=>{
  const c=f.candidate('Fresh key snapshot',[]),id=c.enterprise.id
  f.db.$client.prepare('update enterprise set uscc_norm=? where id=?').run('SNAPSHOT-FRESH',id)
  const first=readIdentityKeyVariants(f.db.$client,'queries')
  f.db.insert(s.platformQuery).values({interface:'business_list',queryKey:' snapshot-fresh ',titleCode:'specialized_sme',rdjb:'2',queriedAt:new Date().toISOString(),status:'failed',rawResponse:'RAW_SENTINEL'}).run()
  const scope={enterpriseId:id,titleCode:'specialized_sme',direction:'extra_in_miit' as const}
  expect(readQueryAssessment(f.db,scope,first).queryCoverage.sources).toEqual([])
  const fresh=readIdentityKeyVariants(f.db.$client,'queries')
  const assessment=readQueryAssessment(f.db,scope,fresh)
  expect(assessment.queryCoverage.sources).toHaveLength(1)
  expect(assessment.queryCoverage.status).toBe('failed')
  expect(JSON.stringify([...fresh])).not.toContain('RAW_SENTINEL')
})

it('preserves full three-title workbook snapshots and cells with indexed coverage', async()=>{
  const { createCurrentQualificationAssessmentReader } = await import('../lib/roster/current-qualification')
  const { currentWorkbookValues } = await import('../lib/roster/current-workbook-presentation')
  const id=f.candidate('Workbook indexed coverage',[]).enterprise.id
  f.db.$client.prepare('update enterprise set uscc_norm=? where id=?').run('WORKBOOK-KEY',id)
  for(const titleCode of ['little_giant','specialized_sme','innovative_sme'] as const)
    f.db.insert(s.platformQuery).values({interface:'apply_list',queryKey:' workbook-key ',titleCode,rdjb:({little_giant:'3',specialized_sme:'2',innovative_sme:'1'}[titleCode]),queriedAt:'2026-10-30T00:00:00Z',status:'failed'}).run()
  const reader=createCurrentQualificationAssessmentReader(f.db.$client),asOf=Date.parse('2026-10-31T12:00:00Z')
  const expected=reader.readWorkbook(id,asOf,'little_giant')
  const keys=readIdentityKeyVariants(f.db.$client,'queries')
  const prepare=vi.spyOn(f.db.$client,'prepare')
  let actual: ReturnType<typeof reader.readWorkbook>
  try {
    actual=reader.readWorkbook(id,asOf,'little_giant',keys)
    const queries=prepare.mock.calls.map(([text])=>text).join('\n')
    expect(queries).toContain('indexed by platform_query_key_idx')
    expect(queries).not.toContain('instr(q.query_key')
  } finally { prepare.mockRestore() }
  expect(actual.snapshot).toEqual(expected.snapshot)
  expect(actual.snapshot.titles).toHaveLength(3)
  expect(actual.rows).toEqual(expected.rows)
  expect(actual.workbookPublished).toEqual(expected.workbookPublished)
  expect(currentWorkbookValues('little_giant',actual.rows[0]!,1,actual.workbookPublished)).toEqual(currentWorkbookValues('little_giant',expected.rows[0]!,1,expected.workbookPublished))
})
