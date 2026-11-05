/** Current bytes and historical provenance are independent facts. */
export interface ContentIdentity { status: string; registered?: { fileId: number; sha256: string; bytes: number } | null }
export function currentContentMessage(identity?: ContentIdentity | null): string {
  switch (identity?.status) {
    case 'verified': return '当前文件内容与登记一致。'
    case 'file_content_conflict': return '当前文件内容已变化，与登记不一致。请核对并恢复原文件后重试；历史文本与出处仍保留。'
    case 'missing': return '当前源文件不存在，请核对路径或恢复原文件后重试。历史记录仍保留。'
    case 'unavailable': return '当前源文件暂时无法读取，请检查读取权限后重试。历史记录仍保留。'
    default: return '当前文件内容身份待核实；登记信息不能证明历史出处。'
  }
}
export function historicalContentMessage(binding?: { status: string }): string {
  return binding?.status === 'captured'
    ? '历史文本保留了采集输入引用；这不证明完整历史文件内容，也不代表当前文件已核实。'
    : '历史文本的原始内容绑定未知；当前文件核实不会补全历史出处。'
}
export function contentFailureMessage(error: unknown): string | null {
  const e = error as { data?: { data?: { code?: string }; code?: string; message?: string }; message?: string }
  const code = e?.data?.data?.code ?? e?.data?.code ?? e?.data?.message ?? e?.message ?? String(error)
  if (code.includes('file_content_unknown')) return currentContentMessage(null)
  if (code.includes('file_content_conflict')) return currentContentMessage({ status: 'file_content_conflict' })
  return null
}
