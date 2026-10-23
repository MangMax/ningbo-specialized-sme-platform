// Throwaway differential probe; only creates synthetic SQLite under SPIKE_OUT.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { getTableColumns, eq } from 'drizzle-orm'
import { expect, it } from 'vitest'
import { useDb, schema as s } from '../../../db/client'
import { preflightRecordCorrespondences as preflight, commitRecordCorrespondences as commit } from '../../../server/utils/record-correspondence'
const out = process.env.SPIKE_OUT!
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const q = (s: string) => '"' + s.replaceAll('"', '""') + '"'
const lit = (s: string) => "'" + s.replaceAll("'", "''") + "'"
// Schema key order is the ORM's object property order. JSON-mode is deliberately
// passed through JSON1, the candidate under investigation (not a JS UDF).
function obj(table: any, alias: string, omit: string[] = [], keys?: string[]) {
  return `json_object(${Object.entries(getTableColumns(table)).filter(([k]) => !omit.includes(k) && (!keys || keys.includes(k))).flatMap(([key, col]: any) => {
    const value = `${alias}.${q(col.name)}`
    return [lit(key), col.columnType === 'SQLiteTextJson' ? `json(${value})` : value]
  }).join(',')})`
}
function snapshotSQL(revision: number) {
  const event = obj(s.recordEvent, 'e', revision <= 1 ? ['revision'] : [])
  const file = obj(s.storedFile, 'f', [], ['id','relPath','bytes','sha256','removedAt'])
  return `select json_object('event',json(${event}),'record',json(${obj(s.record,'r')}),
    'officialEnterprise',json(${obj(s.enterprise,'o')}),
    'officialEvidence',json((select json_group_array(json(v)) from
      (select json_object('evidence',json(${obj(s.recordEvidence,'ev')}),'storedFile',
      case when f.id is null then null else json(${file}) end) v
      from record_evidence ev left join stored_file f on f.rel_path=ev.source_file
      where ev.record_event_id=e.id order by ev.id))),
    'predecessor',null,'relation',json(${obj(s.platformRelation,'p')}),
    'query',json(${obj(s.platformQuery,'a')}),'exportRow',null,'exportBatch',null) value
    from record_event e join record r on r.id=e.record_id join enterprise o on o.id=r.enterprise_id
    join platform_relation p on p.id=? join platform_query a on a.id=p.query_id where e.id=?`
}
const examples = [
 ['canonical','{"s":"中文😀\\n\\u0000","a":[1,true,null],"o":{"x":"y"}}'],
 ['escaped-unicode','{"s":"\\u0061"}'], ['integer-key-order','{"10":"ten","2":"two","x":1}'],
 ['duplicate-keys','{"x":1,"x":2}'], ['number-spelling','{"n":1.0,"e":1e+02,"z":-0}'],
 ['rounded-integer','{"n":9007199254740993}'], ['lone-surrogate','{"s":"\\uD800"}'],
 ['json-null','null'], ['array','[1,"x",null]'], ['empty-object','{}'],
] as const
it('differentiates complete event snapshots and retains incompatible SQL results', () => {
  mkdirSync(out, { recursive: true })
  const db = useDb({ dbPath: join(out,'domain-synthetic.db') })
  const c = db.$client
  const enterprise = db.insert(s.enterprise).values({ name:'合成企业', nameNorm:'合成企业', usccNorm:'91330211255994457P' }).returning().get()
  const record = db.insert(s.record).values({enterpriseId:enterprise.id,titleCode:'specialized_sme',source:'jxj',usccRaw:enterprise.usccNorm}).returning().get()
  const event = db.insert(s.recordEvent).values({recordId:record.id,eventType:'award',year:2022}).returning().get()
  db.insert(s.storedFile).values({relPath:'synthetic/notice.pdf',filename:'notice.pdf',ext:'pdf',bytes:40,sha256:'a'.repeat(64)}).run()
  // Insert out of ID order to exercise the source's evidence ordering.
  db.insert(s.recordEvidence).values([{id:9,recordEventId:event.id,sourceFile:'synthetic/missing.pdf',page:null},{id:3,recordEventId:event.id,sourceFile:'synthetic/notice.pdf',page:2}]).run()
  writeFileSync(join(out,'snapshot.sql'),snapshotSQL(2))
  const results: any[] = []
  for (const iface of ['business_list','recognized_list'] as const) for (const revision of [1,2]) for (const [name,text] of examples) {
    db.update(s.recordEvent).set({revision}).where(eq(s.recordEvent.id,event.id)).run()
    const query = db.insert(s.platformQuery).values({interface:iface,queryKey:enterprise.usccNorm!,rdjb:'2',titleCode:'specialized_sme',queriedAt:`synthetic/${iface}/${revision}/${name}`,status:'success',rawResponse:'<html>"\\\n\u0000中文😀 not JSON</html>'}).returning().get()
    const relation = db.insert(s.platformRelation).values({queryId:query.id,sequenceNo:1,enterpriseId:enterprise.id,usccRaw:enterprise.usccNorm,verificationStatus:'confirmed'}).returning().get()
    // Deliberately preserve valid noncanonical storage; no claim about real data.
    c.prepare('update platform_query set collection_evidence=? where id=?').run(text,query.id)
    c.prepare('update platform_relation set raw_fields=? where id=?').run(text,relation.id)
    const edge = iface === 'business_list' ? {type:'event_process' as const,eventId:event.id,relationId:relation.id,role:'context_only' as const} : {type:'event_recognized' as const,eventId:event.id,relationId:relation.id,role:'current_context' as const}
    const request = {idempotencyKey:`probe/${query.id}`,sourceIdentity:'synthetic/220',actor:{type:'agent' as const,id:'candidate-discovery-job'},basis:'synthetic only',ruleId:'spike',ruleVersion:'1',operations:[{action:'create' as const,status:'candidate' as const,edge}]}
    const sqlText = (c.prepare(snapshotSQL(revision)).get(relation.id,event.id) as any).value
    const plan = preflight(db,request)
    const receipt = commit(db,request,plan.planHash)
    const row = c.prepare('select provenance,source_fingerprint from record_correspondence where id=?').get(receipt.correspondenceIds[0]) as any
    const persisted = JSON.parse(row.provenance)
    const {comparisonProofIds,...source} = persisted
    const legacy = JSON.stringify(source)
    expect(hash(legacy)).toBe(row.source_fingerprint)
    expect(comparisonProofIds).toEqual([])
    expect(persisted.officialEvidence.map((x:any)=>x.evidence.id)).toEqual([3,9])
    expect(persisted.officialEvidence[1].storedFile).toBeNull()
    expect(Object.hasOwn(persisted.event,'revision')).toBe(revision>1)
    const audit = c.prepare('select evidence from record_correspondence_audit where correspondence_id=?').get(receipt.correspondenceIds[0]) as any
    expect(audit.evidence).toBe(row.provenance)
    // Domain-owned copy concept, on a TEMP diagnostic table, never writes runtime rows.
    c.exec('create temp table if not exists copied(evidence text)')
    c.prepare('insert into copied select provenance from record_correspondence where id=?').run(receipt.correspondenceIds[0])
    expect((c.prepare('select evidence from copied order by rowid desc limit 1').get() as any).evidence).toBe(audit.evidence)
    const candidateProvenance = sqlText.slice(0,-1)+',"comparisonProofIds":[]}'
    const targets = plan.targets.map((x:any)=>({...x,sourceFingerprint:hash(sqlText)}))
    const sqlPlanHash = hash(JSON.stringify({requestHash:hash(JSON.stringify(request)),targets,impact:plan.impact}))
    results.push({iface,revision,name,bytesEqual:sqlText===legacy,sourceHashEqual:hash(sqlText)===row.source_fingerprint,
      provenanceEqual:candidateProvenance===row.provenance,auditCopyEqual:true,planHashEqual:sqlPlanHash===plan.planHash,
      legacyHash:row.source_fingerprint,sqlHash:hash(sqlText),legacy,sqlText})
  }
  writeFileSync(join(out,'domain-differential.json'),JSON.stringify(results,null,2))
  expect(results).toHaveLength(40)
  expect(results.filter(x=>x.bytesEqual)).toHaveLength(16)
  expect(results.filter(x=>!x.sourceHashEqual)).toHaveLength(24)
  const n = (c.prepare('select count(*) n from copied').get() as any).n
  expect(()=>c.transaction(()=>{ c.exec('insert into copied select evidence from copied limit 1'); throw Error('synthetic rollback') })()).toThrow('synthetic rollback')
  expect((c.prepare('select count(*) n from copied').get() as any).n).toBe(n)
  // Same source observed at preflight, then changed before commit: authoritative rejection.
  const relation = db.select().from(s.platformRelation).get()!
  const req = {idempotencyKey:'drift',sourceIdentity:'synthetic/220',actor:{type:'agent' as const,id:'candidate-discovery-job'},basis:'drift',ruleId:'spike',ruleVersion:'2',operations:[{action:'create' as const,status:'candidate' as const,edge:{type:'event_process' as const,eventId:event.id,relationId:relation.id,role:'supports_award' as const}}]}
  const plan = preflight(db,req)
  c.prepare('update record_event set revision=revision+1 where id=?').run(event.id)
  expect(()=>commit(db,req,plan.planHash)).toThrowError(expect.objectContaining({code:'plan_mismatch'}))
  writeFileSync(join(out,'domain-summary.json'),JSON.stringify({cases:40,exactMatches:16,mismatches:24,auditCopies:40,rollback:true,eventRevisionDriftRejected:true,sqlPlanUsesOracleTargetIdentity:true},null,2))
  c.close()
})

