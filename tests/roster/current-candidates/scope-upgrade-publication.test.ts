import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { expect, it } from 'vitest'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { candidateFixture } from '../../helpers/candidate-scope-target'
import { finalizeCandidateScopes } from '../../../upgrade/candidate-scope'
import { candidateScopeObservation as o } from '../../../upgrade/frozen/candidate-scope-schema'

it('captures both actual migration gap pairs while preserving every original table cell and predecessor receipt', async () => {
  const inputs = [
    '{"pages":[{"status":"success","rdjb":"2","fetchedCount":1}]}',
    "{pages:[{status:'success',rdjb:'2',fetchedCount:1}]}",
    '{"pages":[{"status":"success","rdjb":"2","fetchedCount":"1"}]}',
    '{"pages":[{"status":"success","rdjb":"2","fetchedCount":null}]}',
  ]
  const f=await candidateFixture(s=>{
    s.exec("INSERT INTO enterprise(id,name,name_norm) VALUES(7,'E','E')")
    for(const [i,text] of inputs.entries()){
      s.prepare("INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,collection_evidence,created_at) VALUES(?,'recognized_list',?,'1,2','t','success',?,'c')").run(i+1,String(i+1),text)
      s.prepare("INSERT INTO platform_relation(id,query_id,sequence_no,enterprise_id,raw_fields,created_at) VALUES(?,?,1,7,'{\"rdjb\":\"3\"}','c')").run(i+1,i+1)
    }
  })
  expect(finalizeCandidateScopes(f)).toEqual({state:'complete',captured:4,uncaptured:0,errors:0})
  const t=new Database(f.target)
  try{
    expect(drizzle(t).select({state:o.candidateScopeState,mask:o.candidateScopeMask,code:o.candidateScopeRdjb,seq:o.candidateScopeSequenceNo,source:o.candidateScopeArchiveId}).from(o).all().map(r=>({...r,source:typeof r.source==='number'}))).toEqual([2,3,2,3].map(mask=>({state:'captured',mask,code:'1,2',seq:1,source:true})))
    expect(t.pragma('foreign_key_check')).toEqual([])
    expect(t.pragma('integrity_check',{simple:true})).toBe('ok')
    const source=new Database(f.source,{readonly:true})
    try {
      for(const row of source.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]) {
        const columns=(source.pragma(`table_info("${row.name}")`) as {name:string}[]).map(c=>`"${c.name}"`).join(',')
        const suffix=row.name.startsWith('platform_migration_') ? " WHERE run_id<>'candidate'" : ''
        expect(t.prepare(`SELECT ${columns} FROM "${row.name}"${suffix}`).all(),row.name).toEqual(source.prepare(`SELECT ${columns} FROM "${row.name}"${suffix}`).all())
      }
    } finally {source.close()}
    const actual=t.pragma('table_info(platform_business_observation)') as {name:string;type:string;notnull:number;dflt_value:unknown}[]
    for(const column of getTableConfig(o).columns) {
      const physical=actual.find(c=>c.name===column.name)!
      expect(physical.type.toLowerCase()).toBe(column.getSQLType())
      if(column.name.startsWith('candidate_scope_')) {
        expect(Boolean(physical.notnull)).toBe(column.notNull)
        expect(physical.dflt_value).toBe(typeof column.default==='string' ? `'${column.default}'` : null)
      }
    }
    expect(t.pragma('foreign_key_list(platform_business_observation)')).toEqual(expect.arrayContaining([expect.objectContaining({from:'candidate_scope_archive_id',table:'platform_archive_value',to:'id',on_delete:'RESTRICT'})]))
    const bytes=t.serialize();t.close()
    expect(finalizeCandidateScopes(f)).toEqual({state:'complete',captured:4,uncaptured:0,errors:0})
    const replay=new Database(f.target);try{expect(replay.serialize()).toEqual(bytes)}finally{replay.close()}
  }finally{if(t.open)t.close()}
},30000)

it('rolls back ordinary successor transactions at every publication boundary', async () => {
  const f=await candidateFixture()
  for(const stage of ['authenticated','schema','captured','barriers','receipt']){
    const target=join(f.root,stage+'.sqlite');copyFileSync(f.source,target)
    const old=new Database(target);const bytes=old.serialize();old.close()
    expect(()=>finalizeCandidateScopes({...f,target,beforeCommit:s=>{if(s===stage)throw new Error('injected '+stage)}})).toThrow('injected '+stage)
    const t=new Database(target);try{expect(t.serialize()).toEqual(bytes);expect(t.pragma('user_version',{simple:true})).toBe(71608)}finally{t.close()}
  }
},30000)

it('rejects wrong predecessor source alias and corrupted successor checkpoint without rewriting receipts',async()=>{
  const f=await candidateFixture()
  expect(()=>finalizeCandidateScopes({...f,target:f.source})).toThrow(/Distinct isolated/)
  expect(()=>finalizeCandidateScopes({...f,predecessorRunId:'absent'})).toThrow()
  expect(finalizeCandidateScopes(f).state).toBe('complete')
  const t=new Database(f.target)
  t.prepare("UPDATE platform_migration_checkpoint SET batch_digest='tampered' WHERE run_id='candidate'").run()
  const before=t.serialize();t.close()
  expect(()=>finalizeCandidateScopes(f)).toThrow(/checkpoint drift/)
  const after=new Database(f.target);try{expect(after.serialize()).toEqual(before)}finally{after.close()}
},30000)
