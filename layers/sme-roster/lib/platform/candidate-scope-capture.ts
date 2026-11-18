/** A ingest/offline boundary only. Never call to filter a business read. */
import type Database from 'better-sqlite3'
export const CANDIDATE_SCOPE_RULE = 'current-candidate-scope-v1'
export type CandidateScopeResult = { state: 'captured'; mask: number; error: null } | { state: 'error'; mask: null; error: string }
export type CandidateScopeInput = { rdjb: string; titleCode: string | null; sequenceNo: number; evidence: string | Buffer | null; evidenceStorage?: 'text' | 'blob' | 'null' }
// Frozen candidate-specific SQLite grammar. No JS decoding/coercion of source JSON:
// strict validity, first duplicate key, numeric-text SUM and ordinal are intentional.
const title = (value: string) => `case ${value} when '1' then 'innovative_sme' when '2' then 'specialized_sme' when '3' then 'little_giant' end`
const pages = "json_each(case when json_valid(q.collection_evidence) then json_extract(q.collection_evidence,'$.pages') else '[]' end)"
const effective = `case when instr(q.rdjb,',')=0 then coalesce(q.title_code,${title('q.rdjb')}) else coalesce((select ${title("json_extract(p.value,'$.rdjb')")} from ${pages} p
 where json_extract(p.value,'$.status')='success' and json_extract(p.value,'$.fetchedCount')>0
 and r.sequence_no>coalesce((select sum(json_extract(prev.value,'$.fetchedCount')) from ${pages} prev where cast(prev.key as integer)<cast(p.key as integer) and json_extract(prev.value,'$.status')='success'),0)
 and r.sequence_no<=(select sum(json_extract(prev.value,'$.fetchedCount')) from ${pages} prev where cast(prev.key as integer)<=cast(p.key as integer) and json_extract(prev.value,'$.status')='success')
 order by cast(p.key as integer) limit 1),q.title_code) end`
const predicate = `(${effective}=@title or (${effective} is null and instr(','||q.rdjb||',',','||@code||',')>0))`
export function captureCandidateScope(db: Database.Database, input: CandidateScopeInput): CandidateScopeResult {
  if (!Number.isSafeInteger(input.sequenceNo) || input.sequenceNo < 1) throw new Error('Invalid candidate sequence')
  const statement = db.prepare(`with q(rdjb,title_code,collection_evidence) as (values(@rdjb,@titleCode,case when @storage='text' then cast(@evidence as text) else @evidence end)),r(sequence_no) as (values(@sequenceNo)) select case when ${predicate} then 1 else 0 end member from q,r`)
  try {
    let mask = 0
    for (const [i, value] of ['innovative_sme','specialized_sme','little_giant'].entries()) {
      const row = statement.get({ rdjb:input.rdjb, titleCode:input.titleCode, sequenceNo:input.sequenceNo, evidence:input.evidence, storage:input.evidenceStorage ?? (typeof input.evidence==='string'?'text':input.evidence===null?'null':'blob'), title:value, code:String(i+1) }) as { member: number }
      if (row.member) mask |= 1 << i
    }
    return { state: 'captured', mask, error: null }
  } catch (error) {
    if (error instanceof Error && ['malformed JSON','integer overflow'].includes(error.message)) return { state: 'error', mask: null, error: error.message }
    throw error
  }
}
