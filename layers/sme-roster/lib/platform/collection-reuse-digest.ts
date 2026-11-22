import { createHash } from 'node:crypto'
import { z } from 'zod'
import { platformQueryResultShape, type PlatformLiveQueryResult } from './live-query'
import { canonicalPlatformJson } from './observation-plan'

export const collectionEvidenceShape = z.object(platformQueryResultShape)

export function reusableCollectionContent(result: PlatformLiveQueryResult) {
  const rows = result.dataRows ?? result.rawData?.rows
  if (!result.pages.length || result.pages.some((page, index) => page.page !== index + 1 || page.status !== 'success')) return null
  if (!rows || result.completeness !== 'complete' || !result.fullRange || !['success', 'no_record'].includes(result.status)) return null
  return canonicalPlatformJson({
    source: result.source, conditions: result.effectiveConditions, scope: result.titleScope,
    status: result.status, rows: rows.map(canonicalPlatformJson).sort(),
  })
}

export function platformCollectionReuseSha256(evidence: unknown) {
  if (!collectionEvidenceShape.safeParse(evidence).success) return null
  const content = reusableCollectionContent(evidence as PlatformLiveQueryResult)
  return content === null ? null : createHash('sha256').update(content).digest('hex')
}
