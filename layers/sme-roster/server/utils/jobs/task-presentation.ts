import { taskSummaryError, type TaskErrorFacts } from '../../../../core/server/utils/task-summary'

export const platformTaskLinks = () => [
  { label: '平台查询证据', to: '/platform-queries' },
]

export const taskRetryReason = '仅补查本批次未完成项，保留已完成结果。'

export function rosterTaskError(row: TaskErrorFacts & { kind: string }) {
  switch (row.kind) {
    case 'current-roster-export':
      return taskSummaryError(row, '导出失败；请检查数据与产物存储后显式重新生成。原始错误不展示。')
    case 'platform-query-batch':
      return taskSummaryError(row, '批次有失败或未完成范围；请查看摘要并显式重试。')
    default:
      return taskSummaryError(row)
  }
}
