import { preflightRuntimeEnterpriseFact, commitRuntimeEnterpriseFact } from './enterprise-facts-runtime'
import { getRouterParam, readBody, setHeader, setResponseStatus } from 'h3'
import { enterpriseFactCommandSchema } from './enterprise-facts'
import { EnterpriseProfileError } from './enterprise-profile'
import { checkBrowserReviewRequest } from './browser-review-102'
import { z } from 'zod'
// Names the real server adapter, never a purported logged-in person.
const actor = { type: 'agent' as const, id: 'same-origin-enterprise-facts-adapter' }
const [assert, confirm, withdraw, replace] = enterpriseFactCommandSchema.options
const business = z.discriminatedUnion('action', [assert.omit({ actor: true }), confirm.omit({ actor: true }), withdraw.omit({ actor: true }), replace.omit({ actor: true })])
const commit = z.strictObject({ request: business, planHash: z.string().regex(/^[a-f0-9]{64}$/) })
export function browserEnterpriseFactsRoute(action: 'preflight' | 'commit') {
  return defineEventHandler(async event => {
    setHeader(event, 'cache-control', 'no-store')
    const gate = checkBrowserReviewRequest(event, { write: true })
    if (!gate.ok) { setResponseStatus(event, gate.status); return { error: { code: gate.code, message: gate.message } } }
    try {
      const id = Number(getRouterParam(event, 'id'))
      if (!Number.isSafeInteger(id) || id < 1) throw new EnterpriseProfileError(400, 'invalid_request', 'Invalid enterprise')
      const input = (action === 'commit' ? commit : business).safeParse(await readBody(event))
      if (!input.success) throw new EnterpriseProfileError(400, 'invalid_request', 'Invalid fact command')
      const body = input.data
      if ('request' in body) return await commitRuntimeEnterpriseFact(id, { request: { ...body.request, actor }, planHash: body.planHash })
      return await preflightRuntimeEnterpriseFact(id, { ...body, actor })
    } catch (error) {
      if (error instanceof EnterpriseProfileError) { setResponseStatus(event, error.statusCode); return { error: { code: error.code, message: error.message } } }
      throw error
    }
  })
}
