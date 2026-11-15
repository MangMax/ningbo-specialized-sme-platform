import type { DecisionDb } from '../../../server/utils/decision-lifecycle-102'
import { saveDecision102 } from '../../../server/utils/decision-lifecycle-102'
import { readEvidenceToken113 } from '../../../server/utils/evidence-impact-113'
import type { schema } from '../../../db/client'
/** Synthetic subject facts must include #108 review, just like public writes.
 * Evidence-linked and legacy fixtures deliberately remain unreviewed unless the test reviews them.
 */
export function reviewCurrentExportDecision(db: DecisionDb, decision: typeof schema.differenceReason.$inferSelect) {
  if (decision.lifecycleAction !== 'replace' || !decision.basis || !decision.effectiveAt || decision.evidenceCollectionId || decision.evidenceObservationId) return
  const scope={enterpriseId:decision.enterpriseId,titleCode:decision.titleCode as 'little_giant'|'specialized_sme'|'innovative_sme',direction:decision.direction as 'extra_in_miit'|'missing_in_miit'}
  const token=readEvidenceToken113(db,scope)
  saveDecision102(db,{...scope,action:'maintain',expectedCurrentId:decision.id,idempotencyKey:'fixture-reviewed-'+decision.id,actor:{type:'agent',id:'synthetic-export'},basis:decision.basis,ruleVersion:'synthetic-export',effectiveAt:decision.effectiveAt,reviewedEvidence:{latestRevisionId:token.latestRevisionId,projectionReady:true}})
}

/** Complete typed exclusion fixture through the same preflight/commit contract as users. */
export async function confirmCurrentExportExclusion(baseUrl: string, headers: Record<string,string>, enterpriseId: number, key: string, kind: 'moved_out'|'cancelled' = 'moved_out') {
  const root = `${baseUrl}/api/roster/enterprises/${enterpriseId}/facts`
  const read = await fetch(root, { headers })
  if (read.status !== 200) throw new Error('typed exclusion fixture read failed: ' + read.status)
  let version = (await read.json()).version
  async function commit(change: object, suffix: string) {
    const request = { expectedVersion: version, idempotencyKey: `${key}-${suffix}`, actor: { type: 'agent', id: 'synthetic-export' }, basis: '合成正式通知逐项核实', ...change }
    const preflight = await fetch(root+'/preflight', {method:'POST',headers,body:JSON.stringify(request)})
    if (preflight.status !== 200) throw new Error('typed exclusion fixture preflight failed: ' + preflight.status)
    const plan = await preflight.json()
    const response = await fetch(root+'/commit', {method:'POST',headers,body:JSON.stringify({request,planHash:plan.planHash})})
    if (response.status !== 200) throw new Error('typed exclusion fixture commit failed: ' + response.status)
    const result = await response.json()
    const updated = await fetch(root, {headers})
    if (updated.status !== 200) throw new Error('typed exclusion fixture readback failed: ' + updated.status)
    version = (await updated.json()).version
    return result
  }
  const asserted = await commit({action:'assert',fact:{kind,source:{reference:'synthetic:export:'+key,statement:kind === 'moved_out' ? '正式通知明确迁出宁波' : '正式通知明确注销'},observed:{precision:'day',value:'2026-01-01'},effective:{precision:'day',value:'2025-01-01'},...(kind === 'moved_out' ? {city:null} : {})}},'assert')
  await commit({action:'confirm',factId:asserted.factId},'confirm')
  return asserted.factId as number
}
