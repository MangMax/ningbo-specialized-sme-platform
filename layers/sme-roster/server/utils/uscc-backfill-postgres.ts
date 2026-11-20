import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { backfillPostgresEnterpriseUscc, lockPostgresReviewedEnterpriseBatch, postgresCanonicalEnterpriseId } from '../../../core/server/public'
import { normalizeName, normalizeUscc } from '../../lib/domain'
import { missingUsccSourceFields, usccFormatVerdict } from '../../lib/roster/uscc-research'
import type { RosterImportItemResult, RosterImportUsccBackfill } from '../../lib/roster-import-client'
import { capturePostgresIdentityChange, readPostgresIdentityMaterial } from './postgres-identity-evidence'
import type { NativeImportExecution, PostgresImportAction, PostgresImportBatch } from './roster-export-import-postgres'

type Reader = Pick<NodePgDatabase,'execute'>
type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Subject = { id:number; name:string; nameNorm:string; uscc:string | null; flags:string[] | null }
type Change = { target:Subject; backfill:RosterImportUsccBackfill; uscc:string; ref:string }
const emptySummary = { written:0,skipped:0,failed:0,evidenceRepointed:0 }
const optionalText = (value: unknown) => typeof value === 'string' ? value.trim() || null : null
const subject = sql`id::float8 AS id,name,name_norm AS "nameNorm",uscc_norm AS uscc,quality_flags::json AS flags`
const failure = (ref:string,code:string,message:string,field:string): RosterImportItemResult =>
  ({ kind:'uscc_backfill',ref,ok:false,error:{code,message,field} })

async function planBackfill(db: Reader, input: RosterImportUsccBackfill, index: number): Promise<Change | RosterImportItemResult> {
  const ref = 'uscc_backfill:'+index
  const uscc = normalizeUscc(input?.uscc)
  const verdict = usccFormatVerdict(input?.uscc)
  if (verdict!=='ok') {
    const why = verdict==='length' ? '长度不是 18 位' : verdict==='charset' ? '含字符集外的字符' : '校验位不符'
    return failure(ref,'uscc_format_invalid',`统一社会信用代码不合法（${why}）：${String(input?.uscc ?? '(空)')}`,'uscc')
  }
  const missing = missingUsccSourceFields(input.source)
  if (missing.length) return failure(ref,'source_evidence_incomplete',`补录缺少可复核的公开来源证据：${missing.join('、')}`,'source')
  const requested = typeof input.enterpriseId === 'number' && Number.isFinite(input.enterpriseId)
    ? Math.trunc(input.enterpriseId) : null
  const name = optionalText(input.enterpriseName)
  if (requested == null && !name) return failure(ref,'enterprise_required','补录缺少 enterpriseId 或 enterpriseName','enterpriseId')
  let target: Subject | undefined
  if (requested != null) {
    const id = Number.isSafeInteger(requested) ? await postgresCanonicalEnterpriseId(db,requested) : null
    target = id === null ? undefined : (await db.execute<Subject>(sql`SELECT ${subject} FROM enterprise WHERE id=${id}`)).rows[0]
    if (target && name && normalizeName(name)!==target.nameNorm) {
      return failure(ref,'enterprise_selector_conflict',`enterpriseId=${requested} 的名称与给定 enterpriseName 不一致`,'enterpriseName')
    }
  } else {
    const { rows } = await db.execute<Subject>(sql`SELECT ${subject} FROM enterprise e
      WHERE e.name_norm=${normalizeName(name)} AND NOT EXISTS(SELECT 1 FROM enterprise_merge m WHERE m.from_enterprise_id=e.id) ORDER BY id`)
    if (rows.length>1) return failure(ref,'enterprise_ambiguous',`同名企业有 ${rows.length} 家（${rows.map(row=>row.id).join('、')}）⇒ 同名多主体，不猜是哪一家`,'enterpriseName')
    target = rows[0]
  }
  if (!target) return failure(ref,'enterprise_not_found',`补录找不到归属企业：${requested ?? name}`,'enterpriseId')
  if (target.uscc) return failure(ref,'uscc_already_present',`企业 ${target.id} 已有统代 ${target.uscc} ⇒ 只补缺失值，不覆盖`,'uscc')
  const { rows:[holder] } = await db.execute<{ id:number; name:string }>(sql`
    SELECT id::float8 AS id,name FROM enterprise WHERE uscc_norm=${uscc} AND id<>${target.id}`)
  if (holder) return failure(ref,'uscc_taken',`统代 ${uscc} 已被企业 ${holder.id}「${holder.name}」占用 ⇒ 冲突，不覆盖、不自动合并身份`,'uscc')
  return { ref,target,backfill:input,uscc }
}

