import type { EventArchiveCandidate } from '#sme-roster/lib/roster/event-archive-candidates'
import type { RelationSource } from '#sme-roster/lib/roster/correspondence-view'
import { PLATFORM_INTERFACES, PLATFORM_QUERY_STATUSES, RELATION_DECLARE_KINDS, TITLES } from '#sme-roster/lib/labels'

export const DECISION_EFFECTS = {
  confirm: '确认这条平台记录与本次正式事项有关。只确认当前这条来源的对应关系，不代表其他接口的记录也已确认。',
  reject: '排除这条平台记录作为本次事项的候选。保留否定依据和历史，自动处理不会重新推荐这条对应。',
  unlink: '解除当前记录与本次事项的对应，保留历史决定和依据。解除后不再作为有效对应出处，也不会自动重新推荐。',
  correct: '将当前对应解除，并确认所选新记录与本次事项对应。两项在一次提交中同时完成；任一不满足条件，均不更换。旧对应的历史保留。',
  revalidate: '按当前来源重新核验这条历史对应；提交后保留此前决定和本次核验依据。',
} as const

const recorded = (value: string | number | null | undefined) => value == null || value === '' ? '未记录' : String(value)

/** Read only known fields; unknown legacy values remain visible without guessing their meaning. */
export function platformDecisionSummary(row?: EventArchiveCandidate | null, relation?: RelationSource | null): string {
  const process = row?.evidence?.process as (EventArchiveCandidate['evidence']['process'] & { status?: string | null }) | undefined
  const kind = row?.evidence?.process?.declareKind ?? relation?.declareKind
  const source = row?.evidence?.source
  const title = row?.evidence?.title?.row ?? relation?.query?.titleCode
  const business = [title ? TITLES[title] ?? title : null, kind ? RELATION_DECLARE_KINDS[kind] ?? `事项未识别（${kind}）` : '事项未记录'].filter(Boolean).join(' · ')
  const iface = source?.interface ?? relation?.query?.interface
  const queryStatus = source?.status ?? relation?.query?.status
  return `${business} · 申报时间：${recorded(row?.evidence?.process?.appliedAt ?? relation?.appliedAt)} · ${iface ? PLATFORM_INTERFACES[iface] ?? `接口未识别（${iface}）` : '接口未记录'} · 状态：${recorded(process?.status ?? relation?.status)} · 查询：${queryStatus ? PLATFORM_QUERY_STATUSES[queryStatus] ?? queryStatus : '未记录'}`
}

/** Similar business records retain observation distinctions; IDs are only a final tie breaker. */
export function replacementDecisionOptions(rows: EventArchiveCandidate[]) {
  const summaries = rows.map(row => platformDecisionSummary(row))
  const observations = rows.map((row, index) => {
    const source = row.evidence.source
    return `${summaries[index]} · 采集：${recorded(source.queriedAt)} · 第 ${recorded(source.sourcePage)} 页 / 第 ${recorded(source.sequenceNo)} 行`
  })
  return rows.map((row, index) => ({
    id: String(row.edge.relationId),
    label: summaries.filter(text => text === summaries[index]).length === 1 ? summaries[index]! : observations.filter(text => text === observations[index]).length === 1 ? observations[index]! : `${observations[index]} · 来源编号 ${row.edge.relationId}`,
  }))
}
