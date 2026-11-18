import { completePlatformMigration } from '../../../upgrade/complete-platform'
import { mkdirSync, readFileSync } from 'node:fs'
import { expect,it,vi } from 'vitest'
import { targetCandidatesFixture, titles, literalCandidates } from './fixtures/migrated-candidates'
import { createTargetCurrentCandidateReader } from '../../../layers/sme-roster/lib/roster/current-candidates-target'
// Frozen source/SQL literals remain below as historical migration evidence.
// Current returned rows say title 1 for all resolved platform owners; q6's
// actual title 3 row has NO_MATCH ownership. Query scope is not a current title.
const currentCandidates = {
  innovative_sme: [1,2,3,4,5,6,7,8,9,10,11,13,14,16,17,18,19,20,21,22,23,24],
  specialized_sme: [1,2,3],
  little_giant: [1,2,3],
}
it('candidate union preserves independent old and literal PK sets for three titles across all sources and scope histories',async()=>{
  const f=await targetCandidatesFixture()
  try{
    const before = readFileSync(f.target), sourceBefore = readFileSync(f.legacySource)
    const reader=createTargetCurrentCandidateReader(f.db)
    for(const title of titles){
      const expected=currentCandidates[title].map(id=>({id}))
      expect(f.oracle(title)).toEqual(literalCandidates[title].map(id=>({id})))
      expect([...reader.iterate(title)]).toEqual(expected)
    }
    expect(readFileSync(f.target)).toEqual(before)
    expect(readFileSync(f.legacySource)).toEqual(sourceBefore)
  }finally{f.close()}
},30000)

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { platformObservationAssignment as assignment, targetSchema } from '../../../layers/sme-roster/lib/platform/target-schema'
import { candidateScopeObservation as observation } from '../../../layers/sme-roster/lib/platform/candidate-scope-schema'
import { currentCandidateSql,currentCandidateBindings } from '../../../upgrade/frozen/current-candidates'
import { normalizeUscc } from '../../../layers/sme-roster/lib/domain'
import { captureReturnedTitles } from './fixtures/returned-titles'
import { TargetCurrentCandidateGap } from '../../../layers/sme-roster/lib/roster/current-candidates-target'

it('candidate ORM count stable pages and name ties preserve the unique union and reject invalid paging',async()=>{
  const f=await targetCandidatesFixture()
  try{
    const reader=createTargetCurrentCandidateReader(f.db)
    for(const title of titles){
      expect(reader.count(title)).toBe(currentCandidates[title].length)
      const pages=[]
      for(let offset=0;offset<currentCandidates[title].length;offset+=4){
        const page=reader.page(title,offset,4)
        expect(page.total).toBe(currentCandidates[title].length)
        pages.push(...page.rows)
      }
      expect(pages).toEqual(currentCandidates[title].map(id=>({id})))
      expect([...reader.iterate(title,'name_asc')]).toEqual([...reader.iterate(title,'name_desc')])
      expect(reader.page(title,100,2).rows).toEqual([])
    }
    expect(()=>reader.page('little_giant',-1,2)).toThrow(RangeError)
    expect(()=>reader.page('little_giant',0,0)).toThrow(RangeError)
    expect(f.sqlite.inTransaction).toBe(false)
  }finally{f.close()}
},30000)

it('candidate actual rows retain unkeyed unassigned and shared-version owners without borrowing row identities',async()=>{
  const f=await targetCandidatesFixture()
  try{
    const shared=f.db.select().from(observation).where(eq(observation.collectionId,8)).all()
    expect(shared).toHaveLength(2)
    expect(shared[0]!.versionId).not.toBeNull()
    expect(shared[1]!.versionId).toBe(shared[0]!.versionId)
    const reader=createTargetCurrentCandidateReader(f.db)
    for(const title of titles)expect([...reader.iterate(title)]).toEqual(currentCandidates[title].map(id=>({id})))
    expect([...reader.iterate('little_giant')].map(r=>r.id)).not.toContain(12)
    expect([...reader.iterate('innovative_sme')].map(r=>r.id)).toEqual(currentCandidates.innovative_sme)
  }finally{f.close()}
},30000)