function item({target,backfill,uscc}: Change): RosterImportItemResult {
  return { ok:true,kind:'uscc_backfill',ref:`uscc_backfill:${target.id}->${uscc}`,
    detail:{enterpriseId:target.id,enterpriseName:target.name,uscc,sourceUrl:optionalText(backfill.source.url)} }
}

class BackfillConflict extends Error {
  constructor(readonly results: RosterImportItemResult[]) { super('uscc_backfill_conflict') }
}

export async function executePostgresUsccBackfillItems(tx: Tx,batch:PostgresImportBatch,action:PostgresImportAction,
  changes: readonly RosterImportUsccBackfill[]): Promise<NativeImportExecution> {
  const plans = []
  for (const [index,input] of changes.entries()) plans.push(await planBackfill(tx,input,index))
  const conflicts = plans.filter((entry): entry is RosterImportItemResult => 'ok' in entry)
  const ready = plans.filter((entry): entry is Change => !('ok' in entry))
  const preflight = { add:0,update:ready.length,remove:0,review:0,conflicts,evidenceRepoints:0,batchStatus:batch.status }
  if (action==='preflight') return { preflight }
  if (conflicts.length) return { preflight,items:plans.map(plan=>'ok' in plan ? plan : item(plan)),
    summary:{ ...emptySummary,failed:conflicts.length },error:`批次校验未通过：${conflicts.length} 项有误，未写入任何数据` }
  await lockPostgresReviewedEnterpriseBatch(tx,ready.map(change=>change.target.id),ready.map(change=>({uscc:change.uscc})))
  try {
    const items = await tx.transaction(async nested=>{
      const results: RosterImportItemResult[] = []
      for (const [index,original] of ready.entries()) {
        const plan = await planBackfill(nested,original.backfill,index)
        if ('ok' in plan) throw new BackfillConflict([...results,plan])
        if (plan.target.id!==original.target.id) throw new BackfillConflict([...results,
          failure(plan.ref,'enterprise_selector_conflict','补录归属企业已变更，请重新核对','enterpriseId')])
        const { target,uscc,backfill } = plan
        const before = await readPostgresIdentityMaterial(nested,target.id)
        await backfillPostgresEnterpriseUscc(nested,target.id,uscc,target.flags ?? [])
        await capturePostgresIdentityChange(nested,target.id,'uscc:'+uscc,before)
        results.push({ ok:true,kind:'uscc_backfill',ref:item(plan).ref,detail:{ enterpriseId:target.id,uscc,rowsWritten:1,
          lineage:{ enterpriseId:target.id,enterpriseName:target.name,uscc,previousUscc:null,source:backfill.source,note:optionalText(backfill.note) } } })
      }
      return results
    })
    return { preflight,items,summary:{ ...emptySummary,written:items.length },error:null }
  } catch (error) {
    if (!(error instanceof BackfillConflict)) throw error
    const items = [...error.results.map(row=>row.ok ? { ...row,ok:false,error:{code:'commit_rolled_back',message:'整批回滚，本项未写入'} } : row),
      ...ready.slice(error.results.length).map(plan=>({ ...item(plan),ok:false,error:{code:'not_executed',message:'整批回滚，本项未执行'} }))]
    return { preflight,items,summary:{ ...emptySummary,failed:items.length },error:'批次执行阶段有项失败（已整批回滚，未写入任何数据）' }
  }
}
