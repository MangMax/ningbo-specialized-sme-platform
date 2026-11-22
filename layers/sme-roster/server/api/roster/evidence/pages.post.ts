import { createCoreRouteHandler } from '../../../../../core/server/utils/core-route'
import { handlePostgresEvidencePagesRequest } from '../../../utils/roster-evidence-pages-postgres'

/**
 * **出处页码补录**:`POST /api/roster/evidence/pages`(RL-10)。
 *
 * 把已核对的 **PDF 实际页序**写到既有 `record_evidence` 行上。它不新建企业/记录/事件/出处行,
 * 业务坐标只更新 `page`;自动追加更正审计与事件来源修订;定不下来的条目**一行不改**,在响应里逐条报原因(`pending`)。
 *
 * 为什么不是「再导入一次」:导入载荷(契约 §8.3)的 `evidence[].page` 只管**今后**的写入;
 * 库里已有两万余条出处是在 `page` 还没人填的时候落下的,补它是对**既有行**的更新,
 * 不改企业/记录/事件,也不该再造一条批次账。
 *
 * ── 为什么每条必须带定位 ────────────────────────────────────────────────
 *
 * 库里 `record_evidence` 只有 `(source_file, attachment, list_no)`,**没有分节列**;
 * 而 `甬经信中小〔2022〕145号` 一份文件里就有**三张序号各自从 1 起算**的名单
 * (一、198 行;二、104 行;三、413 行)。实测「145号 + 序号 6」在库中命中 **3 条**
 * 完全不同的企业。**拿裸序号定位就会把页码写到错的公司上**,所以每条必须同时给
 * `enterpriseId` 或 `enterpriseName`(可再加 `district`);缺了 ⇒ `entry_incomplete`。
 *
 * 需要 token(`Authorization: Bearer <NUXT_API_TOKEN>` 或 `X-API-Token`);
 * 未配 token ⇒ 本接口整体关闭(与其它写入口同一条反向默认)。
 */
defineRouteMeta({
  openAPI: {
    tags: ['名录'],
    summary: '出处页码补录(把已核对的 PDF 实际页写进既有出处行)',
    description:
      '把已核对的 **PDF 实际页序**写到既有 `record_evidence` 行上:只更新 `page` 一列,' +
      '不新建/删除企业、记录、事件或出处行；逐行部分应用，追加审计与事件来源修订，关联确认需显式重核。**每条必须带 `enterpriseId` 或 `enterpriseName`(可加 `district`)定位** —— ' +
      '同一份公布文件里可以并置多张「序号各自从 1 起算」的分节名单(如 145号 的三张),' +
      '裸序号会定位到错的企业。定不下来的条目**一行不改**,在 `pending[]` 里带原因回报' +
      '(`entry_incomplete` / `page_invalid` / `page_count_unknown` / `not_page_capable` / `no_match` / `ambiguous`)。' +
      '`dryRun: true` 只报结论不写库。需要 token:`Authorization: Bearer <NUXT_API_TOKEN>`(或 `X-API-Token`);' +
      '未配 token 时本接口整体关闭。',
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['entries'],
            properties: {
              dryRun: { type: 'boolean', description: '只报结论、不写库。' },
              entries: {
                type: 'array',
                minItems: 1,
                description: '要补的页码条目。',
                items: {
                  type: 'object',
                  required: ['sourceFile', 'listNo', 'page'],
                  properties: {
                    sourceFile: {
                      type: 'string',
                      description: '来源文件,相对文件库根(与 `record_evidence.source_file` 同一口径)。**必须是 PDF**。',
                    },
                    listNo: { type: 'integer', minimum: 1, description: '名单里的序号 —— **不是**页码。' },
                    page: { type: 'integer', minimum: 1, description: 'PDF 实际页序(1 起)。' },
                    enterpriseId: { type: 'integer', description: '定位:企业 id。与 `enterpriseName` 至少给一个。' },
                    enterpriseName: { type: 'string', description: '定位:企业名(逐字归一后比对)。' },
                    district: { type: 'string', nullable: true, description: '定位(可选):属地。' },
                    basis: { type: 'string', description: '这个页码怎么来的(人工核对页图 / OCR 页标记)。留档用。' },
                  },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: '补录结论(可能仍有 `pending` 项;那些行一行没改)。',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                status: { type: 'string', enum: ['applied', 'dry_run'] },
                summary: {
                  type: 'object',
                  properties: {
                    requested: { type: 'integer', description: '入参给了几条。' },
                    assigned: { type: 'integer', description: '定得下来的条数(含值没变的)。' },
                    written: { type: 'integer', description: '真的改了库的行数。' },
                    unchanged: { type: 'integer', description: '已有相同页码，或本次请求中重复指向同一出处的条目。' },
                    pending: { type: 'integer', description: '留空待核的条数。' },
                  },
                },
                assignments: { type: 'array', items: { type: 'object' } },
                pending: { type: 'array', items: { type: 'object' } },
              },
            },
          },
        },
      },
      400: { description: '请求体不合法(缺 `entries` / 空数组 / 不是对象)。' },
      401: { description: '未带 token、token 不匹配,或服务端未配置 `NUXT_API_TOKEN`。' },
      // ⚠️ 这里**不列 405**:本文件只注册 POST,真实面上对 `/api/roster/evidence/pages` 发 GET
      // 会落到 SPA 兜底(实测 200 + 应用外壳 HTML),**不是**核心那条 405 —— 把核心会返回
      // 的状态码写进**路由**的 spec,等于给读者一个他永远观测不到的承诺。
      // 核心自己仍守方法(直接调用方 / 测试夹具走的是它),见 `roster-evidence-pages.ts`。
    },
  },
})

export default createCoreRouteHandler(handlePostgresEvidencePagesRequest, () => {
  const config = useRuntimeConfig()
  return { apiToken: config.apiToken, filesDir: config.filesDir }
})
