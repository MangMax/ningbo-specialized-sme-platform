import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect,it} from 'vitest'
import {initializeDb,schema} from '../../../db/client'
import {writeNewCollectionTarget} from '../../../lib/platform/collection-target-command'
import {preflightRecordCorrespondences,commitRecordCorrespondences,getRecordCorrespondence,listRecordCorrespondenceRefs,type CorrespondenceRequest} from '../../../server/utils/record-correspondence'

it('revalidates native correspondence refs after identity changes without returning original bodies',()=>{
  const dir=mkdtempSync(join(tmpdir(),'target-refs-')),db=initializeDb({dbPath:join(dir,'native.sqlite'),create:true})
  try {
    const subject=db.insert(schema.enterprise).values({name:'结构化对应企业',nameNorm:'结构化对应企业',usccNorm:'91330200123456789A'}).returning().get()
    const marker='PRIVATE_ORIGINAL_BODY_',createdAt='2026-11-14T00:00:00Z'
    writeNewCollectionTarget(db,{createdAt,evidenceText:null,queryText:JSON.stringify({interface:'business_list',queryKey:subject.usccNorm,rdjb:'2',titleCode:'specialized_sme',queriedAt:createdAt,status:'success',rawResponse:marker+'x'.repeat(128*1024),relations:[{sequenceNo:1,relationKey:'native-ref',enterpriseId:subject.id,usccRaw:subject.usccNorm,nameRaw:subject.name,declareKind:'apply',rawFields:{id:'native-ref',rdjb:'2'}}]}),assignments:[{enterpriseId:subject.id,nameRaw:subject.name,usccRaw:subject.usccNorm,matchBasis:'uscc',verificationStatus:'confirmed',origin:'command',actor:{type:'user',id:'reviewer'},basis:'explicit synthetic identity'}]})
    const relationId=(db.$client.prepare('SELECT old_id FROM platform_legacy_relation_alias').get() as {old_id:number}).old_id
    const request:CorrespondenceRequest={idempotencyKey:'native-ref',sourceIdentity:'test',actor:{type:'user',id:'reviewer'},basis:'explicit identity and title',ruleId:'manual',ruleVersion:'1',operations:[{action:'create',status:'confirmed',edge:{type:'later_process',enterpriseId:subject.id,titleCode:'specialized_sme',relationId,role:'followup_apply'}}]}
    const plan=preflightRecordCorrespondences(db,request),id=commitRecordCorrespondences(db,request,plan.planHash).correspondenceIds[0]!
    expect(getRecordCorrespondence(db,id)?.requiresRevalidation).toBe(false)
    for(const uscc of [subject.usccNorm,'91330200987654321B',null,subject.usccNorm]) {
      db.$client.prepare('UPDATE enterprise SET uscc_norm=? WHERE id=?').run(uscc,subject.id)
      const expected=getRecordCorrespondence(db,id)!.requiresRevalidation
      let originalBytes=0
      const prepare=db.$client.prepare.bind(db.$client)
      const observe=(value:unknown):void=>{if(typeof value==='string'&&value.includes(marker))originalBytes+=Buffer.byteLength(value);else if(value&&typeof value==='object')Object.values(value).forEach(observe)}
      db.$client.prepare=(text=>{const statement=prepare(text);for(const method of ['all','get'] as const){const run=statement[method].bind(statement);Object.assign(statement,{[method]:(...args:unknown[])=>{const result=run(...args);observe(result);return result}})}return statement}) as typeof prepare
      try {expect(listRecordCorrespondenceRefs(db,{id})[0]?.requiresRevalidation).toBe(expected);expect(originalBytes).toBe(0)}finally{db.$client.prepare=prepare}
    }
  }finally{db.$client.close();rmSync(dir,{recursive:true,force:true})}
})
