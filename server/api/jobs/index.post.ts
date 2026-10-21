import { useDb } from '@db'
import { normalizeJobParams } from '~~/lib/job'
import { requireApiToken } from '../../utils/api-guard'
import { ensureJobRunnerReady, getJobSpec, jobSpecs, submitJob } from '../../utils/job-runner'
import { registerJobSpecs } from '../../utils/job-specs'

/**
 * 提交一个**异步任务**。`POST /api/jobs`
 *
 * body:`{ "kind": "render-pages", "params": { "files": [...] } }`
 *
 * 返回 **202 Accepted** + `{ jobId }`(外加 `Location: /api/jobs/<jobId>`),
 * **不等任务做完** —— 这正是这张票的全部意义:97 页 OCR、700+ 家平台核查这类长活,
 * 同步请求要挂到天荒地老,而代理需要在技能里一件件 `curl`,拿一个 jobId 去轮询
 * 才能批量推进(见 `.scratch/ingest-pipeline/issues/19-openapi.md`)。
 *
 * **需要 token**(`Authorization: Bearer <NUXT_API_TOKEN>`,或 `X-API-Token`)。
 * 鉴权**排在最前**:未带的请求连「有哪些 kind」都探不到。
 *
 * 校验发生在**提交这一刻**(不是等任务跑起来才失败):
 *  - 未知 kind → **400**(名字拼错了);
 *  - 已登记但尚未接入 → **501**(名字对,活还没接;当前三个 kind 都已接入,
 *    这条分支留着给下一个先登记后实现的 kind);
 *  - 参数不合法 → **400**(带一句中文原因,由 kind 自己的 `parse` 给出)。
 */

defineRouteMeta({
  openAPI: {
    tags: ['任务'],
    summary: '提交异步任务',
    description:
      '提交后立刻返回 202 与 jobId,任务在后台串行执行。用 `GET /api/jobs/{id}` 轮询进度与结果。' +
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
                enum: ['render-pages', 'ocr', 'reconcile', 'platform-query-batch', 'current-roster-export'],
                description:
                  '任务种类。`render-pages`(默认 300 DPI 渲染页图)、`ocr`(并发逐张 PNG 调 PaddleOCR,按页码入库)与 ' +
                  '`reconcile`(批量平台核查:实查工信部 businessList / applyList → 落关系证据 → 标记查询状态、交代理核实 → ' +
                  '经统一导入 API 一个批次写回)均已接入。' +
                  '`GET /api/jobs/kinds` 报的是实时状态与各 kind 的 `paramsHint`。',
              },
              params: {
                type: 'object',
                description:
                  'current-roster-export 使用 { titleCode: little_giant|specialized_sme|innovative_sme, clientRequestId: string, regenerateOf?: jobId }；运行/排队最多9个，独立进程生成，产物保留7天。' +
                  'platform-query-batch 使用 /api/platform/batches 的 items/limits，推荐专用接口（支持稳定 itemId 和局部重试）。kind 自己的参数。`render-pages`:`{ files: string[](相对文件库根的 PDF 路径), dpi?: 72–600(默认 300), force?: boolean }`。' +
                  '`ocr`:`{ files: string[](同上), model?: string }` —— 须先生成完整页图，不支持 pageRanges；需要配置页保存 OCR token 或服务端配好 `NUXT_OCR_TOKEN`。' +
                  '`reconcile`:`{ titles?: string[](称号代号), directions?: ("missing_in_miit"|"extra_in_miit")[], ' +
                  'usccs?: string[](只查这几个统一社会信用代码), limit?: number(最多处理多少个差异目标), ' +
                  'concurrency?: 1–12(默认 4), freshnessHours?: number(复用新鲜查询与判定的窗口,默认 24), write?: boolean(默认 true;false = 只采集预览不回写) }` ' +
                  '—— 需要配置页保存 Cookie 或服务端配好 `MIIT_COOKIE`,未配时任务**明确失败且一行不写**(不产出一片「未查询」的假证据)。',
              },
            },
          },
        },
      },
    },
    responses: {
      202: {
        description: '已受理。任务在队列中，OCR 任务有界并行，其他任务独占执行。',
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

  const db = useDb()
  // 进程内第一次碰任务库:把上一个进程留下的半截任务标失败(见 job-store 的对账)。
  ensureJobRunnerReady(db)

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
  if (spec.status !== 'ready' || !spec.run) {
    // **501 而不是 400**:名字是对的,只是活还没接。这个区分对代理很要紧 ——
    // 400 会让它去改名字,501 才让它知道「这条路现在走不通」。
    throw createError({
      statusCode: 501,
      message: `任务种类尚未接入:${kind}。${spec.note ?? ''}`.trim(),
    })
  }

  const params = normalizeJobParams(raw.params)
  if (!params.ok) throw createError({ statusCode: 400, message: params.message })

  const parsed = spec.parse(params.params)
  if (!parsed.ok) throw createError({ statusCode: 400, message: parsed.message })

  const row = submitJob(db, {
    kind,
    params: parsed.params,
    filesDir: useRuntimeConfig(event).filesDir,
  })

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
