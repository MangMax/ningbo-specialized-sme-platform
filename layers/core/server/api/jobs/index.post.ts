import { postgresJobHandler } from '../../utils/job-runner-postgres'
import { requireJobsWritable, submitWritableJob } from '../../utils/postgres-jobs'
import { requestLogContext } from '../../../lib/logging'
import { normalizeJobParams } from '#core/lib/job'
import { requireApiToken } from '../../utils/api-guard'
import { getJobSpec, jobSpecs } from '../../utils/job-spec-registry'
import { registerJobSpecs } from '../../../../../server/utils/job-specs'

defineRouteMeta({
  openAPI: {
    tags: ['任务'],
    summary: '提交异步任务',
    description:
      '受理后返回 202 与 jobId。用 `GET /api/jobs/{id}` 读取进度与结果；使用 PostgreSQL 任务库的客户端还可订阅 `GET /api/task-center/events` 的变更通知。' +
      '需要 token:`Authorization: Bearer <NUXT_API_TOKEN>`(或 `X-API-Token`);未配 token 时本接口整体关闭。',
    // 引用下面 `$global` 里声明的安全方案 —— 不写这一行,`components.securitySchemes`
    // 就是个没人引用的摆设(spec 里声明了却谁也没用)。
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['kind'],
            properties: {
              kind: {
                type: 'string',
                description: '任务种类。请通过 GET /api/jobs/kinds 发现当前已登记的种类、接入状态及参数提示。',
              },
              params: {
                type: 'object',
              },
            },
          },
        },
      },
    },
    responses: {
      202: {
        description: '已受理。Location 指向任务状态和结果。',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                jobId: { type: 'string', description: 'ULID' },
                kind: { type: 'string' },
                state: { type: 'string', enum: ['queued','running','done','failed','cancelled'] },
              },
            },
          },
        },
      },
      400: { description: '请求体不是对象 / 缺 kind / 未知 kind / params 不合法。' },
      401: { description: '未带 token 或 token 不匹配。' },
      501: { description: 'kind 已登记但尚未接入(消息里写明接在哪张票上)。' },
    },
    // `$global` 是 Nitro 的全局段(见 nitro 的 openapi 路由):在这里声明一次安全方案,
    // 全 spec 的 `security: [{ bearerAuth: [] }]` 就都有定义了。
    $global: {
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description: '`NUXT_API_TOKEN` 的值。写/任务类接口需要。',
          },
        },
      },
    },
  },
})

export default defineEventHandler(async (event) => {
  requireApiToken(event)
  registerJobSpecs()

  const body = await readBody(event).catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError({ statusCode: 400, message: '请求体必须是 JSON 对象' })
  }
  const raw = body as Record<string, unknown>

  const kind = typeof raw.kind === 'string' ? raw.kind.trim() : ''
  if (!kind) throw createError({ statusCode: 400, message: '缺少 kind 字段' })

  const spec = getJobSpec(kind)
  if (!spec) {
    const known = jobSpecs()
      .map((s) => `${s.kind}(${s.status === 'ready' ? '已接入' : '尚未接入'})`)
      .join('、')
    throw createError({
      statusCode: 400,
      message: `未知的任务种类:${kind}。已登记:${known || '(无)'}`,
    })
  }
  requireJobsWritable()
  const handler = postgresJobHandler(kind)
  if (!handler) {
    // **501 而不是 400**:名字是对的,只是活还没接。这个区分对代理很要紧 ——
    // 400 会让它去改名字,501 才让它知道「这条路现在走不通」。
    throw createError({
      statusCode: 501,
      message: `任务种类尚未接入:${kind}。${spec.note ?? ''}`.trim(),
    })
  }

  const params = normalizeJobParams(raw.params)
  if (!params.ok) throw createError({ statusCode: 400, message: params.message })

  const parsed = (handler.parse ?? spec.parse)(params.params)
  if (!parsed.ok) throw createError({ statusCode: 400, message: parsed.message })

  const input = {
    kind,
    logContext: requestLogContext(event),
    params: parsed.params,
  }
  const row = await submitWritableJob(useRuntimeConfig().filesDir, input)

  setResponseStatus(event, 202)
  setHeader(event, 'location', `/api/jobs/${row.id}`)
  return {
    jobId: row.id,
    kind: row.kind,
    state: row.state,
    progress: row.progress,
    createdAt: row.createdAt,
  }
})
