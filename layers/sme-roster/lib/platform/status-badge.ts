export type SemanticBadgeVariant = 'success' | 'info' | 'warning' | 'error' | 'quiet'

/**
 * 将平台申报记录与关联办理中的状态文案映射为语义徽章变体。
 * 按高优先级风险词（否定/失败/撤销）先判定，避免「未通过」误命中「通过」。
 */
export function platformStatusVariant(value: string | null | undefined): SemanticBadgeVariant {
  const text = value?.trim()
  if (!text || text === '未提供' || text === '未知') return 'quiet'
  if (/不通过|未通过|驳回|拒绝|失败|无效|撤销|注销|终止|取消|退回/.test(text)) return 'error'
  if (/待核|待补|补正|退回修改|暂停|异常|冲突|缺|待审/.test(text)) return 'warning'
  if (/通过|已认定|有效|已完成|已公示|已入库|认定成功|复核通过/.test(text)) return 'success'
  if (/审核中|受理|办理中|进行中|已提交|公示中|申报中|待受理|已上报/.test(text)) return 'info'
  return 'quiet'
}
