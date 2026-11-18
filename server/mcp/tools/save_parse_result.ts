import type { LogContext } from '../../../layers/core/lib/logging'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { parseSave105, saveParseMcp105 } from '../../utils/parse-maintenance-105'
import { writeGuard } from '../../utils/mcp-guard'
export default defineMcpTool({
  name: 'save_parse_result', title: '写回解析段/状态(兼容旧载荷及版本保护)',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  enabled: writeGuard,
  description: [
    '按稳定fileId或精确relPath(恰给其一)写解析段与/或parseState。需要NUXT_MCP_TOKEN。',
    '兼容入口:历史unknown结果可沿用无inputRef写入;一旦结果bound,任何段替换必须带完整inputRef,否则409要求重读预检,不能降回unknown。仅状态更正保留原依据,真回放先返回原回执。当前解析应先preflight_file_parse_result,再commit_file_parse_result强制冻结输入。',
    '旧载荷仅{fileId|relPath,parts?,parseState?}保持可用,返回原{file,parts,parseState};仅改状态时顶层parts=[]、file.parts保留。旧调用为盲写,无客户端并发/幂等恢复保护,审计明确归属于legacy adapter,不代表用户确认依据。',
    '现代载荷先get_file_parse_result读取version,再完整提供expectedVersion/idempotencyKey/actor:{type:user|agent,id}/reason。部分混入现代封套字段一律拒绝,不得降级。现代成功返回{receiptId,replayed,state}。',
    '容量上限(两种载荷均适用):最多1000段、每个attachment最多500字符;超限明确拒绝且不写入、不截断。',
    'parts是全部代理段的全量替换;[]清空代理段并恢复evidence派生段。省略parts只改parseState,所有段保留。提供parts而省略parseState置parsed。null不等于省略。',
    '#669 declarationId修改稳定声明;pageRanges省略保留,[]清空,非空必须物理页预检及commit_file_parse_result。get_file_parse_result.declarations与历史回执提供范围及依据。',
    '每段titleCode/eventKind必填,year1900–2100或null(复核=原认定年份),batch正整数或null,attachment归一,rowCount省略0。派生段保留;同坐标代理优先,行数不一致hasConflict。重复段/非法/未知字段整批拒绝。',
    '版本冲突、异载荷复用幂等键拒绝;同键同规范载荷返回原回执,不覆盖后续编辑。返回{receiptId,replayed,state},state与REST GET完全相同。',
    '只写stored_file_part、parse_state和解析审计;不写文件元数据/OCR/企业/记录/事件/出处。parsed不表示名录校验通过。更正用新版本新键;[]撤回代理声明,不物理删除来源历史。',
  ].join('\n'),
  inputSchema: parseSave105.shape,
  handler: (input, extra) => saveParseMcp105(useDb(), input, (extra as { logContext?: LogContext } | undefined)?.logContext, useRuntimeConfig().filesDir),
})
