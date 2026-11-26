import { readRuntimeEnterpriseFacts, preflightRuntimeEnterpriseFact, commitRuntimeEnterpriseFact } from './enterprise-facts-runtime'
import { getRouterParam, readBody, setHeader, setResponseStatus } from 'h3'
import { semanticRouteHandler } from '../../../core/server/utils/core-route'
import { requireApiToken } from '../../../core/server/utils/api-guard'
import { EnterpriseProfileError } from './enterprise-profile-model'

export function enterpriseFactsRoute(action: 'get' | 'preflight' | 'commit') {
  return semanticRouteHandler(`maintenance.enterprise_facts.${action}`, async event => {
    setHeader(event, 'cache-control', 'no-store')
    if (action !== 'get') requireApiToken(event)
    try {
      const raw = getRouterParam(event, 'id') ?? '', id = /^\d+$/.test(raw) ? Number(raw) : NaN
      if (!Number.isSafeInteger(id) || id < 1) throw new EnterpriseProfileError(400, 'invalid_request', 'Positive enterprise ID required')
      if (action === 'get') return await readRuntimeEnterpriseFacts(id)
      let body: unknown
      try { body = await readBody(event) } catch { throw new EnterpriseProfileError(400, 'invalid_request', 'Malformed JSON') }
      return action === 'preflight' ? await preflightRuntimeEnterpriseFact(id, body) : await commitRuntimeEnterpriseFact(id, body)
    } catch (error) {
      if (error instanceof EnterpriseProfileError) { setResponseStatus(event, error.statusCode); return { error: { code: error.code, message: error.message } } }
      throw error
    }
  })
}
