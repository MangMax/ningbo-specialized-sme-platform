/**
 * 名录统一导入 API 的 **HTTP 面**（RL-11）：把核心逻辑翻成状态码 + JSON（契约 §8）。
 *
 * ── 为什么鉴权/状态码在这一层而不是核心逻辑 ──────────────────────────────
 * 与 `server/utils/api-auth.ts` / `api-guard.ts` 同一个分法：**判据是纯函数**（可单测），
 * 「贴到 h3 上」只是最薄的一层。这里再往里退一步：本文件**不 import h3**，只吃一个
 * 最小的请求描述（method / headers / body），于是同一份实现既能被 Nitro 路由调用，
 * 也能被**真实 HTTP 回放测试**（`tests/roster-import-api.test.ts` 起一个 node:http 服务）
 * 直接驱动 —— 契约只有一份，测试打的不是另写的替身。
 *
 * ── 鉴权（契约 §8 开头）──────────────────────────────────────────────────
 * `Authorization: Bearer <NUXT_API_TOKEN>` 或 `X-API-Token`（沿用既有分法）。
 * **token 未配置 ⇒ 写入整体关闭**（不是「空 = 放行」）。凭证只从运行时读，
 * 不落库、不进仓库、不进日志；本文件也不回显任何 token 值。
 */

import { readApiToken, resolveApiAuth, unauthorizedApiMessage } from '../../../core/server/utils/api-auth'
import {
  replayRosterImport,
  hasOfficialFactInput,
  validateImportRequest,
} from './roster-import'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { stageAnnouncement } from './announcement-intake'
import { stagePostgresAnnouncement } from './announcement-intake-postgres'
import { runPostgresExportImport } from './roster-export-import-postgres'
import { hasAnnouncementRows } from '../../lib/roster-import-client'
import * as schema from '../../../../db/schema'
import { validateRosterImportPageCounts } from './roster-import-page-validation'
import { ImportReceiptError } from './import-receipts'
import { importExecutor } from './import-execution'
import { appLog, type LogContext } from '../../../core/lib/logging'
import { logImportFailure } from './roster-import-logging'

type Db = BetterSQLite3Database<typeof schema>

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

/**
 * 处理一次预检或提交请求。`db` 由调用方给（路由用 `useDb()`；测试用临时库），
 * `apiToken` 从运行时配置读（Nuxt：`useRuntimeConfig().apiToken`）。
 */
export async function handleRosterImportRequest(
  action: RosterImportAction,
  request: RosterHttpRequest,
  deps: { db: Db; apiToken: string | null | undefined; filesDir?: string; logContext?: LogContext; executeImport?: typeof importExecutor.execute },
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
    const nativeExport = await runPostgresExportImport(action, validated.value)
    if (nativeExport !== undefined) return json(200, nativeExport)
    const pageCountErrors =
      (action === 'preflight' || action === 'commit') && deps.filesDir
        ? await validateRosterImportPageCounts(validated.value, deps.filesDir)
        : []

    if (action === 'preflight') {
      const result = await (deps.executeImport ?? importExecutor.execute)(deps.db, 'preflight', validated.value, pageCountErrors, deps.logContext, { filesDir: deps.filesDir })
      return json(200, result)
    }
    if (action === 'replay') {
      const result = replayRosterImport(deps.db, validated.value, deps.logContext)
      return json(200, result)
    }
    if (hasAnnouncementRows(validated.value)) {
      const nativeIntake = await stagePostgresAnnouncement(validated.value, pageCountErrors)
      if (nativeIntake !== undefined) return json(200, nativeIntake)
      const staged = deps.executeImport
        ? stageAnnouncement(deps.db as Parameters<typeof stageAnnouncement>[0], validated.value, pageCountErrors)
        : await importExecutor.stage(deps.db, validated.value, pageCountErrors, deps.logContext)
      if (staged) return json(200, staged)
    }
    const result = await (deps.executeImport ?? importExecutor.execute)(deps.db, 'commit', validated.value, pageCountErrors, deps.logContext, { filesDir: deps.filesDir })
    return json(200, result)
  } catch (error) {
    logImportFailure(`import.submission.${action}`, error, deps.logContext)
    if (!(error instanceof ImportReceiptError)) throw error
    return { ...json(error.statusCode, { error: { code: error.code, message: error.message } }), headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }
  }
}

function json(status: number, body: unknown): RosterHttpResponse {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body }
}
