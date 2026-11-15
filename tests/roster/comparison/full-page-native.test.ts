import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { initializeDb } from '../../../db/client'
import * as s from '../../../db/schema'
import { readWholeComparisonFull } from '../../../lib/comparison-full'
import { readWholeComparisonSummary } from '../../../lib/comparison-summary-read'
import { reconcileKey } from '../../../lib/reconcile'
import { patchCuration } from '../../../lib/curation'
import { submitNativePlatformQuery } from '../../helpers/native-platform-fixture'

it('selects native full evidence after alias filtering and pagination while retaining global counts and summary page parity',()=>{
  const dir=mkdtempSync(join(tmpdir(),'comparison-full-page-')),path=join(dir,'native.sqlite')
  const db=initializeDb({dbPath:path,create:true})
  try {
    const curatedPath=join(dir,'curated.json'),reconcilePath=join(dir,'reconcile.json')
    const ids:number[]=[]
    for(const [index,name] of ['Alpha native','Beta native','Gamma native'].entries()) {
      const enterprise=db.insert(s.enterprise).values({name,nameNorm:name,usccNorm:`NATIVE-COMPARISON-${index}`}).returning().get()
      ids.push(enterprise.id)
      db.insert(s.record).values({enterpriseId:enterprise.id,titleCode:'specialized_sme',source:'jxj',nameRaw:name,usccRaw:enterprise.usccNorm,district:'鄞州区'}).run()
      if(index===2)continue
      const rawFields={id:`native-page-${index}`,qymc:name,tyshxydm:enterprise.usccNorm!,rdjb:'2',cszt:'终审通过',payload:index===0?'selected original': 'UNSELECTED_NATIVE_ARCHIVE_MARKER'}
      submitNativePlatformQuery(db,{interface:'business_list',queryKey:enterprise.usccNorm!,rdjb:'2',queriedAt:'2026-11-14T00:00:00Z',status:'success',rawResponse:`source ${index}`,relations:[{sequenceNo:1,relationKey:rawFields.id,enterpriseId:enterprise.id,nameRaw:name,usccRaw:enterprise.usccNorm,rawFields,matchBasis:'uscc',verificationStatus:'confirmed'}]})
    }
    db.insert(s.enterpriseAlias).values([
      {enterpriseId:ids[0]!,name:'Trusted old name',nameNorm:'Trusted old name',sourceKind:'manual',verificationStatus:'confirmed'},
      {enterpriseId:ids[0]!,name:'Pending old name',nameNorm:'Pending old name',sourceKind:'manual',verificationStatus:'pending'},
    ]).run()
    patchCuration(curatedPath,{uscc:'NATIVE-COMPARISON-2',titleCode:'specialized_sme',direction:'missing_in_miit',curated:true,note:'retained curation note'})
    const explanation={code:'on_platform',note:'selected original explanation'}
    writeFileSync(reconcilePath,JSON.stringify({generatedAt:'2026-11-14',entries:[{key:reconcileKey({uscc:'NATIVE-COMPARISON-0',nameNorm:'Alpha native',titleCode:'specialized_sme',direction:'missing_in_miit'}),titleCode:'specialized_sme',direction:'missing_in_miit',explanation,evidence:{original:'selected cache original'}}]}))
    const options={curatedPath,reconcilePath,showCurated:false,page:1,pageSize:1}
    const full=readWholeComparisonFull(db,options),summary=readWholeComparisonSummary(db,options)
    expect(Object.keys(full).sort()).toEqual(['counts','curatedCounts','platform','reconcile','rows','total'])
    expect(full).toMatchObject({total:2,counts:{specialized_sme:{missing_in_miit:3,extra_in_miit:0}},curatedCounts:{specialized_sme:{missing_in_miit:1,extra_in_miit:0}},platform:{withEvidence:2,withExplanation:0,withoutExplanation:2},reconcile:{generatedAt:'2026-11-14',matched:1}})
    expect(full.rows.map(row=>[row.enterpriseId,row.titleCode,row.direction])).toEqual([[ids[0],'specialized_sme','missing_in_miit']])
    expect(full.rows[0]!.explanation).toMatchObject({explanation,evidence:{original:'selected cache original'}})
    expect(full.rows[0]!.platform.queries[0]!.relations[0]!.rawFields).toMatchObject({payload:'selected original'})
    for(const key of ['total','counts','curatedCounts','platform','reconcile'] as const)expect(full[key]).toEqual(summary[key])
    expect(summary.rows.map(row=>row.enterpriseId)).toEqual([ids[0]])
    const aliasOptions={...options,q:'Trusted old name'}
    expect(readWholeComparisonFull(db,aliasOptions).rows.map(row=>row.enterpriseId)).toEqual([ids[0]])
    expect(readWholeComparisonFull(db,aliasOptions).total).toBe(1)
    expect(readWholeComparisonSummary(db,aliasOptions).rows.map(row=>row.enterpriseId)).toEqual([ids[0]])
    expect(readWholeComparisonFull(db,{...options,q:'Pending old name'})).toMatchObject({rows:[],total:0,counts:full.counts,curatedCounts:full.curatedCounts})
    expect(readWholeComparisonSummary(db,{...options,page:2}).rows.map(row=>row.enterpriseId)).toEqual([ids[1]])
    const second=readWholeComparisonFull(db,{...options,page:2})
    expect(second.rows[0]!.enterpriseId).toBe(ids[1])
    expect(second.rows[0]!.platform.queries[0]!.relations[0]!.rawFields?.payload).toBe('UNSELECTED_NATIVE_ARCHIVE_MARKER')
    expect(readWholeComparisonFull(db,{...options,enterpriseId:999999})).toMatchObject({rows:[],total:0,counts:full.counts,curatedCounts:full.curatedCounts})
  } finally {db.$client.close();rmSync(dir,{recursive:true,force:true})}
})
