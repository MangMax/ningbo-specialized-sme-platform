import { semanticRouteHandler } from '../../layers/core/server/utils/core-route'
import { getHeader, getMethod, getQuery, getRouterParam, readBody, setHeader, setResponseStatus, type H3Event } from 'h3'
import { useDb } from '@db'
import { handleComparisonScopeProofRequest, type ProofAction } from './comparison-scope-proof-api'

export function comparisonScopeProofRoute(action: ProofAction, option: 'id' | 'key' | null = null) {
  return semanticRouteHandler(`maintenance.proof.${action}`, async (event: H3Event) => {
    setHeader(event, 'cache-control', 'no-store')
    let body: unknown
    if (['preflight', 'commit'].includes(action)) {
      try { body = await readBody(event) }
      catch { setResponseStatus(event, 400); return { error: { code: 'invalid_request', message: 'Invalid JSON body' } } }
    }
    const output = handleComparisonScopeProofRequest({ action, method: getMethod(event), body, query: getQuery(event), id: option === 'id' ? getRouterParam(event, 'id') : undefined, key: option === 'key' ? getRouterParam(event, 'idempotencyKey') : undefined, headers: { authorization: getHeader(event, 'authorization'), 'x-api-token': getHeader(event, 'x-api-token') } }, { db: useDb(), apiToken: useRuntimeConfig().apiToken })
    setResponseStatus(event, output.status)
    for (const [name, value] of Object.entries(output.headers)) setHeader(event, name, value)
    return output.body
  })
}