it('keeps nullable raw TEXT and hashes UTF8 bytes across chunk boundaries', () => {
  // Reuse synthetic *values*, on a separate DB, never the earlier open handle.
  const db = useDb({ dbPath: join(out,'boundary-synthetic.db') })
  const c=db.$client
  const enterprise=db.insert(s.enterprise).values({name:'边界合成',nameNorm:'边界合成',usccNorm:'91330211255994457P'}).returning().get()
  const record=db.insert(s.record).values({enterpriseId:enterprise.id,titleCode:'specialized_sme',source:'jxj',usccRaw:enterprise.usccNorm}).returning().get()
  const event=db.insert(s.recordEvent).values({recordId:record.id,eventType:'award',year:2022,revision:2}).returning().get()
  const cases=[
    {id:'sql-null',raw:null,collection:null,fields:null},
    {id:'empty-text',raw:'',collection:'{}',fields:'[]'},
    {id:'json-is-text',raw:'{"s":"\\u0061","n":-0}',collection:'true',fields:'123'},
    {id:'utf8-chunk-boundary',raw:'x'.repeat(65535)+'😀中文\u0000'+ 'y'.repeat(65535),collection:'{"s":"中文😀"}',fields:'[null,false,0]'},
  ]
  const results=[]
  for(const x of cases) {
    const a=db.insert(s.platformQuery).values({interface:'business_list',queryKey:'synthetic/'+x.id,rdjb:'2',titleCode:'specialized_sme',queriedAt:'synthetic/'+x.id,status:'success',rawResponse:x.raw}).returning().get()
    const p=db.insert(s.platformRelation).values({queryId:a.id,sequenceNo:1,enterpriseId:enterprise.id,usccRaw:enterprise.usccNorm,verificationStatus:'confirmed'}).returning().get()
    c.prepare('update platform_query set collection_evidence=? where id=?').run(x.collection,a.id)
    c.prepare('update platform_relation set raw_fields=? where id=?').run(x.fields,p.id)
    const req={idempotencyKey:x.id,sourceIdentity:'synthetic/220',actor:{type:'agent' as const,id:'candidate-discovery-job'},basis:'boundary',ruleId:'spike',ruleVersion:'1',operations:[{action:'create' as const,status:'candidate' as const,edge:{type:'event_process' as const,eventId:event.id,relationId:p.id,role:'context_only' as const}}]}
    const plan=preflight(db,req), receipt=commit(db,req,plan.planHash)
    const legacy=(c.prepare('select provenance,source_fingerprint from record_correspondence where id=?').get(receipt.correspondenceIds[0]) as any)
    const value=(c.prepare(snapshotSQL(2)).get(p.id,event.id) as any).value
    expect(hash(value)).toBe(legacy.source_fingerprint)
    const {comparisonProofIds,...source}=JSON.parse(legacy.provenance)
    expect(JSON.stringify(source)).toBe(value)
    expect(source.query.rawResponse).toBe(x.raw)
    c.exec('create temp table if not exists snapshot(payload text)'); c.exec('delete from snapshot')
    c.prepare('insert into snapshot(payload) '+snapshotSQL(2)).run(p.id,event.id)
    const bytes=(c.prepare('select length(cast(payload as blob)) n from snapshot').get() as any).n
    const digest=createHash('sha256');let largest=0
    for(let offset=1;offset<=bytes;offset+=65536){const b=(c.prepare('select substr(cast(payload as blob),?,65536) b from snapshot').get(offset) as any).b;digest.update(b);largest=Math.max(largest,b.length)}
    expect(digest.digest('hex')).toBe(legacy.source_fingerprint)
    expect(largest).toBeLessThanOrEqual(65536)
    results.push({id:x.id,bytes,largest,sourceHashEqual:true,rawTextEqual:true})
  }
  writeFileSync(join(out,'boundary-results.json'),JSON.stringify(results,null,2));c.close()
})
