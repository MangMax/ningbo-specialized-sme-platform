import { useDb } from '@db'
import { listPlatformSnapshots } from '~~/lib/platform-snapshots'
import { parseIntegerList, toList } from '../../utils/platform-snapshot-query'

/**
 * 平台导出**快照与版本**(契约 §7.7,RL-05)。
 *
 * 边界:这里读的是**采集时点现状**(`platform_export_batch`),与经信局公布的称号历史
 * (`record*`)**分开存储、分开查询** —— 平台快照永不改写公布历史(契约 §0)。
 *
 * 读接口**不鉴权**(与既有分法一致:读不鉴权,写/任务鉴权)。
 */
defineRouteMeta({
  openAPI: {
    tags: ['平台对照'],
    summary: '平台导出快照与版本',
    description:
      '三张工信部导出表的采集快照批次。同一称号+同年度+同文件内容=同一批(重放幂等);' +
      '换文件内容产生**新版本**并记录 `replacedBatchId`,两版并存。',
    parameters: [
      {
        name: 'title',
        in: 'query',
        schema: { type: 'string' },
        description: '称号代号,多值(逗号分隔或重复传):`specialized_sme` / `little_giant` / `innovative_sme`。',
      },
      { name: 'year', in: 'query', schema: { type: 'integer' }, description: '快照年度,多值。' },
    ],
    responses: {
      200: { description: '快照批次列表。每行:`{ batch, replacedBatchId, rowCount, importStatus }`。' },
      400: { description: '年度参数不是正整数。' },
    },
  },
})

export default defineEventHandler((event) => {
  const q = getQuery(event)
  const { values: years, invalid } = parseIntegerList(q.year)
  if (invalid.length) {
    throw createError({
      statusCode: 400,
      statusMessage: `年度参数无效:${invalid.join(',')}`,
      message: `年度参数必须是正整数:${invalid.join(',')}`,
    })
  }

  const rows = listPlatformSnapshots(useDb(), { title: toList(q.title), year: years })
  return { rows, count: rows.length }
})
