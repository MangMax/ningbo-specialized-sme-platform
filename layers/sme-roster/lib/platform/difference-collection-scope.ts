import type * as s from '../../../../db/schema'

export type DifferenceCollectionScopeRows = {
  collection: typeof s.platformCollection.$inferSelect
  conditions: Pick<typeof s.platformCollectionCondition.$inferSelect, 'name' | 'valueKind' | 'textValue' | 'integerValue'>[]
  pages: (typeof s.platformCollectionPage.$inferSelect)[]
  unfinished: (typeof s.platformCollectionUnfinished.$inferSelect)[]
  titles: string[]
}
export function projectDifferenceCollectionScope({ collection, conditions: input, pages, unfinished, titles }: DifferenceCollectionScopeRows) {
  const conditions: Record<string, unknown> = {}
  let conditionsKnown = true
  for (const row of input) {
    switch (row.valueKind) {
      case 'absent': break
      case 'null': conditions[row.name] = null; break
      case 'text': conditions[row.name] = row.textValue; break
      case 'integer': conditions[row.name] = row.integerValue; break
      case 'boolean': conditions[row.name] = !!row.integerValue; break
      default: conditionsKnown = false
    }
  }
  const metadata = collection.parseState === 'valid' && conditionsKnown ? {
    source: collection.source, status: collection.evidenceStatus, effectiveConditions: conditions,
    titleScope: { mode: collection.scopeMode, rdjb: titles },
    pages: pages.map(p => ({ source: p.source, rdjb: p.rdjb, page: p.pageNo, ...(p.maxPagePresent?{maxPage:p.maxPage}:{}), status:p.status, fetchedCount:p.fetchedCount, declaredTotal:p.declaredTotal,
      error: p.errorCode === null && p.errorMessage === null ? null : { code: p.errorCode, message: p.errorMessage } })),
    completeness: collection.completeness, fullRange: collection.fullRange === null ? null : !!collection.fullRange,
    unfinished: unfinished.map(p => ({ source: p.source, rdjb: p.rdjb, page: p.pageNo })),
    error: collection.errorCode === null && collection.errorMessage === null ? null : { code: collection.errorCode, message: collection.errorMessage },
    limits: { maxRequests: collection.maxRequests, maxRows: collection.maxRows, maxDurationMs: collection.maxDurationMs, pageSize: collection.pageSize },
  } : null
  return { collection, conditions, conditionsKnown, pages, unfinished, metadata }
}
