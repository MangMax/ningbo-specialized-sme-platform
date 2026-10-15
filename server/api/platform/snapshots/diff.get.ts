import { useDb } from '@db'
import {
  diffPlatformSnapshots,
  getPlatformExportRows,
  getPlatformSnapshotBatch,
  type PlatformSnapshotBatch,
} from '~~/lib/platform-snapshots'
import { parsePositiveInt } from '../../../utils/platform-snapshot-query'

/**
 * **比较两个导出快照**(RL-05 验收:新增 / 消失 / 字段变化,并追溯到原始行)。
 *
 * `from` = 旧批号,`to` = 新批号;两批必须同称号(拿中小表比创新型表只会全是增删,
 * 没有意义)。每处差异都带源行号 `sourceRowNo`,可回溯到导出的物理行。
 *
 * 这是 §7.7 快照读接口的**增量**补充(契约未定义 diff 端点),只读、不鉴权。
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
  const q = getQuery(event)
  const fromId = parsePositiveInt(q.from)
  const toId = parsePositiveInt(q.to)
  if (fromId === null || toId === null) {
    throw createError({ statusCode: 400, message: '需要正整数参数 from 与 to(两个快照批次 id)。' })
  }

  const db = useDb()
  const from = getPlatformSnapshotBatch(db, fromId)
  const to = getPlatformSnapshotBatch(db, toId)
  if (!from || !to) {
    throw createError({ statusCode: 404, message: `快照批次不存在:${!from ? `from=${fromId} ` : ''}${!to ? `to=${toId}` : ''}` })
  }
  if (from.titleCode !== to.titleCode) {
    throw createError({
      statusCode: 400,
      message: `两批称号不同(${from.titleCode} vs ${to.titleCode}),不能相互比较。`,
    })
  }

  const diff = diffPlatformSnapshots(getPlatformExportRows(db, fromId), getPlatformExportRows(db, toId))
  return { from: summarize(from), to: summarize(to), diff }
})

/** 比较结果里附带的批次摘要(够看清是哪两版,不塞整批行)。 */
function summarize(batch: PlatformSnapshotBatch) {
  return {
    id: batch.id,
    titleCode: batch.titleCode,
    year: batch.year,
    collectedOn: batch.collectedOn,
    originalFilename: batch.originalFilename,
    sha256: batch.sha256,
    importStatus: batch.importStatus,
    replacedBatchId: batch.replacedBatchId,
  }
}
