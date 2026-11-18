import { getRouterParam, setHeader } from 'h3'
import { useDb } from '@db'
import { getTargetRecognizedRecord } from '../../../../layers/sme-roster/server/utils/platform-recognized-target'

defineRouteMeta({
  openAPI: {
    tags: ['平台业务'],
    summary: '读取单条平台认定目录记录的实际观察与历史版本',
    description:
      '只读本地 recognized_list 目录记录；返回记录身份、全部内容版本（最多 100）与实际观察元数据（最多 200），包括版本 typed 字段（有效期原值、维护年、维护批次、属地、认定说明、行称号原值）、版本的观察称号范围、版本哈希、观察的 relation/query/采集时间/企业归属/identity/content 状态、查询称号范围、行称号是否与查询范围冲突，以及该观察自己的对应决定引用（id/status/revision，不返回决定内容）。超出上限时 counts.versionsTruncated/observationsTruncated=true。**不返回 raw JSON**；原档仍走 /api/platform/queries/{queryId}/evidence。这是目录镜像，不作为当前有效资格判定。',
    parameters: [{ name: 'recordId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
    responses: {
      200: { description: 'record, versions[], observations[], counts, conflicts。' },
      400: { description: 'recordId 不是正整数。' },
      404: { description: '记录不存在或不是 recognized_list。' },
    },
  },
})

export default defineEventHandler(event => {
  setHeader(event, 'cache-control', 'no-store')
  try {
    return getTargetRecognizedRecord(useDb(), Number(getRouterParam(event, 'recordId')))
  } catch (error) {
    const failure = error as { statusCode?: number; code?: string; message?: string }
    throw createError({ statusCode: failure.statusCode ?? 500, statusMessage: failure.message ?? 'recognized directory detail failed' })
  }
})
