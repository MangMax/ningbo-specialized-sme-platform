import { semanticRouteHandler } from '../../../core/server/utils/core-route'
import { getHeader, getQuery, getRouterParam, readBody, setHeader, setResponseStatus, type H3Event } from 'h3'
import { z } from 'zod'
import { readApiToken, resolveApiAuth } from '../../../core/server/utils/api-auth'
import { decisionHistory102, decisionCommand102, decisionScope102, DecisionError102, parse102 } from './decision-lifecycle/contract'
import { currentPostgresDecisions102, historyPostgresDecision102, readPostgresDecision102 } from './decision-lifecycle/postgres-reads'
import { savePostgresDecision102, preflightPostgresQualification102, commitPostgresQualification102 } from './decision-lifecycle/postgres-writes'
import { usePostgresRosterDb } from './postgres-roster-db'
import { decisionFailure102, postgresDecisionOutput102 } from './decision-lifecycle-output'

function numericQuery(query: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(query).map(([key,value]) => [key,
    ['id','enterpriseId','page','pageSize'].includes(key) && typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
  ]))
}
export function decisionRoute102(action: 'commands' | 'get' | 'current' | 'history' | 'qualification-preflight' | 'qualification-commit') {
  return semanticRouteHandler(`maintenance.decision.${action}`, async (event: H3Event) => {
    setHeader(event, 'cache-control', 'no-store')
    try {
      if (action === 'get' || action === 'current' || action === 'history') {
        const postgres = usePostgresRosterDb()
        const query = numericQuery(getQuery(event))
        return await postgres.transaction(async tx => {
          const output = await postgresDecisionOutput102(tx)
          if (action === 'history') return output(await historyPostgresDecision102(tx, parse102(decisionHistory102, query)))
          if (action === 'get') {
            const id = parse102(z.number().int().positive().max(Number.MAX_SAFE_INTEGER), numericQuery({ id: getRouterParam(event, 'id') }).id)
            return output(await readPostgresDecision102(tx, id))
          }
          return output((await currentPostgresDecisions102(tx, [parse102(decisionScope102, query)]))[0]!)
        }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
      }
      if (action === 'commands' || action === 'qualification-preflight' || action === 'qualification-commit') {
        if (!resolveApiAuth({ given: readApiToken({ authorization: getHeader(event, 'authorization'), 'x-api-token': getHeader(event, 'x-api-token') }), configured: useRuntimeConfig().apiToken }).writeAuthorized) throw new DecisionError102(401, 'unauthorized', 'Configured API token required')
        let body: unknown
        try { body = await readBody(event) } catch { throw new DecisionError102(400, 'invalid_request', 'Malformed JSON request body') }
        const postgres = usePostgresRosterDb(action !== 'qualification-preflight')
        const output = await postgresDecisionOutput102(postgres)
        if (action === 'qualification-preflight') return output(await preflightPostgresQualification102(postgres, body))
        if (action === 'qualification-commit') return output(await commitPostgresQualification102(postgres, body))
        return output(await savePostgresDecision102(postgres, parse102(decisionCommand102, body)))
      }
    } catch (error) {
      const failure = decisionFailure102(error)
      if (failure.status === 401) setHeader(event, 'www-authenticate', 'Bearer realm="agent-api"')
      setResponseStatus(event, failure.status)
      return failure.body
    }
  })
}
