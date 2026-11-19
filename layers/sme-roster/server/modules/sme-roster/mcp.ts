import { dispositionSchemas, dispositionToolActions } from '../../utils/title-cycle-disposition-protocol'
import { officialEvidenceRpcError } from '../../utils/official-evidence-read'
import { decisionRpcError102 } from '../../utils/decision-lifecycle-102-mcp'
import { qualificationPreflight102, qualificationCommit102 } from '../../utils/decision-lifecycle-102'
import { parseRpcError105 } from '../../utils/parse-maintenance-105-rpc'
import { admitEnterpriseResponse } from '../../utils/enterprise-read-response'
import { eventCorrectionRpcError } from '../../utils/mcp-event-correction'
import { platformQueryRpcError } from '../../utils/mcp-platform-query'
import { currentQualifiedRpcError } from '../../utils/current-qualified-filter'
import type { H3Event } from 'h3'

function inputSchema(name: string | undefined) {
  if (name && name in dispositionToolActions) {
    return dispositionSchemas[dispositionToolActions[name as keyof typeof dispositionToolActions]]
  }
  if (name === 'preflight_qualification_decision') return qualificationPreflight102
  if (name === 'commit_qualification_decision') return qualificationCommit102
}

function validateRequest(body: { method?: string; params?: { name?: string } } | undefined, authorized: boolean, event: H3Event) {
  const official = officialEvidenceRpcError(body, authorized)
  if (official) return official
  const qualified = currentQualifiedRpcError(body)
  if (qualified) return qualified
  const name = body?.params?.name
  if (body?.method === 'tools/call' && name && ['list_enterprises', 'get_enterprise_detail', 'list_current_qualified_enterprises'].includes(name)) {
    admitEnterpriseResponse(event)
  }
  return decisionRpcError102(body) ?? parseRpcError105(body) ?? eventCorrectionRpcError(body) ?? platformQueryRpcError(body)
}

function authorizeTool(name: string | undefined, input: unknown, authorized: boolean) {
  // These otherwise public tools have an additional protected read projection.
  if (['get_roster_evidence', 'get_official_event'].includes(name ?? '') && input && typeof input === 'object' && 'official' in input && !authorized) {
    throw Object.assign(new Error(JSON.stringify({error:{code:'unauthorized',message:'Configured MCP token required'}})),{code:'unauthorized',statusCode:401})
  }
}

export const rosterMcp = { inputSchema, validateRequest, authorizeTool }
