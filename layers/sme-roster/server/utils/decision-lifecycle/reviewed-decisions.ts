import { and, eq, exists, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { alias, QueryBuilder, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { importBatch } from '../../../../../db/postgresql/import-tables'
import { differenceReason } from '../../../../../db/postgresql/roster-selection-tables'

export const reviewedReplacementKind = 'reviewed_difference_replacement'
export const maintainedDifferenceKind = 'maintained_difference'
export const retiredReviewProcessKind = 'retired_evidence_review_process'

export function reviewReplayKey(key: string) {
  return 'evidence-review:' + key
}

export function reviewTarget(decisionId: AnyPgColumn) {
  return and(inArray(importBatch.sourceKind, [reviewedReplacementKind, maintainedDifferenceKind]), targetIdentityMatches(decisionId))
}

function targetIdentityMatches(decisionId: AnyPgColumn) {
  // Drizzle lacks a typed cast for bigint IDs compared with text batch identities.
  return eq(importBatch.sourceIdentity, sql`${decisionId}::text`)
}

export function isManagedDifference() {
  const successor = alias(differenceReason, 'reviewed_successor')
  const maintained = new QueryBuilder().select({ id: importBatch.id }).from(importBatch)
    .where(and(eq(importBatch.sourceKind, maintainedDifferenceKind), targetIdentityMatches(differenceReason.id)))
  const adopted = new QueryBuilder().select({ id: successor.id }).from(successor)
    .innerJoin(importBatch, targetIdentityMatches(successor.id))
    .where(and(eq(importBatch.sourceKind, reviewedReplacementKind), eq(successor.previousId, differenceReason.id)))
  return or(isNotNull(differenceReason.lifecycleAction), exists(maintained), exists(adopted))
}
