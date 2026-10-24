import { readBody, setHeader, setResponseStatus, type H3Event } from 'h3'
import { z } from 'zod'
import { useDb } from '@db'
import { checkBrowserReviewRequest, type BrowserReviewRuntime } from './browser-review-102'
import { handleRecordCorrespondenceRequest } from './record-correspondence-api'

const requestSchema = z.strictObject({
  idempotencyKey: z.string().trim().min(1).max(200),
  basis: z.string().trim().min(1).max(4000),
  operations: z.array(z.record(z.string(), z.unknown())).min(1).max(20),
})
const commitSchema = z.strictObject({ request: requestSchema, planHash: z.string().regex(/^[0-9a-f]{64}$/) })

/** Capability gate is not personal authentication. Audit names this actual adapter. */
export function browserCorrespondenceRoute(action: 'preflight' | 'commit', context: () => { db: ReturnType<typeof useDb>; config: BrowserReviewRuntime } = () => ({ get db() { return useDb() }, config: useRuntimeConfig() })) {
  return defineEventHandler(async (event: H3Event) => {
    setHeader(event, 'cache-control', 'no-store')
    const runtime = context()
    const config = runtime.config
    const gate = checkBrowserReviewRequest(event, config, { write: true })
    if (!gate.ok) { setResponseStatus(event, gate.status); return { error: { code: gate.code, message: gate.message } } }
    let body: unknown
    try { body = await readBody(event) } catch { setResponseStatus(event, 400); return { error: { code: 'invalid_request', message: 'Malformed JSON request body' } } }
    const parsed = (action === 'commit' ? commitSchema : requestSchema).safeParse(body)
    if (!parsed.success) { setResponseStatus(event, 400); return { error: { code: 'invalid_request', message: 'Invalid browser correspondence request' } } }
    const envelope = parsed.data
    const business = 'request' in envelope ? envelope.request : envelope
    const request = { ...business, sourceIdentity: 'same-origin-correspondence', actor: { type: 'agent', id: 'same-origin-correspondence-adapter' }, ruleId: 'manual-source-row-review', ruleVersion: '1' }
    const output = handleRecordCorrespondenceRequest({ action, method: 'POST', headers: { authorization: `Bearer ${config.apiToken}` }, body: 'request' in envelope ? { request, planHash: envelope.planHash } : request }, { db: runtime.db, apiToken: config.apiToken })
    setResponseStatus(event, output.status)
    return output.body
  })
}
