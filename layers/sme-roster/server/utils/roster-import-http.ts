/** HTTP submission validates methods, authorization and the shared import envelope. */
import { readApiToken, resolveApiAuth, unauthorizedApiMessage } from '../../../core/server/utils/api-auth'
import { hasOfficialFactInput, validateImportRequest } from './roster-import-model'
import { runPostgresMixedImport } from './roster-mixed-import-postgres'
import { ImportReceiptError } from './import-receipt-model'
import { appLog, type LogContext } from '../../../core/lib/logging'
import { logImportFailure } from './roster-import-logging'

export interface RosterHttpRequest {
  /** 大写 HTTP 方法；仅 POST 被接受。 */
  method: string
  headers: Record<string, string | undefined>
  /** 已解析的请求体（JSON）；解析失败给 `null`。 */
  body: unknown
}

export interface RosterHttpResponse {
  status: number
  headers: Record<string, string>
  body: unknown
}

export type RosterImportAction = 'preflight' | 'commit' | 'replay'

/** 从请求头折出鉴权状态（判据与 `api-guard.ts` 同源）。 */
export function authorizeRosterWrite(
  request: Pick<RosterHttpRequest, 'headers'>,
  apiToken: string | null | undefined,
): { ok: true } | { ok: false; status: number; headers: Record<string, string>; body: unknown } {
  const state = resolveApiAuth({
    given: readApiToken({
      authorization: request.headers.authorization,
      'x-api-token': request.headers['x-api-token'],
    }),
    configured: apiToken,
  })
  if (state.writeAuthorized) return { ok: true }
  return {
    ok: false,
    status: 401,
    headers: {
      'www-authenticate': 'Bearer realm="agent-api"',
      'content-type': 'application/json; charset=utf-8',
    },
    body: { message: unauthorizedApiMessage(state.reason), reason: state.reason },
  }
}

export type ImportContext = { apiToken: string | null | undefined; filesDir?: string; logContext?: LogContext }

export function handlePostgresRosterImportRequest(action: RosterImportAction, request: RosterHttpRequest, deps: ImportContext) {
  return handleImportSubmission(action, request, deps, input => runPostgresMixedImport(action, input, deps.filesDir, deps.logContext))
}

export async function handleImportSubmission(
  action: RosterImportAction,
  request: RosterHttpRequest,
  deps: ImportContext,
  perform: (input: Parameters<typeof runPostgresMixedImport>[1]) => Promise<unknown>,
): Promise<RosterHttpResponse> {
  if (request.method !== 'POST') {
    return json(405, { message: `本端点是 POST：/api/roster/import/${action}` })
  }

  const auth = authorizeRosterWrite(request, deps.apiToken)
  if (!auth.ok) {
    appLog({ module: 'sme-roster', source: 'import', operation: `import.submission.${action}`, outcome: 'denied', errorCode: 'unauthorized' }, deps.logContext)
    return { status: auth.status, headers: auth.headers, body: auth.body }
  }

  const validated = validateImportRequest(request.body)
  if (!validated.ok) {
    appLog({ module: 'sme-roster', source: 'import', operation: `import.submission.${action}`, outcome: 'denied', errorCode: 'invalid_import_request' }, deps.logContext)
    return json(validated.status, { message: validated.message })
  }
  if (action === 'replay' && hasOfficialFactInput(validated.value)) return json(400, { message: 'Replay cannot capture, append or correct official facts' })
  if (action === 'replay' && validated.value.payload.platformRecordObservations) return json(400, { message: 'Historical projection uses preflight/commit with its original idempotency key; replay only converges announcement evidence' })
  if (action === 'replay' && validated.value.payload.platformLegacyProvenance) return json(400, { message: 'Legacy provenance uses preflight/commit with its original idempotency key' })

  try {
    return json(200, await perform(validated.value))
  } catch (error) {
    logImportFailure(`import.submission.${action}`, error, deps.logContext)
    if (!(error instanceof ImportReceiptError)) throw error
    return { ...json(error.statusCode, { error: { code: error.code, message: error.message } }), headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }
  }
}

function json(status: number, body: unknown): RosterHttpResponse {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body }
}
