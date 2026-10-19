import { defineEventHandler, getHeader, getMethod, getQuery, getRouterParam, readBody, setHeader, setResponseStatus } from 'h3'
import { useDb } from '@db'
import { handleEvidenceCorrectionRequest, type EvidenceCorrectionAction } from './roster-evidence-correction-api'
export function evidenceCorrectionRoute(action: EvidenceCorrectionAction) {
  return defineEventHandler(async event => {
    setHeader(event, 'cache-control', 'no-store')
    let body: unknown
    if (getMethod(event) === 'POST') {
      try { body = await readBody(event) } catch {
        setResponseStatus(event, 400)
        return { error: { code: 'invalid_request', message: 'Malformed JSON request body' } }
      }
    }
    const config = useRuntimeConfig()
    const output = await handleEvidenceCorrectionRequest({ action, method: getMethod(event), headers: { authorization: getHeader(event, 'authorization'), 'x-api-token': getHeader(event, 'x-api-token') }, body, query: getQuery(event), id: getRouterParam(event, 'id'), key: getRouterParam(event, 'key') }, { db: useDb(), apiToken: config.apiToken, filesDir: config.filesDir })
    setResponseStatus(event, output.status)
    for (const [name, value] of Object.entries(output.headers)) setHeader(event, name, value)
    return output.body
  })
}
