import { requestLogContext } from '../../../layers/core/lib/logging'
import { createError, getQuery, setHeader } from 'h3'
import { useDb } from '@db'
import { parseCurrentQualifiedQuery } from '../../utils/current-qualified-filter'
import { enterpriseReads } from '../../../layers/sme-roster/server/utils/enterprise-read'
import { admitEnterpriseResponse } from '../../../layers/sme-roster/server/utils/enterprise-read-response'
import { withEnterpriseReadSignal } from '../../../layers/core/server/utils/enterprise-read-signal'

defineRouteMeta({ openAPI: {
  tags: ['当前有效称号查询'], summary: '分页查询指定称号当前有效及搜索定位的已公布待核企业',
  description: '#484：旧解释有效性、回执、查询覆盖与决定生命周期退出默认有效判定；仅显式旧评估版本保留历史语义。#479：可选 status 按五类状态返回 rows/total；省略 status 保持有效企业。旧 responseVersion/字段保留，publishedPending 仅兼容。#807：当前资格优先采用有效公布依据，无可用公布依据时依次采用认定目录、关联办理、申报记录中的有效业务事实；不要求人工绑定、迁入资格确认或差异核对。明确期间、业务年度、原周期失败及独立新认定分别判断，已确认注销/吊销或迁出仍排除。effectiveQualification 包含 status（effective/expired/terminated/moved_out/unrecognized）、basis、notes；旧字段及旧评估版本可读。responseVersion=current-qualified-478-v2。资格统一消费共享 T2 enterprise-qualification-807-v7（规则 current-roster-116-v14），不以平台无记录、不通过或查询失败单独否定正式有效资格，按本地规则：小巨人原认定不因原 award 年龄自动到期；同周期正式失败、已确认周期处置、后续重新认定恢复、明确正式日期区间及注销/迁出边界仍适用。省专、创新型自身资格继续按业务年度加三规则判断。有效小巨人计入两个低梯度、有效省专计入创新型，无须低梯度自身历史；自身有效期间优先，否则展示实际支撑称号及期间，正式历史各自保留。一企业一行；rows 为所选称号所选 status 且确定匹配筛选的企业（省略 status 默认为 effective），total 为分页前完整确定计数。仅通过原参数校验且名称/信用代码规范化后非空 q 时，publishedPending.requested=true：按现名、统一社会信用代码、已确认曾用名及 district 定位本称号有适用正式公布依据且 T2 pending 的企业，excluded 不进入；独立 total、rows、page、pageSize，复用同一 sort/ID 稳定排序及请求 page/pageSize。未请求时 requested=false、rows=[]、total=0，不是全库待核总量。pending 不计入 total 或 uncertainTotal；每行 filterMatch.status 为 matched/not_matched/not_established，checks 仅含实际选定字段，使用同周期同来源行 AND 见证，不跨行拼接；后两态仍可作为身份定位事实显示，不属于确定有效筛选命中。两组每页行均附完整 qualificationAssessment，保留三称号 titles、enterpriseId/asOf/ruleVersion/assessmentVersion scope、各输入版本及 snapshotId digest。asOf=snapshotStartedAt，资格评价日为执行时点 Asia/Shanghai 日历日，明确来源有效期含首尾；无明确日期仍保留年精度，不推造日期。资格评价年为该日所在年，与来源 validYear、认定窗口及首次认定年份不同；当前事实评估不是历史数据库回放。计数先于分页，各有效条件在同一当前授予事件及已确认对应的归档平台来源行上按 AND 命中。认定时间取该授予的真实决定年，闭区间完整包含该年才确定命中；部分重叠计入 uncertainTotal，不补造月日。仅 observed innovative_sme 的 queryBusList schema：date-only rddqrq 投影有效年，返回 whpcyear 为空时 YYYY-N 型 whpc 只投影维护年；批次后缀、datetime、非空 whpcyear/plain batch、其他称号及格式均未知。归档查询条件仅用于冲突校验，不作为行事实；缺失、格式不符或矛盾保持未知，不推断本地 dueYear。无证据不匹配已设条件，未设条件保留有效企业。options 仍来自该称号当前有效行可查询见证。读取独立执行器中的同一只读快照；不返回原始平台字段。400/503、预算、输入边界及重试语义不变。',
  parameters: [
    { name: 'status', in: 'query', schema: { type: 'string', enum: ['effective','expired','terminated','moved_out','unrecognized'], default: 'effective' }, description: '#479：按共享有效状态筛选；省略时保留旧版默认有效结果。其它筛选与分页不变。' },
    { name: 'titleCode', in: 'query', required: true, schema: { type: 'string', enum: ['little_giant', 'specialized_sme', 'innovative_sme'] } },
    { name: 'q', in: 'query', schema: { type: 'string' }, description: '最长120字符。搜索现名、统一社会信用代码及已确认曾用名；规范化后非空才请求独立 publishedPending 定位。空白输入仍按原参数校验拒绝。' },
    { name: 'district', in: 'query', schema: { type: 'string' }, description: '最长40字符。' },
    { name: 'recognitionFrom', in: 'query', schema: { type: 'string', format: 'date' }, description: '认定闭区间起点，必须与 recognitionTo 同时给出；年份精度仅完整覆盖才确定命中。' },
    { name: 'recognitionTo', in: 'query', schema: { type: 'string', format: 'date' }, description: '认定闭区间终点，必须与 recognitionFrom 同时给出。' },
    { name: 'validYear', in: 'query', schema: { type: 'integer', minimum: 1000, maximum: 9999 }, description: '仅 innovative_sme 已确认 queryBusList 来源行 date-only rddqrq 的有效年份；缺失或矛盾不匹配，不是生命周期 dueYear。' },
    { name: 'maintenanceYear', in: 'query', schema: { type: 'integer', minimum: 1000, maximum: 9999 }, description: '仅 innovative_sme 已确认 queryBusList 来源行在 whpcyear 为空时，取 YYYY-N 型 whpc 的年份前缀。' },
    { name: 'maintenanceBatch', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 15 }, description: '必须同时提供 maintenanceYear；当前已验证返回字段不支持正向批次事实，保持未知，不生成批次选项或确定命中。' },
    { name: 'sort', in: 'query', schema: { type: 'string', enum: ['id_asc', 'name_asc', 'name_desc'], default: 'id_asc' } },
    { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000000, default: 1 } },
    { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 25 } },
  ],
  responses: {
    200: {
      description: '兼容保留 rows、确定匹配 total、日期精度不确定 uncertainTotal、全称号有效行 options、page/pageSize/titleCode/ruleVersion/snapshotStartedAt；新增 responseVersion、publishedPending 以及两组行的完整 qualificationAssessment。以下仅描述响应扩展结构，不裁剪既有行字段或完整 T2。',
      content: { 'application/json': { schema: {
        type: 'object', required: ['responseVersion', 'rows', 'publishedPending', 'total', 'uncertainTotal', 'options', 'page', 'pageSize', 'titleCode', 'ruleVersion', 'snapshotStartedAt'],
        properties: {
          responseVersion: { type: 'string', enum: ['current-qualified-478-v2'] },
          rows: { type: 'array', description: '确定匹配所选 status 的有界页（默认 effective）；保留所有既有行字段。', items: { type: 'object', required: ['qualificationAssessment'], properties: {
            qualificationAssessment: { type: 'object', description: '完整共享 T2；scope 为 enterpriseId/asOf/ruleVersion/assessmentVersion，snapshotId=SHA256(JSON([scope,titles]))。titles 保留三称号及全部事实、输入版本、缺口、引用，不裁剪。', required: ['enterpriseId', 'asOf', 'ruleVersion', 'assessmentVersion', 'snapshotId', 'titles'], properties: {
              enterpriseId: { type: 'integer' }, asOf: { type: 'string', format: 'date-time' }, ruleVersion: { type: 'string', enum: ['current-roster-116-v14'] }, assessmentVersion: { type: 'string', enum: ['enterprise-qualification-807-v7'] }, snapshotId: { type: 'string' }, titles: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'object', additionalProperties: true } },
            } },
          } } },
          publishedPending: { type: 'object', required: ['requested', 'rows', 'total', 'page', 'pageSize'], properties: {
            requested: { type: 'boolean', description: '仅规范化非空 q 请求；false 的 total=0 不是待核总量。' }, total: { type: 'integer', minimum: 0, description: '本次身份/区县/本称号定位的完整 pending 数，独立于 eligible 及 uncertainTotal。' }, page: { type: 'integer', minimum: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 200 },
            rows: { type: 'array', description: '有界定位页，保留既有行字段及完整三称号 qualificationAssessment；not_matched/not_established 仍可显示公布事实。', items: { type: 'object', required: ['qualificationAssessment', 'filterMatch'], properties: {
              qualificationAssessment: { type: 'object', description: '与 rows 完全相同的完整 T2 scope、三称号、输入版本与 digest 契约。', required: ['enterpriseId', 'asOf', 'ruleVersion', 'assessmentVersion', 'snapshotId', 'titles'], properties: {
                enterpriseId: { type: 'integer' }, asOf: { type: 'string', format: 'date-time' }, ruleVersion: { type: 'string', enum: ['current-roster-116-v14'] }, assessmentVersion: { type: 'string', enum: ['enterprise-qualification-807-v7'] }, snapshotId: { type: 'string' }, titles: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'object', additionalProperties: true } },
              } },
              filterMatch: { type: 'object', required: ['status', 'checks'], properties: {
                status: { type: 'string', enum: ['matched', 'not_matched', 'not_established'], description: '同周期同来源行 AND 见证；只解释已选筛选，不是资格结论。无选定字段时 matched/checks=[]。' },
                checks: { type: 'array', items: { type: 'object', required: ['field', 'status'], properties: { field: { type: 'string', enum: ['recognitionRange', 'validYear', 'maintenanceYear', 'maintenanceBatch'] }, status: { type: 'string', enum: ['matched', 'not_matched', 'not_established'] } } } },
              } },
            } } },
          } },
          total: { type: 'integer', minimum: 0 }, uncertainTotal: { type: 'integer', minimum: 0, description: '仅旧认定日期精度语义，不包含资格 pending。' }, options: { type: 'object', additionalProperties: true }, page: { type: 'integer' }, pageSize: { type: 'integer' }, titleCode: { type: 'string' }, ruleVersion: { type: 'string' }, snapshotStartedAt: { type: 'string', format: 'date-time' },
        },
      } } },
    },
    400: { description: '查询参数非法。' }, 503: { description: '读取执行器不可用，请重试；不表示零记录。' },
  },
} })

export default defineEventHandler(event => {
  const parsed = parseCurrentQualifiedQuery(getQuery(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Invalid current-qualified query' })
  admitEnterpriseResponse(event)
  setHeader(event, 'cache-control', 'no-store')
  return withEnterpriseReadSignal(event, async signal => {
    const result = await enterpriseReads.currentQualifiedJson(useDb().$client.name, parsed.data, signal, requestLogContext(event))
    setHeader(event, 'content-type', 'application/json; charset=utf-8')
    return result.body
  })
})
