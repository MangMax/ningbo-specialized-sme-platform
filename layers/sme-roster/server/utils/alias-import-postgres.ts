import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { insertPostgresEnterpriseAlias, lockPostgresReviewedEnterpriseBatch, postgresCanonicalEnterpriseId } from '../../../core/server/public'
import { normalizeName, normalizeUscc } from '../../lib/domain'
import type { RosterImportAlias, RosterImportItemResult } from '../../lib/roster-import-client'
import { replayOptionalString as text } from '../../lib/platform/query-replay'
import { capturePostgresIdentityChange, readPostgresIdentityMaterial } from './postgres-identity-evidence'
import { findPostgresImportRelation, findPostgresImportRelationById } from './roster-import-references-postgres'
import type { NativeImportExecution, PostgresImportAction, PostgresImportBatch } from './roster-export-import-postgres'

type Reader = Pick<NodePgDatabase,'execute'>
type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Subject = { id:number; uscc:string | null }
type AliasPlan = { enterpriseId:number; name:string; nameNorm:string; sourceRefId:number;
  input:RosterImportAlias; existingId:number | null; ref:string }
const summary = { written:0,skipped:0,failed:0,evidenceRepointed:0 }
const sourceKinds = new Set(['platform_business','platform_apply','announcement','manual'])

async function resolveAliasOwner(db: Reader, nameNorm:string | null, uscc:string, platform:boolean) {
  const { rows } = await db.execute<Subject>(sql`SELECT e.id::float8 AS id,e.uscc_norm AS uscc FROM enterprise e
    WHERE (e.uscc_norm=${uscc || null} OR e.name_norm=${nameNorm})
    AND NOT EXISTS(SELECT 1 FROM enterprise_merge m WHERE m.from_enterprise_id=e.id)
    ORDER BY e.id`)
  const byCode = uscc ? rows.find(row=>row.uscc===uscc) : undefined
  const ambiguity = !uscc && platform && rows.length>1 ? rows.length : 0
  return { selected:byCode ?? (platform && uscc ? undefined : rows[0]),ambiguity }
}

async function planAlias(db: Reader, input: RosterImportAlias,index:number): Promise<AliasPlan | RosterImportItemResult> {
  const ref = 'alias:'+index
  const fail = (code:string,message:string,field:string):RosterImportItemResult => ({ok:false,kind:'alias',ref,error:{code,message,field}})
  const name = text(input?.name)
  if (!name) return fail('alias_name_required','别名缺少 name','aliases[].name')
  if (!sourceKinds.has(input.sourceKind)) return fail('alias_source_kind_unknown','sourceKind 不在字典内：'+input.sourceKind,'sourceKind')
  if (input.verificationStatus!=null && !['confirmed','pending'].includes(input.verificationStatus)) {
    return fail('verification_status_unknown','verificationStatus 必须是 confirmed / pending','verificationStatus')
  }
  const literal = typeof input.sourceRefId==='number' && Number.isFinite(input.sourceRefId) ? Math.trunc(input.sourceRefId) : null
  const useRelation = input.sourceRelationRef!=null
  if (literal!==null && useRelation) return fail('source_ref_conflict','同时给了 sourceRefId 与 sourceRelationRef；请只给其一','sourceRelationRef')
  const natural = useRelation ? await findPostgresImportRelation(db,input.sourceRelationRef,'aliases[].sourceRelationRef') : null
  if (natural && !natural.ok) return fail(natural.error.code,natural.error.message,natural.error.field)
  const sourceRefId = natural?.value.id ?? literal ?? 0
  const platform = input.sourceKind==='platform_apply' || input.sourceKind==='platform_business'
  const uscc = normalizeUscc(input.uscc)
  const enterpriseName = text(input.enterpriseName)
  const {selected,ambiguity} = await resolveAliasOwner(db,enterpriseName ? normalizeName(enterpriseName) : null,uscc,platform)
  if (ambiguity) return fail('enterprise_ambiguous',`同名归属企业有 ${ambiguity} 个候选 ⇒ 不猜是哪一家`,'enterpriseName')
  if (!selected) {
    if (platform && uscc) return fail('enterprise_not_found',`统代 ${uscc} 不存在且本批不创建该企业`,'uscc')
    return fail('enterprise_not_found',`别名找不到归属企业：${enterpriseName ?? (uscc || '(空)')}`,'enterpriseName')
  }
  if (platform) {
    const evidence = natural?.value ?? (sourceRefId!==0 && Number.isSafeInteger(sourceRefId) ? await findPostgresImportRelationById(db,sourceRefId) : null)
    if (sourceRefId!==0 && !evidence) return fail('alias_source_evidence_mismatch',`平台关系 id=${sourceRefId} 不存在`,'sourceRefId')
    if (!evidence && input.verificationStatus==='confirmed') {
      return fail('alias_source_evidence_required','confirmed 平台别名必须引用支持该统一社会信用代码与 qymc 的平台关系','sourceRefId')
    }
    if (evidence) {
      const field = useRelation ? 'sourceRelationRef' : 'sourceRefId'
      const expected = input.sourceKind==='platform_business' ? 'business_list' : 'apply_list'
      if (evidence.interface!==expected || !selected.uscc || normalizeUscc(evidence.usccRaw)!==selected.uscc || evidence.nameRaw!==name) {
        return fail('alias_source_evidence_mismatch','平台关系的接口、统一社会信用代码或 qymc 与该别名不一致',field)
      }
      if (evidence.enterpriseId!==null && await postgresCanonicalEnterpriseId(db,evidence.enterpriseId)!==selected.id) {
        return fail('alias_source_evidence_mismatch','平台关系已归属的企业与该别名归属企业不一致',field)
      }
    }
  }
  const nameNorm = normalizeName(name)
  const { rows:[existing] } = literal===null ? { rows:[] } : await db.execute<{id:number}>(sql`
    SELECT id::float8 AS id FROM enterprise_alias WHERE enterprise_id=${selected.id} AND name_norm=${nameNorm}
      AND source_kind=${input.sourceKind} AND source_ref_id=${sourceRefId}`)
  return { enterpriseId:selected.id,name,nameNorm,sourceRefId,input,existingId:existing?.id ?? null,ref }
}

