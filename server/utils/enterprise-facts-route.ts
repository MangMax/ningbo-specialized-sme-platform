import { getRouterParam, readBody, setHeader } from 'h3'
import { useDb } from '@db'
import { semanticRouteHandler } from './core-route'
import { requireApiToken } from './api-guard'
import { EnterpriseProfileError } from './enterprise-profile'
import { getEnterpriseFacts, preflightEnterpriseFact, commitEnterpriseFact } from './enterprise-facts'
export function enterpriseFactsRoute(action: 'get' | 'preflight' | 'commit') {
  return semanticRouteHandler(`maintenance.enterprise_facts.${action}`, async event => {
    setHeader(event, 'cache-control', 'no-store')
    if (action !== 'get') requireApiToken(event)
    try {
      const raw = getRouterParam(event, 'id') ?? '', id = /^\d+$/.test(raw) ? Number(raw) : NaN
      if (!Number.isSafeInteger(id) || id < 1) throw new EnterpriseProfileError(400, 'invalid_request', 'Positive enterprise ID required')
      if (action === 'get') return getEnterpriseFacts(useDb(), id)
      let body: unknown
      try { body = await readBody(event) } catch { throw new EnterpriseProfileError(400, 'invalid_request', 'Malformed JSON') }
      return action === 'preflight' ? preflightEnterpriseFact(useDb(), id, body) : commitEnterpriseFact(useDb(), id, body)
    } catch (error) {
      if (error instanceof EnterpriseProfileError) { event.node.res.statusCode = error.statusCode; return { error: { code: error.code, message: error.message } } }
      throw error
    }
  })
}
