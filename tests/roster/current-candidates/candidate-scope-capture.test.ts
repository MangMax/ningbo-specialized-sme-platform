import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { captureCandidateScope } from '../../../lib/platform/candidate-scope-capture'
import { relationScopeSql } from '../../../upgrade/frozen/current-platform-scope'

it.each([
  ['strict', '{"pages":[{"status":"success","rdjb":"2","fetchedCount":1}]}', 2],
  ['json5', "{pages:[{status:'success',rdjb:'2',fetchedCount:1}]}", 3],
  ['text count', '{"pages":[{"status":"success","rdjb":"2","fetchedCount":"1"}]}', 2],
  ['null count', '{"pages":[{"status":"success","rdjb":"2","fetchedCount":null}]}', 3],
])('captures literal and independent old scope for %s', (_name, evidence, mask) => {
  const db = new Database(':memory:')
  try {
    const input = { rdjb: '1,2', titleCode: null, sequenceNo: 1, evidence }
    const result = captureCandidateScope(db, input)
    expect(result).toEqual({ state: 'captured', mask, error: null })
    const oracle = db.prepare(`with q(rdjb,title_code,collection_evidence) as (values('1,2',NULL,@evidence)),r(sequence_no) as (values(1)) select case when ${relationScopeSql} then 1 else 0 end member from q,r`)
    const membership = ['innovative_sme', 'specialized_sme', 'little_giant'].map((title, i) => {
      const row = oracle.get({ evidence, title, rdjb: String(i + 1) }) as { member: number }
      return row.member
    })
    expect(membership).toEqual([Number(Boolean(mask & 1)), Number(Boolean(mask & 2)), Number(Boolean(mask & 4))])
  } finally { db.close() }
})

it.each([
  ['single explicit title wins', '1', 'little_giant', 1, null, 4],
  ['single code', '2', null, 1, null, 2],
  ['captured zero differs from unknown', '9', null, 1, null, 0],
  ['missing original evidence', '1,2', null, 1, null, 3],
  ['invalid evidence', '1,2', null, 1, 'invalid', 3],
  ['empty pages fallback title', '1,2', 'little_giant', 1, '{"pages":[]}', 4],
  ['success ordinal ignores missing page number', '1,2,3', null, 2, '{"pages":[{"status":"success","rdjb":"2","fetchedCount":1},{"status":"success","rdjb":"3","fetchedCount":1}]}', 4],
  ['failed rows contribute no prefix', '1,2,3', null, 1, '{"pages":[{"status":"failed","rdjb":"1","fetchedCount":99},{"status":"success","rdjb":"2","fetchedCount":1}]}', 2],
  ['zero success ignored', '1,2,3', null, 1, '{"pages":[{"status":"success","rdjb":"1","fetchedCount":0},{"status":"success","rdjb":"3","fetchedCount":1}]}', 4],
  ['REAL prefix retained', '1,2,3', null, 1, '{"pages":[{"status":"success","rdjb":"2","fetchedCount":0.5},{"status":"success","rdjb":"3","fetchedCount":1}]}', 4],
  ['negative prefix retained', '1,2,3', null, 1, '{"pages":[{"status":"success","rdjb":"2","fetchedCount":-1},{"status":"success","rdjb":"3","fetchedCount":2}]}', 4],
  ['NULL prefix ignored', '1,2,3', null, 1, '{"pages":[{"status":"success","rdjb":"2","fetchedCount":null},{"status":"success","rdjb":"3","fetchedCount":1}]}', 4],
  ['duplicate key uses first page title', '1,2,3', null, 1, '{"pages":[{"status":"success","rdjb":"2","rdjb":"3","fetchedCount":1}]}', 2],
  ['duplicate pages key uses first array', '1,2,3', null, 1, '{"pages":[{"status":"success","rdjb":"2","fetchedCount":1}],"pages":[{"status":"success","rdjb":"3","fetchedCount":1}]}', 2],
  ['unrecognized page title falls back', '1,2,3', 'little_giant', 1, '{"pages":[{"status":"success","rdjb":"9","fetchedCount":1}]}', 4],
] as const)('preserves candidate SQLite literal boundary: %s', (_name, rdjb, titleCode, sequenceNo, evidence, mask) => {
  const db = new Database(':memory:')
  try {
    expect(captureCandidateScope(db, { rdjb, titleCode, sequenceNo, evidence })).toEqual({ state:'captured', mask, error:null })
    const oracle = db.prepare(`with q(rdjb,title_code,collection_evidence) as (values(@queryCode,@titleCode,@evidence)),r(sequence_no) as (values(@sequenceNo)) select case when ${relationScopeSql} then 1 else 0 end member from q,r`)
    const membership = ['innovative_sme','specialized_sme','little_giant'].map((title, i) => {
      return (oracle.get({ queryCode:rdjb, titleCode, sequenceNo, evidence, title, rdjb:String(i+1) }) as {member:number}).member
    })
    expect(membership).toEqual([Number(Boolean(mask&1)),Number(Boolean(mask&2)),Number(Boolean(mask&4))])
  } finally { db.close() }
})
it('captures the old malformed page error rather than a zero or fallback mask', () => {
  const db=new Database(':memory:')
  const evidence='{"pages":["oops"]}'
  try {
    expect(captureCandidateScope(db,{rdjb:'1,2',titleCode:null,sequenceNo:1,evidence})).toEqual({state:'error',mask:null,error:'malformed JSON'})
    expect(()=>db.prepare(`with q(rdjb,title_code,collection_evidence) as (values('1,2',NULL,@evidence)),r(sequence_no) as (values(1)) select ${relationScopeSql} from q,r`).get({title:'innovative_sme',rdjb:'1',evidence})).toThrow('malformed JSON')
  } finally { db.close() }
})
