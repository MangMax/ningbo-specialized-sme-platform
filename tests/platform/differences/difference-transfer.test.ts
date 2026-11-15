import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { copyFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest'
import { processReaderFixture } from '../../helpers/process-target-734'
import { transferCorrespondence } from '../../../upgrade/correspondence'
import { transferDifferenceReferences } from '../../../upgrade/difference-references'
import { writeNewCollectionTarget } from '../../../upgrade/frozen/collection-target-command'
import { reserveLegacyIds } from '../../../lib/platform/target-archive'
import * as schema from '../../../upgrade/legacy-schema'

let f: Awaited<ReturnType<typeof processReaderFixture>>, source: string, target: string
let coordinates: ReturnType<typeof writeNewCollectionTarget>
const scope = { enterpriseId: 1, titleCode: 'specialized_sme' as const, direction: 'missing_in_miit' as const }
beforeAll(async () => {
 f = await processReaderFixture(false, legacy => {
  drizzle(legacy,{schema}).insert(schema.differenceReason).values({...scope,id:101,status:'needs_review',evidenceQueryId:11,evidenceRelationId:1,requestHash:' original legacy request ',idempotencyKey:'original-101',basis:' { "queryId":11, "relationId":1 } ',recordedAt:'101',createdAt:' original legacy time '}).run()
 // Existing serialized 113/114 evidence is deliberately opaque to this transfer.
 legacy.exec(`INSERT INTO evidence_revision_113(id,source_kind,source_key,source_version,coverage_digest,fact_digest,coverage_changed,fact_changed,metadata,max_decision_id,created_at) VALUES(11,'platform','old','v','hash1','hash2',1,1,' { "queryId":11, "relationId":1 } ',101,' old time ');
 INSERT INTO evidence_impact_progress_113 VALUES(11,101,1);
 INSERT INTO explanation_impact_113(id,enterprise_id,title_code,direction,decision_id,latest_revision_id,pending_since_revision_id,classification) VALUES(12,1,'specialized_sme','missing_in_miit',101,11,11,'review');
 INSERT INTO evidence_review_receipt_114(id,idempotency_key,request_hash,kind,enterprise_id,title_code,direction,decision_id,source_decision_id,reviewed_revision_id,actor,basis,response,recorded_at) VALUES(13,'review-old',' request hash ','review',1,'specialized_sme','missing_in_miit',101,101,11,' { "type":"agent","id":"old" } ',' bytes ',' { "queryId":11, "relationId":1 } ',' old time ');`)
 })
 reserveLegacyIds(f.db, { query: 8000, relation: 9000 })
 coordinates = writeNewCollectionTarget(f.db, { queryText: JSON.stringify({ interface: 'business_list', queryKey: 'U1', rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-11-01', status: 'success', rawResponse: ' original bytes ', relations: [{ sequenceNo: 1, relationKey: 'NEW749', enterpriseId: 1, nameRaw: 'Alpha', rawFields: { id: 'NEW749', rdjb: '2', cszt: '终审通过' } }] }), evidenceText: null, createdAt: '2026-11-01', assignments: [{ enterpriseId: 1, nameRaw: 'Alpha', matchBasis: 'none', verificationStatus: 'pending', origin: 'command', actor: { type: 'agent', id: '749' }, basis: 'normal source' }] })
 const old = drizzle(f.t, { schema })
 old.insert(schema.sourceDocument).values({id:1,source:'jxj',path:'synthetic749/official.pdf',title:'Synthetic original'}).run()
 old.insert(schema.platformQuery).values({ id: coordinates.queryAlias, interface: 'business_list', queryKey: 'U1', rdjb: '2', queriedAt: '2026-11-01', status: 'success' }).run()
 old.insert(schema.platformRelation).values({ id: coordinates.observations[0]!.relationAlias, queryId: coordinates.queryAlias, sequenceNo: 1, nameRaw: 'Alpha' }).run()
 for (const [id, query, relation, previousId, action] of [[102, coordinates.queryAlias, null, 101, 'replace'], [103, null, coordinates.observations[0]!.relationAlias, 102, 'replace'], [104, coordinates.queryAlias, coordinates.observations[0]!.relationAlias, 103, 'replace'], [105, null, null, 104, 'withdraw']] as const) {
  old.insert(schema.differenceReason).values({ ...scope, id, evidenceQueryId: query, evidenceRelationId: relation, previousId, lifecycleAction: action, status: 'needs_review', reasonCode: 'other', reasonNote: '原值\u0000 尾 ', measureCode: 'manual_review', measureNote: ' original measure ', movedInCity: ' 原城市 ', movedInTitleCode: 'innovative_sme', movedInYear: 2024, movedInBatch: 2, factReferences: [{enterpriseId:1,factId:17,revision:3,kind:'original'}], currentQualification: {titleCode:'specialized_sme',validFrom:' old start ',validUntil:' old end ',basis:' original qualification ',publicationCheck:{status:'not_checked',scope:' original scope '}}, actor: { type: 'agent', id: 'old' }, basis: ' { "evidenceQueryId":8001, "evidenceRelationId":9001 } ', requestHash: 'old hash '+id, idempotencyKey: 'old-'+id, ruleVersion: 'old-v', effectiveAt: ' t ', recordedAt: String(id), createdAt: ' c ' }).run()
 }
 f.t.exec("UPDATE sqlite_sequence SET seq=250 WHERE name='difference_reason'")
 const predecessor = join(f.root, 'fixed-71610.sqlite'); copyFileSync(f.target, predecessor)
 source = join(f.root, 'fixed-71611.sqlite'); copyFileSync(predecessor, source)
 transferCorrespondence({ source: predecessor, target: source, runId: 'h1c749' })
 target = join(f.root, 'target-71612.sqlite')
})
beforeEach(() => copyFileSync(source, target))
afterAll(() => f?.close())
it('transfers nonidentity evidence references and self chains preserving literal IDs nulls indexes and sequence', () => {
 expect(coordinates.queryAlias).toBe(8001); expect(coordinates.collectionId).not.toBe(8001)
 expect(coordinates.observations[0]!.relationAlias).toBe(9001); expect(coordinates.observations[0]!.observationId).not.toBe(9001)
 expect(transferDifferenceReferences({ source, target, runId: 'difference749' })).toEqual({ state: 'complete', rows: 5, queries: 3, relations: 3 })
 const t = new Database(target)
 try {
  expect(t.pragma('user_version', { simple: true })).toBe(71612)
  expect(t.prepare('SELECT id,evidence_query_id q,evidence_relation_id r,previous_id p FROM difference_reason ORDER BY id').all()).toEqual([{id:101,q:11,r:1,p:null},{id:102,q:coordinates.collectionId,r:null,p:101},{id:103,q:null,r:coordinates.observations[0]!.observationId,p:102},{id:104,q:coordinates.collectionId,r:coordinates.observations[0]!.observationId,p:103},{id:105,q:null,r:null,p:104}])
  expect(t.pragma('foreign_key_check')).toEqual([]); expect(t.pragma('integrity_check')).toEqual([{integrity_check:'ok'}])
  expect(t.prepare("SELECT seq FROM sqlite_sequence WHERE name='difference_reason'").get()).toEqual({seq:250})
  expect(t.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='difference_reason' ORDER BY name").all()).toHaveLength(6)
  expect(t.pragma('foreign_key_list(difference_reason)')).toEqual(expect.arrayContaining([expect.objectContaining({from:'evidence_query_id',table:'platform_collection'}),expect.objectContaining({from:'evidence_relation_id',table:'platform_business_observation'}),expect.objectContaining({from:'previous_id',table:'difference_reason'})]))
 } finally { t.close() }
})
it('preserves every PK cell storage class original serialized byte and old ledger through an independent reverse oracle', () => {
 const original = readFileSync(source)
 transferDifferenceReferences({source,target,runId:'bytes749'})
 const s = new Database(source), t = new Database(target)
 try {
  const tables = s.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]
  for (const {name} of tables) {
   const fields = s.prepare(`PRAGMA table_info("${name}")`).all() as {name:string;pk:number}[]
   const order = fields.filter(f=>f.pk).sort((a,b)=>a.pk-b.pk).map(f=>`"${f.name}"`).join(',') || 'rowid'
   const columns = fields.flatMap(f=>[`typeof("${f.name}") AS "k_${f.name}"`,`hex(cast("${f.name}" as blob)) AS "b_${f.name}"`]).join(',')
   const oldRows = s.prepare(`SELECT ${columns} FROM "${name}" ORDER BY ${order}`).all()
   const query = t.prepare(`SELECT ${order==='rowid'?'d.rowid AS __rowid,':''}${fields.map(f => name==='difference_reason'&&f.name==='evidence_query_id'?'(SELECT old_id FROM platform_legacy_query_alias WHERE collection_id=d.evidence_query_id) AS evidence_query_id':name==='difference_reason'&&f.name==='evidence_relation_id'?'(SELECT old_id FROM platform_legacy_relation_alias WHERE observation_id=d.evidence_relation_id) AS evidence_relation_id':`d."${f.name}"`).join(',')} FROM "${name}" d`)
   const rows = t.prepare(`SELECT ${columns} FROM (${query.source}) ORDER BY ${order==='rowid'?'__rowid':order}`).all()
   // The only appended log rows belong to this new run; all old receipts/checkpoints remain byte-identical.
   if (['platform_migration_run','platform_migration_checkpoint'].includes(name)) {
    expect(rows.filter(row=>Reflect.get(row as object,'b_run_id')!==Buffer.from('bytes749').toString('hex').toUpperCase())).toEqual(oldRows)
   } else expect(rows, name).toEqual(oldRows)
  }
  const legacy=new Database(f.legacySource,{readonly:true})
  try {
   expect(legacy.pragma('user_version',{simple:true})).toBe(0)
   for(const name of ['evidence_revision_113','evidence_impact_progress_113','explanation_impact_113','evidence_review_receipt_114']) {
    const fields=legacy.prepare(`PRAGMA table_info(${name})`).all() as {name:string}[]
    const columns=fields.flatMap(c=>[`typeof("${c.name}") AS "k_${c.name}"`,`hex(cast("${c.name}" as blob)) AS "b_${c.name}"`]).join(',')
    expect(t.prepare(`SELECT ${columns} FROM ${name} ORDER BY 1`).all(),name+' entire pipeline').toEqual(legacy.prepare(`SELECT ${columns} FROM ${name} ORDER BY 1`).all())
   }
  } finally {legacy.close()}
  expect(readFileSync(source)).toEqual(original)
  const before=s.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name='difference_reason' ORDER BY type,name").all() as {sql:string|null}[]
  expect(t.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name='difference_reason' ORDER BY type,name").all()).toEqual(before.map(row=>({...row,sql:row.sql?.replace(/REFERENCES\s+([`"]?)platform_query\1/gi,'REFERENCES platform_collection').replace(/REFERENCES\s+([`"]?)platform_relation\1/gi,'REFERENCES platform_business_observation')??null})))
 } finally {s.close();t.close()}
})
it.each(['prepared','dropped','created','copied','indexed','validated','receipt'])('rolls back the whole physical transfer at %s then retries safely', stage => {
 const original = readFileSync(target)
 expect(()=>transferDifferenceReferences({source,target,runId:'rollback749',beforeCommit:at=>{if(at===stage)throw new Error('normal transaction cancellation')}})).toThrow('normal transaction cancellation')
 expect(readFileSync(target)).toEqual(original)
 const t = new Database(target)
 try {expect(t.pragma('foreign_keys',{simple:true})).toBe(1);expect(t.pragma('user_version',{simple:true})).toBe(71611);expect(t.pragma('foreign_key_check')).toEqual([])} finally {t.close()}
 expect(transferDifferenceReferences({source,target,runId:'rollback749'})).toEqual({state:'complete',rows:5,queries:3,relations:3})
})
it('fails with decision PK and original missing query and relation IDs without changing the source copy', () => {
 const src=join(f.root,'missing-71611.sqlite'),dst=join(f.root,'missing-target.sqlite');copyFileSync(source,src)
 const old = new Database(src), db = drizzle(old,{schema})
 db.insert(schema.platformQuery).values({id:999,interface:'business_list',queryKey:'missing',rdjb:'2',queriedAt:'c',status:'success'}).run()
 db.insert(schema.platformRelation).values({id:998,queryId:999,sequenceNo:1}).run()
 db.insert(schema.differenceReason).values({...scope,id:999,evidenceQueryId:999,evidenceRelationId:998,recordedAt:'999'}).run()
 old.close();copyFileSync(src,dst);const bytes=readFileSync(dst)
 expect(()=>transferDifferenceReferences({source:src,target:dst,runId:'missing749'})).toThrow('Unmapped difference rows: [{"id":999,"evidence_query_id":999,"evidence_relation_id":998,"collection_id":null,"observation_id":null}]')
 expect(readFileSync(dst)).toEqual(bytes)
})
it('retains necessary incoming FK owners their indexes and sequence', () => {
 const src=join(f.root,'incoming-71611.sqlite'),dst=join(f.root,'incoming-target.sqlite');copyFileSync(source,src)
 const s=new Database(src)
 s.exec(`CREATE TABLE decision_reference_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,decision_id INTEGER NOT NULL REFERENCES difference_reason(id),evidence TEXT NOT NULL);
 CREATE INDEX decision_reference_idx ON decision_reference_audit(decision_id);
 INSERT INTO decision_reference_audit VALUES(3,104,' { "queryId":8001 } ');
 UPDATE sqlite_sequence SET seq=70 WHERE name='decision_reference_audit';`)
 const before=s.prepare('SELECT * FROM decision_reference_audit').all();s.close();copyFileSync(src,dst)
 transferDifferenceReferences({source:src,target:dst,runId:'incoming749'})
 const t=new Database(dst)
 try {expect(t.prepare('SELECT * FROM decision_reference_audit').all()).toEqual(before);expect(t.prepare("SELECT seq FROM sqlite_sequence WHERE name='decision_reference_audit'").get()).toEqual({seq:70});expect(t.pragma('foreign_key_check')).toEqual([]);expect(t.prepare("SELECT name FROM sqlite_schema WHERE name='decision_reference_idx'").get()).toEqual({name:'decision_reference_idx'})} finally {t.close()}
})
it('runs the actual offline CLI recording schema references integrity sequence and completion', () => {
 const evidence=join(f.root,'cli749')
 const output=execFileSync(process.execPath,['upgrade/run-difference-references.mjs',source,target,evidence,'cli749'],{encoding:'utf8',env:{...process.env,JITI_FS_CACHE:'false'}})
 expect(JSON.parse(output)).toEqual({state:'complete',rows:5,queries:3,relations:3})
 expect(JSON.parse(readFileSync(join(evidence,'receipt.json'),'utf8'))).toMatchObject({target:{phase:71612,foreignKeyCheck:[],integrity:[{integrity_check:'ok'}],counts:{rows:5,queries:3,relations:3}}})
})
it('transfers an empty normal decision table without manufacturing decisions', () => {
 const src=join(f.root,'empty-71611.sqlite'),dst=join(f.root,'empty-target.sqlite');copyFileSync(source,src)
 const old=new Database(src)
 old.exec('DELETE FROM evidence_review_receipt_114; DELETE FROM explanation_impact_113; DELETE FROM evidence_impact_progress_113; DELETE FROM evidence_revision_113')
 // This isolated source has no other decision FK owners; remove newest self-links first.
 for(const id of [105,104,103,102,101])old.prepare('DELETE FROM difference_reason WHERE id=?').run(id)
 old.close();copyFileSync(src,dst)
 expect(transferDifferenceReferences({source:src,target:dst,runId:'empty749'})).toEqual({state:'complete',rows:0,queries:0,relations:0})
 const t=new Database(dst)
 try {expect(t.prepare('SELECT * FROM difference_reason').all()).toEqual([]);expect(t.pragma('foreign_key_check')).toEqual([])} finally {t.close()}
})
