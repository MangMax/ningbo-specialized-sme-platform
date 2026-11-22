import { type ProofAction, type ProofApiInput } from './comparison-scope-proof-api'
import { handleRuntimeComparisonProof } from './comparison-scope-proof-runtime'

export async function dispatchComparisonScopeProofMcp(action: ProofAction, args: Record<string, unknown>, context: { authorized?: boolean } = {}) {
  const write = ['preflight', 'commit', 'batch'].includes(action)
  const input: ProofApiInput = { action, method: ['preflight', 'commit'].includes(action) ? 'POST' : 'GET', body: args, query: action === 'list' ? args : action === 'audit' ? { page: args.page, pageSize: args.pageSize } : undefined, id: args.id, key: args.idempotencyKey, headers: write && context.authorized ? { authorization: 'Bearer mcp-internal-authorized' } : undefined }
  const apiToken = write ? 'mcp-internal-authorized' : null
  const output = await handleRuntimeComparisonProof(input, apiToken)
  if (output.status !== 200) {
    const error = (output.body as { error: { code: string; message: string } }).error
    throw Object.assign(new Error(error.message), { code: error.code, statusCode: output.status })
  }
  return output.body
}
