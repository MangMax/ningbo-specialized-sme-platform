import { createError, getRouterParam, readBody, setHeader } from 'h3'
import { z } from 'zod'
import { usePostgresFileDb } from '../../../core/server/utils/file-store-postgres'
import { getPostgresParseState, preflightPostgresParse, savePostgresParse } from './parse-maintenance-postgres'
import { checkBrowserReviewRequest } from './browser-review-102'
import { parseFrozenCommit310, ParseMaintenanceError } from './parse-maintenance-contract'
import { requestLogContext } from '../../../core/lib/logging'

const preflight = z.strictObject({ expectedVersion: z.string().regex(/^[a-f0-9]{64}$/), verifyPhysicalPages: z.boolean().optional() })
const { actor: _actorSchema, ...businessShape } = parseFrozenCommit310.shape
const commit = z.strictObject({ ...businessShape, parseState: businessShape.parseState.unwrap() })
const actor = { type: 'agent' as const, id: 'same-origin-file-segments-adapter' }

export function browserFileSegmentsRoute(action: 'read' | 'preflight' | 'commit') {
  return defineEventHandler(async event => {
    setHeader(event, 'cache-control', 'no-store')
    const config = useRuntimeConfig()
    if (action !== 'read') {
      const gate = checkBrowserReviewRequest(event, { write: true })
      if (!gate.ok) throw createError({ statusCode: gate.status, message: gate.message })
    }
    try {
      const rawId = getRouterParam(event, 'id') ?? ''
      if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(Number(rawId))) throw new ParseMaintenanceError(400, '文件 ID 非法')
      const id = Number(rawId)
      const pg = usePostgresFileDb()
      const readState = () => getPostgresParseState(pg, id)
      const writeEnabled = process.env.NUXT_DB_READONLY !== '1'
      if (action === 'read') return { writeEnabled, state: await readState() }
      if (!writeEnabled) throw new ParseMaintenanceError(503, '文件库处于只读模式')
      const raw = await readBody(event)
      if (action === 'preflight') {
        const input = preflight.safeParse(raw)
        if (!input.success) throw new ParseMaintenanceError(400, '非法预检请求')
        const state = await readState()
        if (state.version !== input.data.expectedVersion) throw new ParseMaintenanceError(409, '解析版本冲突，请重新加载；草稿仍保留')
        const selection = { kind: 'file' as const, ...(input.data.verifyPhysicalPages ? { verifyPhysicalPages: true } : {}) }
        const plan = await preflightPostgresParse(pg, id, selection, config.filesDir)
        if (plan.expectedVersion !== state.version) throw new ParseMaintenanceError(409, '解析版本冲突，请重新加载')
        return { ...plan, parseState: state.parseState }
      }
      const input = commit.safeParse(raw)
      if (!input.success) throw new ParseMaintenanceError(400, '非法分段：检查称号、事件、年份、批次、行数和容量')
      const state = await readState()
      if (state.version === input.data.expectedVersion && state.parseState !== input.data.parseState) throw new ParseMaintenanceError(400, '描述编辑必须保留解析状态')
      const command = { ...input.data, actor }
      return await savePostgresParse(pg, id, command, config.filesDir, 'commit', requestLogContext(event))
    } catch (error) {
      if (error instanceof ParseMaintenanceError) throw createError({ statusCode: error.statusCode, message: error.message })
      throw error
    }
  })
}
