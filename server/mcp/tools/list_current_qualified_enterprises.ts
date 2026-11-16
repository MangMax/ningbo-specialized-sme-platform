import type { LogContext } from '../../../lib/logging'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { currentQualifiedFilterSchema } from '../../utils/current-qualified-filter'
import { enterpriseReads } from '../../utils/enterprise-read'

export default defineMcpTool({
  name: 'list_current_qualified_enterprises',
  title: '查询当前有效及搜索定位的已公布待核企业',
  description: '#484：旧解释有效性、回执、查询覆盖与决定生命周期退出默认有效判定；仅显式旧评估版本保留历史语义。#478：有效资格仅由正式认定/复核期间及已确认、证据完整的注销/吊销或迁出事实决定；差异决定、身份、来源、解释有效性和平台缺口只作备注。effectiveQualification 包含 status（effective/expired/terminated/moved_out/unrecognized）、basis、notes；旧字段及旧评估版本可读。与 GET /api/roster/current-enterprises 同语义，responseVersion=current-qualified-478-v2。指定单一称号，资格统一来自共享 enterprise-qualification-740-v5 T2 / current-roster-116-v12，按本地规则：有效小巨人计入两个低梯度、有效省专计入创新型，无须低梯度自身历史；自身有效期间优先，否则展示实际支撑称号及期间，正式历史各自保留；平台无记录、不通过、查询失败或未查询不单独否定正式有效资格。rows 只含所选 status 且确定匹配筛选的企业（effective/expired/terminated/moved_out/unrecognized；省略默认 effective），total 是其完整分页前计数。publishedPending={requested,rows,total,page,pageSize} 独立定位本称号有适用正式公布依据且 T2 pending 的企业（excluded 不进入）：仅通过原参数校验且规范化非空 q 时 requested=true，按现名/统一社会信用代码/已确认曾用名和 district 定位；requested=false 的 rows=[]/total=0 不表示全库无待核企业。两组复用 sort/稳定ID及同 page/pageSize，各自完整 total；pending 不计入 total/uncertainTotal。pending 行 filterMatch.status=matched/not_matched/not_established，checks 只含所选 recognitionRange/validYear/maintenanceYear/maintenanceBatch，同周期同来源行 AND、不跨行拼接；即使不匹配或不能确认仍保留身份定位事实，匹配也不代表资格有效。两组有界页每行 qualificationAssessment 均保留完整三称号 titles、enterpriseId/asOf/ruleVersion/assessmentVersion scope、各输入版本和 snapshotId=SHA256(JSON([scope,titles]))。asOf=snapshotStartedAt，资格评价日取执行时点 Asia/Shanghai 日历日，来源明确有效期含首尾；年度规则取该日所在年，不是来源 validYear/首次认定年/认定窗口；当前事实查询不是历史数据库回放。当前授予事件及其已确认归档平台返回行上的有效条件按 AND 匹配；实际授予年份精度仅被日期闭区间完整包含时确定命中，部分重叠计 uncertainTotal，仍仅为日期精度计数。仅 observed innovative_sme 的 queryBusList schema 支持 date-only rddqrq→有效年、返回 whpcyear 为空时 YYYY-N 型 whpc 年份前缀→维护年；批次后缀、datetime、非空 whpcyear/plain batch、其他称号和格式均未知；查询谓词仅用于冲突校验，缺失或矛盾保持未知，不等于 dueYear。维护批次须附维护年份。options 仍为所选称号当前有效行的可查询见证。原输入边界、invalid arguments/400、不可用503及预算语义不变；失败须重试，不能视为零记录。不返回原始平台字段；同一只读快照。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: currentQualifiedFilterSchema.shape,
  handler: async (input, extra) => {
    const result = await enterpriseReads.currentQualifiedJson(useDb().$client.name, currentQualifiedFilterSchema.parse(input), extra?.signal, (extra as typeof extra & { logContext?: LogContext })?.logContext)
    return result.body.toString('utf8')
  },
})
