import { impactList114, impactGet114, impactSources114, impactEvents114, impactPreview114, processCommand114, ruleCommand114 } from './evidence-review-114-contract'
import { legacyPreviewInput102 } from './decision-legacy-preview-102'
import { z } from 'zod'
import { decisionCommand102, decisionHistory102, decisionScope102 } from './decision-lifecycle-102/contract'
const contracts = {
  list_evidence_impacts: impactList114, get_evidence_impact: impactGet114, list_evidence_impact_sources: impactSources114, list_evidence_revision_events: impactEvents114, preview_evidence_impacts: impactPreview114, process_evidence_impacts: processCommand114, release_evidence_rule: ruleCommand114,
  preview_legacy_difference_decisions: legacyPreviewInput102,
  save_difference_decision: decisionCommand102,
  get_difference_decision: z.strictObject({ id: z.number().int().positive() }),
  get_current_difference_decision: decisionScope102,
  list_difference_decision_history: decisionHistory102,
}
/** Validate original RPC arguments before the toolkit's object parser strips unknown keys. */
export function decisionRpcError102(body: unknown): Response | null {
  for (const entry of Array.isArray(body) ? body : [body]) {
    const rpc = entry as { method?: string; id?: unknown; params?: { name?: string; arguments?: unknown } } | null
    if (rpc?.method !== 'tools/call' || !Object.hasOwn(contracts, rpc.params?.name ?? '')) continue
    const contract = contracts[rpc.params!.name as keyof typeof contracts]
    if (!contract.safeParse(rpc.params?.arguments).success) return new Response(JSON.stringify({ jsonrpc: '2.0', id: typeof rpc.id === 'string' || typeof rpc.id === 'number' ? rpc.id : null, error: { code: -32602, message: 'Invalid decision lifecycle parameters', data: { code: 'invalid_request' } } }), { status: 400, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  }
  return null
}
