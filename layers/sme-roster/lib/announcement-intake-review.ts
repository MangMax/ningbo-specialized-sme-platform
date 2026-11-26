import { normalizeReviewedUscc } from '#core/lib/enterprise-uscc'
import type { BatchSupplementDecision } from '#core/lib/core/enterprise-batch-supplement'
import { normalizeName } from './domain'
import type { SupplementAnnouncementRequest } from './roster-import-client'

export function announcementSubjectDecisions(decisions: readonly BatchSupplementDecision[]): SupplementAnnouncementRequest['rows'] {
  const createdByUscc = new Map<string, number>()
  const createdByName = new Map<string, number>()
  const attached = new Map<number, { row: number; fields: string }>()
  return decisions.map(({ key: _key, ...decision }, index) => {
    if (decision.action === 'attach') {
      const fields = JSON.stringify(decision.fields)
      const previous = attached.get(decision.enterpriseId)
      if (previous?.fields === fields && fields !== '{}') return { action: 'same_subject', row: previous.row }
      if (!previous) attached.set(decision.enterpriseId, { row: index, fields })
      return decision
    }

    const uscc = normalizeReviewedUscc(decision.fields.uscc ?? '')
    const name = normalizeName(decision.fields.name)
    const identities = uscc ? createdByUscc : createdByName
    const identity = uscc || name
    const previous = identities.get(identity)
    if (previous === undefined) {
      identities.set(identity, index)
      return decision
    }

    const first = decisions[previous]!
    if (first.action === 'create') {
      for (const field of ['districtCode', 'townshipCode', 'industryCode'] as const) {
        if ((decision.fields[field] ?? null) !== (first.fields[field] ?? null)) {
          throw new Error(`第 ${previous + 1}、${index + 1} 行为同一主体，请统一核对区划和行业。`)
        }
      }
      if (normalizeName(first.fields.name) !== name) {
        throw new Error(`第 ${previous + 1}、${index + 1} 行信用代码相同，请统一核对现用名称。`)
      }
    }
    return { action: 'same_subject', row: previous }
  })
}