it('candidate iterator pins latest assignment ownership and exposes new revisions only on the next snapshot',async()=>{
  const f=await targetCandidatesFixture()
  const captured=captureReturnedTitles(f.db,'queryBusList',[{id:'snapshot-actual-giant',tyshxydm:'U11',qymc:'same',rdjb:'3'}],[11],['3'])
  f.sqlite.pragma('journal_mode=WAL')
  const other=new Database(f.target);other.pragma('foreign_keys=ON');const writer=drizzle(other,{schema:targetSchema})
  try{
    const reader=createTargetCurrentCandidateReader(f.db)
    const assessment=createCurrentQualificationAssessmentReaderWithWitnesses(f.sqlite,createTargetRecognizedWitnessReader(f.db))
    const at=Date.parse('2026-12-01T00:00:00Z')
    f.sqlite.exec('BEGIN')
    const iterator=reader.iterate('little_giant')[Symbol.iterator]()
    const first=iterator.next()
    const target=captured.observations[0]!
    const legacyTarget=f.db.select().from(observation).where(eq(observation.collectionId,6)).all().find(r=>r.sequenceNo===1)!
    writer.insert(assignment).values({observationId:target.observationId,revision:2,enterpriseId:15,matchBasis:'manual',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'731'},basis:'synthetic revision'}).run()
    writer.insert(assignment).values({observationId:legacyTarget.id,revision:2,enterpriseId:15,matchBasis:'manual',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'731'},basis:'same snapshot owner update'}).run()
    const rest=[];for(let next=iterator.next();!next.done;next=iterator.next())rest.push(next.value)
    expect([first.value,...rest]).toEqual([1,2,3,11].map(id=>({id})))
    expect(assessment.readCurrent(11,at,'little_giant').snapshot.titles.find(t=>t.titleCode==='little_giant')!.platform.observations.flatMap(o=>o.rows).map(r=>r.relationId)).toEqual([10,captured.observations[0]!.relationAlias])
    expect(f.sqlite.inTransaction).toBe(true)
    f.sqlite.exec('ROLLBACK')
    expect(assessment.readWorkbook(11,at,'little_giant').snapshot.titles.find(t=>t.titleCode==='little_giant')!.platform.observations.flatMap(o=>o.rows)).toEqual([])
    expect([...reader.iterate('little_giant')]).toEqual([1,2,3,15].map(id=>({id})))
    writer.insert(assignment).values({observationId:target.observationId,revision:3,enterpriseId:null,usccRaw:' u10 ',matchBasis:'none',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'731'},basis:'synthetic unassigned'}).run()
    expect(reader.page('little_giant',0,100).rows).toEqual([1,2,3,10].map(id=>({id})))
  }finally{other.close();f.close()}
},30000)

it('candidate iterator early close and failed gates release only their own read transaction',async()=>{
  const f=await targetCandidatesFixture()
  try{
    const reader=createTargetCurrentCandidateReader(f.db)
    for(const row of reader.iterate('innovative_sme')){expect(row.id).toBe(1);break}
    expect(f.sqlite.inTransaction).toBe(false)
    f.sqlite.exec('BEGIN')
    for(const row of reader.iterate('innovative_sme')){expect(row.id).toBe(1);break}
    expect(f.sqlite.inTransaction).toBe(true)
    expect(reader.page('innovative_sme',0,1).rows).toEqual([{id:1}])
    f.sqlite.exec('COMMIT')
    f.sqlite.pragma('user_version=71608')
    expect(()=>[...reader.iterate('innovative_sme')]).toThrow(/Completed runtime model/)
    expect(()=>reader.count('innovative_sme')).toThrow(TargetCurrentCandidateGap)
    expect(f.sqlite.inTransaction).toBe(false)
  }finally{if(f.sqlite.inTransaction)f.sqlite.exec('ROLLBACK');f.close()}
},30000)

