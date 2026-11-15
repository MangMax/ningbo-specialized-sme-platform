import { afterAll, expect, it } from 'vitest'
import { currentExport118Fixture } from '../../helpers/current-export-118'
import { submitNativePlatformQuery } from '../../helpers/native-platform-fixture'
import { readQueryAssessment } from '../../../lib/roster/query-assessment'
import { readTargetIdentityKeyVariants } from '../../../lib/roster/current-identity-keys'
const f=currentExport118Fixture()
afterAll(()=>f.close())
it('preserves coverage ordering deduplication truncation and noncanonical identity keys through native snapshot lookup',()=>{
  const c=f.candidate('Query lookup synthetic',[]),id=c.enterprise.id
  f.db.$client.prepare('update enterprise set uscc_norm=? where id=?').run('SYNTHETIC-LOOKUP',id)
  let serial=0
  f.db.transaction(()=>{
  for(const key of ['SYNTHETIC-LOOKUP','synthetic-lookup',' \tSYNTHETIC-LOOKUP\u3000','name:'+c.enterprise.name,'UNRELATED']){
    for(let i=0;i<27;i++){
      // Two same-owner observations prove query deduplication; 135 histories
      // independently exercise the exact 50-query coverage boundary.
      const relations = key === 'UNRELATED' ? Array.from({length:2}, (_,j) => ({ sequenceNo:j+1, enterpriseId:id, nameRaw:c.enterprise.name, usccRaw:'SYNTHETIC-LOOKUP', verificationStatus:'pending' as const, matchBasis:'manual' as const })) : []
      submitNativePlatformQuery(f.db, {interface:'business_list',queryKey:key,titleCode:i%3===0?'little_giant':'specialized_sme',rdjb:i%3===0?'3':'2',queriedAt:new Date(1700000000000+(serial++)).toISOString(),status:i%2?'failed':'no_record',rawResponse:JSON.stringify({queryKey:key,rows:relations}),relations})
    }
  }
  })
  const scope={enterpriseId:id,titleCode:'specialized_sme',direction:'extra_in_miit' as const}
  const expected=readQueryAssessment(f.db,scope)
  const variants=readTargetIdentityKeyVariants(f.db.$client,'queries')
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
  const first=readTargetIdentityKeyVariants(f.db.$client,'queries')
  submitNativePlatformQuery(f.db,{interface:'business_list',queryKey:' snapshot-fresh ',titleCode:'specialized_sme',rdjb:'2',queriedAt:new Date().toISOString(),status:'failed',rawResponse:'RAW_SENTINEL'})
  const scope={enterpriseId:id,titleCode:'specialized_sme',direction:'extra_in_miit' as const}
  expect(readQueryAssessment(f.db,scope,first).queryCoverage.sources).toEqual([])
  const fresh=readTargetIdentityKeyVariants(f.db.$client,'queries')
  const assessment=readQueryAssessment(f.db,scope,fresh)
  expect(assessment.queryCoverage.sources).toHaveLength(1)
  expect(assessment.queryCoverage.status).toBe('failed')
  expect(JSON.stringify([...fresh])).not.toContain('RAW_SENTINEL')
})

it('preserves full three-title workbook snapshots and cells with indexed coverage', async()=>{
  const { createCurrentQualificationAssessmentReader } = await import('../../../lib/roster/current-qualification')
  const { currentWorkbookValues } = await import('../../../lib/roster/current-workbook-presentation')
  const id=f.candidate('Workbook indexed coverage',[]).enterprise.id
  f.db.$client.prepare('update enterprise set uscc_norm=? where id=?').run('WORKBOOK-KEY',id)
  for(const titleCode of ['little_giant','specialized_sme','innovative_sme'] as const)
    submitNativePlatformQuery(f.db,{interface:'apply_list',queryKey:' workbook-key ',titleCode,rdjb:({little_giant:'3',specialized_sme:'2',innovative_sme:'1'}[titleCode]),queriedAt:'2026-10-30T00:00:00Z',status:'failed',rawResponse:'synthetic failed workbook query'})
  const reader=createCurrentQualificationAssessmentReader(f.db.$client),asOf=Date.parse('2026-10-31T12:00:00Z')
  const expected=reader.readWorkbook(id,asOf,'little_giant')
  const keys=readTargetIdentityKeyVariants(f.db.$client,'queries')
  const actual=reader.readWorkbook(id,asOf,'little_giant',keys)
  expect(actual.snapshot).toEqual(expected.snapshot)
  expect(actual.snapshot.titles).toHaveLength(3)
  expect(actual.rows).toEqual(expected.rows)
  expect(actual.workbookPublished).toEqual(expected.workbookPublished)
  expect(currentWorkbookValues('little_giant',actual.rows[0]!,1,actual.workbookPublished)).toEqual(currentWorkbookValues('little_giant',expected.rows[0]!,1,expected.workbookPublished))
})