function view(plan:AliasPlan):RosterImportItemResult {
  return { ok:true,kind:'alias',ref:plan.existingId===null ? plan.ref : 'alias:'+plan.existingId,detail:{enterpriseId:plan.enterpriseId} }
}

export async function executePostgresAliasItems(tx: Tx,batch:PostgresImportBatch,action:PostgresImportAction,
  aliases: readonly RosterImportAlias[]): Promise<NativeImportExecution> {
  const collect = async () => {
    const rows: Array<Awaited<ReturnType<typeof planAlias>>> = []
    for (const [index,input] of aliases.entries()) rows.push(await planAlias(tx,input,index))
    return rows
  }
  let plans = await collect()
  const planned = plans.filter((plan):plan is AliasPlan=>!('ok' in plan))
  if (action==='commit' && planned.length===plans.length) {
    const ids = planned.map(plan=>plan.enterpriseId)
    await lockPostgresReviewedEnterpriseBatch(tx,ids,planned.map(plan=>({name:plan.name,uscc:normalizeUscc(plan.input.uscc) || null})))
    const verified = await collect()
    plans = verified.map((plan,index)=>'ok' in plan || plan.enterpriseId===ids[index] ? plan
      : {ok:false,kind:'alias',ref:plan.ref,error:{code:'enterprise_changed',field:'enterpriseName',message:'别名归属企业已变更，请重新核对'}})
  }
  const ready = plans.filter((plan):plan is AliasPlan=>!('ok' in plan))
  const conflicts = plans.filter((plan):plan is RosterImportItemResult=>'ok' in plan)
  const preflight = { add:ready.filter(plan=>plan.existingId===null).length,update:0,remove:0,
    review:ready.filter(plan=>plan.input.verificationStatus!=='confirmed').length,conflicts,evidenceRepoints:0,batchStatus:batch.status }
  if (action==='preflight') return {preflight}
  if (conflicts.length) return {preflight,items:plans.map(plan=>'ok' in plan ? plan : view(plan)),
    summary:{...summary,failed:conflicts.length},error:`批次校验未通过：${conflicts.length} 项有误，未写入任何数据`}
  let written = 0
  const items: RosterImportItemResult[] = []
  for (const {enterpriseId,name,nameNorm,sourceRefId,input} of ready) {
    const before = await readPostgresIdentityMaterial(tx,enterpriseId)
    const { id,created } = await insertPostgresEnterpriseAlias(tx,{
      enterpriseId,name,nameNorm,sourceKind:input.sourceKind,sourceRefId,
      validFrom:text(input.validFrom),validTo:text(input.validTo),verificationStatus:input.verificationStatus ?? 'pending',note:text(input.note),
    })
    if (created) {
      await capturePostgresIdentityChange(tx,enterpriseId,'alias-import:'+id,before)
      written++
    }
    items.push({ok:true,kind:'alias',ref:'alias:'+id,detail:{enterpriseId,rowsWritten:Number(created),...(created ? {sourceRefId} : {})}})
  }
  return {preflight,items,summary:{...summary,written,skipped:items.length-written},error:null}
}