it('candidate SQL trace excludes legacy and archive reads and normalizes owners once per statement',async()=>{
  const f=await targetCandidatesFixture()
  try{
    const reader=createTargetCurrentCandidateReader(f.db)
    // An unmatched owner exposes repeated owner×observation normalization without
    // changing any independent candidate membership. Each page has count+rows.
    const unmatchedOwnerKey=' UNIQUE_TRACE_OWNER '
    f.sqlite.prepare('INSERT INTO enterprise(id,name,name_norm,uscc_norm) VALUES(99,?,?,?)').run('unmatched owner','unmatchedowner',unmatchedOwnerKey)
    let ownerNormalizations=0
    f.sqlite.function('roster84_uscc',{deterministic:true},value=>{
      if(value===unmatchedOwnerKey)ownerNormalizations++
      return normalizeUscc(value as string|null)
    })
    f.statements.length=0
    reader.page('specialized_sme',0,4,'name_asc')
    expect(ownerNormalizations).toBe(2)
    const statements=[...f.statements]
    expect(statements.join('\n')).not.toMatch(/\bplatform_(?:query|relation)\b|\bjson\w*\s*\(|archive|platform_collection/i)
    f.statements.length=0
    expect([...reader.iterate('specialized_sme')]).toEqual([{id:1},{id:2},{id:3}])
    expect(ownerNormalizations).toBe(3)
    const selects=f.statements.filter(q=>/^select/i.test(q)&&/\bunion\b/i.test(q))
    expect(selects).toHaveLength(1)
  }finally{f.close()}
},30000)

import { candidateFixture } from '../../platform/fixtures/candidate-scope-upgrade'
import { finalizeCandidateScopes } from '../../../upgrade/candidate-scope'
it('candidate reader preserves frozen legacy errors but does not use query-scope JSON for current membership',async()=>{
  const f=await candidateFixture(s=>s.exec("INSERT INTO enterprise(id,name,name_norm,uscc_norm) VALUES(7,'E','E','U7'); INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,collection_evidence,created_at) VALUES(1,'recognized_list','Q','1,2','t','success','{\"pages\":[\"oops\"]}','c'); INSERT INTO platform_relation(id,query_id,sequence_no,uscc_raw,raw_fields,created_at) VALUES(1,1,1,'NO_MATCH','{}','c'); INSERT INTO platform_relation(id,query_id,sequence_no,enterprise_id,uscc_raw,raw_fields,created_at) VALUES(2,1,2,7,'U7','{\"id\":\"actual-title\",\"tyshxydm\":\"U7\",\"rdjb\":\"3\"}','c')"))
  finalizeCandidateScopes(f)
  const native=join(f.root,'native-malformed.sqlite'),evidence=join(f.root,'native-malformed-evidence');mkdirSync(evidence);completePlatformMigration(f.legacySource,native,evidence);f.target=native
  const old=new Database(f.legacySource,{readonly:true});old.function('roster84_uscc',{deterministic:true},normalizeUscc)
  const t=new Database(f.target)
  try{
    expect(()=>old.prepare(currentCandidateSql).all(currentCandidateBindings('innovative_sme'))).toThrow('malformed JSON')
    const reader=createTargetCurrentCandidateReader(drizzle(t,{schema:targetSchema}))
    expect(reader.count('innovative_sme')).toBe(1)
    expect([...reader.iterate('little_giant')]).toEqual([{id:7}])
  }finally{old.close();t.close()}
},30000)

it.each(['uncaptured','error','assignment_missing'] as const)('candidate reader rejects incomplete %s migration targets before querying potential owners',async mode=>{
  const f=await candidateFixture(s=>{
    s.exec("INSERT INTO enterprise(id,name,name_norm,uscc_norm) VALUES(7,'E','E','U7'); INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(1,'recognized_list','Q','1,2','t','success','c'); INSERT INTO platform_relation(id,query_id,sequence_no,enterprise_id,uscc_raw,raw_fields,created_at) VALUES(1,1,1,7,'U7','{}','c')")
    if(mode==='error')s.prepare('UPDATE platform_query SET collection_evidence=?').run('{"pages":["oops"]}')
  }, t=>{
    if(mode==='uncaptured'){
      t.exec("INSERT INTO platform_collection(id,interface,query_key,rdjb,queried_at,created_at,status,completeness,provenance_state,parse_state,rule_version) VALUES(2,'recognized_list','M','1,2','t','c','success','unknown','unknown','absent','synthetic'); INSERT INTO platform_business_observation(id,collection_id,sequence_no,position_state,identity_state,content_state,indexed_at) VALUES(2,2,1,'unknown','not_indexed','not_indexed',NULL); INSERT INTO platform_observation_assignment(observation_id,revision,enterprise_id,match_basis,verification_status,origin) VALUES(2,1,7,'manual','pending','migrated_current')")
    }
    if(mode==='assignment_missing')t.exec("INSERT INTO platform_business_observation(id,collection_id,sequence_no,position_state,identity_state,content_state,indexed_at) VALUES(2,1,2,'unknown','not_indexed','not_indexed',NULL)")
  })
  finalizeCandidateScopes(f)
  const t=new Database(f.target)
  try{
    const reader=createTargetCurrentCandidateReader(drizzle(t,{schema:targetSchema}))
    expect(()=>reader.count('innovative_sme')).toThrow('Completed runtime model required')
    expect(()=>reader.page('innovative_sme',0,1)).toThrow(TargetCurrentCandidateGap)
    expect(()=>[...reader.iterate('innovative_sme')]).toThrow(TargetCurrentCandidateGap)
    expect(t.inTransaction).toBe(false)
    if(mode==='assignment_missing')expect(()=>reader.count('little_giant')).toThrow(TargetCurrentCandidateGap)
  }finally{t.close()}
},30000)

it('candidate name ordering uses SQLite nocase direction with ascending PK ties and the same count',async()=>{
  const f=await targetCandidatesFixture()
  try{
    f.sqlite.exec("UPDATE enterprise SET name='aaa' WHERE id=2; UPDATE enterprise SET name='ZZZ' WHERE id=3")
    const reader=createTargetCurrentCandidateReader(f.db)
    const middle=[1,4,5,6,7,8,9,10,11,13,14,16,17,18,19,20,21,22,23,24]
    expect([...reader.iterate('innovative_sme','name_asc')]).toEqual([2,...middle,3].map(id=>({id})))
    expect([...reader.iterate('innovative_sme','name_desc')]).toEqual([3,...middle,2].map(id=>({id})))
    expect(reader.page('innovative_sme',0,2,'name_asc')).toEqual({total:22,rows:[{id:2},{id:1}]})
  }finally{f.close()}
},30000)

it('candidate page count and selected IDs share a snapshot when assignment changes between statements',async()=>{
  const f=await targetCandidatesFixture()
  const captured=captureReturnedTitles(f.db,'queryBusList',[{id:'page-actual-giant',tyshxydm:'U11',qymc:'same',rdjb:'3'}],[11],['3'])
  f.sqlite.pragma('journal_mode=WAL')
  const second=new Database(f.target);second.pragma('foreign_keys=ON')
  const writer=drizzle(second,{schema:targetSchema})
  const target=captured.observations[0]!
  const prepare=f.sqlite.prepare.bind(f.sqlite)
  let injected=false
  const spy=vi.spyOn(f.sqlite,'prepare').mockImplementation(sql=>{
    const statement=prepare(sql)
    if(/^select count\(/i.test(sql)){
      const get=statement.get.bind(statement)
      statement.get=(...args)=>{
        const row=get(...args)
        if(!injected){injected=true;writer.insert(assignment).values({observationId:target.observationId,revision:2,enterpriseId:2,matchBasis:'manual',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'731'},basis:'between count and page'}).run()}
        return row
      }
    }
    return statement
  })
  try{
    const reader=createTargetCurrentCandidateReader(f.db)
    expect(reader.page('little_giant',0,100)).toEqual({total:4,rows:[1,2,3,11].map(id=>({id}))})
    expect(injected).toBe(true)
    expect(reader.page('little_giant',0,100)).toEqual({total:3,rows:[1,2,3].map(id=>({id}))})
  }finally{spy.mockRestore();second.close();f.close()}
},30000)

import { createCurrentQualificationAssessmentReaderWithWitnesses } from '../../../layers/sme-roster/lib/roster/current-qualification'
import { createTargetRecognizedWitnessReader } from '../../../layers/sme-roster/lib/roster/recognized-witness-target'
it('hydrates selected candidates into current and workbook snapshots with public aliases and caller transaction ownership', async()=>{
  const f=await targetCandidatesFixture()
  try{
    const candidates=createTargetCurrentCandidateReader(f.db)
    const reader=createCurrentQualificationAssessmentReaderWithWitnesses(f.sqlite,createTargetRecognizedWitnessReader(f.db))
    const at=Date.parse('2026-12-01T00:00:00Z')
    const before=f.sqlite.prepare('SELECT total_changes() AS n').get()
    f.sqlite.exec('BEGIN')
    expect([...candidates.iterate('innovative_sme')].map(r=>r.id)).toContain(16)
    f.statements.length=0
    const current=reader.readCurrent(16,at,'innovative_sme')
    const workbook=reader.readWorkbook(16,at,'innovative_sme')
    for(const result of [current,workbook]){
      expect(result.snapshot.titles.map(t=>t.titleCode)).toEqual(['little_giant','specialized_sme','innovative_sme'])
      const title=result.snapshot.titles.find(t=>t.titleCode==='innovative_sme')!
      expect(title.platform.observations.flatMap(o=>o.rows).map(r=>r.relationId)).toEqual([13])
      expect(title.versions.observations).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(f.sqlite.inTransaction).toBe(true)
    expect(f.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before)
    expect(f.statements.join('\n')).not.toMatch(/\b(?:from|join)\s+["`]?platform_(?:query|relation)["`]?(?=\s|$)/i)
    f.sqlite.exec('ROLLBACK')
    expect(()=>{for(const _ of candidates.iterate('innovative_sme'))throw new Error('consumer failure')}).toThrow('consumer failure')
    expect(f.sqlite.inTransaction).toBe(false)
  }finally{if(f.sqlite.inTransaction)f.sqlite.exec('ROLLBACK');f.close()}
},30000)
