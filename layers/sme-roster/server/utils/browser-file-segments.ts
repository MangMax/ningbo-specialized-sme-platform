import { createError, getRouterParam, readBody, setHeader } from 'h3'
import { z } from 'zod'
import { useDb } from '@db'
import { checkBrowserReviewRequest } from './browser-review-102'
import { getParse105, preflightRanges669, commitRanges669, parseFrozenCommit310, ParseMaintenanceError } from './parse-maintenance-105'
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
      const id = Number(rawId), db = useDb()
      if (action === 'read') return { writeEnabled: true, state: getParse105(db, id) }
      const raw = await readBody(event)
      if (action === 'preflight') {
        const input = preflight.safeParse(raw)
        if (!input.success) throw new ParseMaintenanceError(400, '非法预检请求')
        const state = getParse105(db, id)
        if (state.version !== input.data.expectedVersion) throw new ParseMaintenanceError(409, '解析版本冲突，请重新加载；草稿仍保留')
        // Description maintenance checks current file identity only. No OCR pages
        // were consumed and this does not authenticate historical segment sources.
        const plan = await preflightRanges669(db, id, { kind: 'file', ...(input.data.verifyPhysicalPages ? { verifyPhysicalPages: true } : {}) }, config.filesDir)
        if (plan.expectedVersion !== state.version) throw new ParseMaintenanceError(409, '解析版本冲突，请重新加载')
        return { ...plan, parseState: state.parseState }
      }
      const input = commit.safeParse(raw)
      if (!input.success) throw new ParseMaintenanceError(400, '非法分段：检查称号、事件、年份、批次、行数和容量')
      const state = getParse105(db, id)
        if (state.version === input.data.expectedVersion && state.parseState !== input.data.parseState) throw new ParseMaintenanceError(400, '描述编辑必须保留解析状态')
      return await commitRanges669(db, id, { ...input.data, actor }, config.filesDir, requestLogContext(event))
    } catch (error) {
      if (error instanceof ParseMaintenanceError) throw createError({ statusCode: error.statusCode, message: error.message })
      throw error
    }
  })
}
