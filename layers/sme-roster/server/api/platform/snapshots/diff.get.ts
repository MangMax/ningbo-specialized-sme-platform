import { useDb } from '@db'
import { handlePlatformSnapshotRequest } from '../../../utils/platform-snapshots-http'

/**
 * **比较两个导出快照**(RL-05 验收:新增 / 消失 / 字段变化,并追溯到原始行)。
 *
 * `from` = 旧批号,`to` = 新批号;两批必须同称号(拿中小表比创新型表只会全是增删,
 * 没有意义)。每处差异都带源行号 `sourceRowNo`,可回溯到导出的物理行。
 *
 * 这是 §7.7 快照读接口的**增量**补充(契约 §7.7 已收录),只读、不鉴权。
 * 逻辑在 `layers/sme-roster/server/utils/platform-snapshots-http.ts`(不 import h3,可被真实 HTTP 回放测试驱动)。
 */
defineRouteMeta({
  openAPI: {
    tags: ['平台对照'],
    summary: '比较两个导出快照',
    description: '返回新增 / 消失 / 字段变化,并带两侧源行号;两批必须同称号。',
    parameters: [
      { name: 'from', in: 'query', required: true, schema: { type: 'integer' }, description: '旧快照批次 id。' },
      { name: 'to', in: 'query', required: true, schema: { type: 'integer' }, description: '新快照批次 id。' },
    ],
    responses: {
      200: { description: '`{ from, to, diff }`;diff 含 added / removed / changed / unchanged 与两侧总量。' },
      400: { description: '缺 from/to、批号不是正整数,或两批称号不同。' },
      404: { description: '批号不存在。' },
    },
  },
})

export default defineEventHandler((event) => {
  const response = handlePlatformSnapshotRequest(
    'diff',
    { method: getMethod(event), query: getQuery(event) as Record<string, unknown> },
    { db: useDb() },
  )
  setResponseStatus(event, response.status)
  for (const [name, value] of Object.entries(response.headers)) setHeader(event, name, value)
  return response.body
})
