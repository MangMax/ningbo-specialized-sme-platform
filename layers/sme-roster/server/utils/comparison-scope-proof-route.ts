import { semanticRouteHandler } from '../../../core/server/utils/core-route'
import { getHeader, getMethod, getQuery, getRouterParam, readBody, setHeader, setResponseStatus, type H3Event } from 'h3'
import { useDb } from '@db'
import { handleComparisonScopeProofRequest, handleRuntimeComparisonProof, type ProofAction, type ProofApiInput } from './comparison-scope-proof-api'

export function comparisonScopeProofRoute(action: ProofAction, option: 'id' | 'key' | null = null) {
  return semanticRouteHandler(`maintenance.proof.${action}`, async (event: H3Event) => {
    setHeader(event, 'cache-control', 'no-store')
    let body: unknown
    if (['preflight', 'commit'].includes(action)) {
      try { body = await readBody(event) }
      catch { setResponseStatus(event, 400); return { error: { code: 'invalid_request', message: 'Invalid JSON body' } } }
    }
    const input: ProofApiInput = { action, method: getMethod(event), body, query: getQuery(event), id: option === 'id' ? getRouterParam(event, 'id') : undefined, key: option === 'key' ? getRouterParam(event, 'idempotencyKey') : undefined, headers: { authorization: getHeader(event, 'authorization'), 'x-api-token': getHeader(event, 'x-api-token') } }
    const apiToken = useRuntimeConfig().apiToken
    const output = await handleRuntimeComparisonProof(input, apiToken)
      ?? handleComparisonScopeProofRequest(input, { db: useDb(), apiToken })
    setResponseStatus(event, output.status)
    for (const [name, value] of Object.entries(output.headers)) setHeader(event, name, value)
    return output.body
  })
}
