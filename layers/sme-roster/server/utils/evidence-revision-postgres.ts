import { and, eq, max, sql } from 'drizzle-orm'
import {
  evidenceImpactProgress113, evidenceRevision113, evidenceRevisionEvent113, evidenceScopeVersion113, evidenceSemanticHead113,
} from '../../../../db/postgresql/evidence-review-tables'
import { record, recordEvent } from '../../../../db/postgresql/ledger-tables'
import { differenceReason } from '../../../../db/postgresql/roster-selection-tables'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { evidenceDigest113 } from './evidence-digest'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Revision = {
  sourceKind: string; sourceKey: string; sourceVersion: string; factDigest: string
  beforeFactDigest?: string; coverageDigest?: string; queryExecuted?: boolean
  enterpriseId?: number; titleCode?: string; direction?: string; eventId?: number
  metadata?: Record<string, unknown>
}
const empty = evidenceDigest113([])

export async function appendPostgresEvidenceRevision(tx: Tx, input: Revision) {
  const sourceKey = `${input.sourceKind}:${input.sourceKey}`
  const coverage = input.coverageDigest ?? empty
  const metadata = JSON.stringify(input.metadata ?? {})
  if (Buffer.byteLength(metadata) > 16384) throw new Error('Evidence revision metadata exceeds 16KiB')
  const latestDecision = tx.select({ id: max(differenceReason.id).as('id') }).from(differenceReason).as('latest_decision')
  const [snapshot] = await tx.select({
    maxDecisionId: latestDecision.id, coverageDigest: evidenceSemanticHead113.coverageDigest, factDigest: evidenceSemanticHead113.factDigest,
  }).from(latestDecision).leftJoin(evidenceSemanticHead113, eq(evidenceSemanticHead113.sourceKey, sourceKey))
  const coverageChanged = Number(coverage !== (snapshot!.coverageDigest ?? empty))
  const factChanged = Number(input.factDigest !== (input.beforeFactDigest ?? snapshot!.factDigest ?? empty))
  if (!coverageChanged && !factChanged) return null
  const [revision] = await tx.insert(evidenceRevision113).values({
    sourceKind: input.sourceKind, sourceKey, sourceVersion: input.sourceVersion, enterpriseId: input.enterpriseId,
    titleCode: input.titleCode, direction: input.direction, eventId: input.eventId,
    coverageDigest: coverage, factDigest: input.factDigest, coverageChanged, factChanged,
    queryExecuted: Number(input.queryExecuted ?? false), metadata, maxDecisionId: snapshot!.maxDecisionId ?? 0,
    createdAt: new Date().toISOString(),
  }).onConflictDoNothing({ target: [evidenceRevision113.sourceKind, evidenceRevision113.sourceKey, evidenceRevision113.sourceVersion] })
    .returning({ id: evidenceRevision113.id })
  if (!revision) return null
  const head = { coverageDigest: coverage, factDigest: input.factDigest, latestRevisionId: revision.id }
  await tx.insert(evidenceSemanticHead113).values({ sourceKey, ...head })
    .onConflictDoUpdate({ target: evidenceSemanticHead113.sourceKey, set: head })
  await tx.insert(evidenceImpactProgress113).values({ revisionId: revision.id })
  const scope = JSON.stringify([input.enterpriseId ?? null, input.titleCode ?? null, input.direction ?? null])
  await tx.insert(evidenceScopeVersion113).values({ scopeKey: scope, latestRevisionId: revision.id, pendingCount: 1 })
    // Drizzle has no arithmetic update operator. Keep the increment atomic inside ON CONFLICT.
    .onConflictDoUpdate({ target: evidenceScopeVersion113.scopeKey, set: {
      latestRevisionId: revision.id, pendingCount: sql`${evidenceScopeVersion113.pendingCount} + 1`,
    } })
  if (input.eventId != null && input.enterpriseId != null && input.titleCode != null) {
    await tx.insert(evidenceRevisionEvent113).values({
      revisionId: revision.id, eventId: input.eventId, enterpriseId: input.enterpriseId, titleCode: input.titleCode,
    }).onConflictDoNothing()
  }
  return revision.id
}

export async function capturePostgresOfficialEventRevision(tx: Tx, eventId: number, beforeRevision: number, afterRevision: number) {
  const [owner] = await tx.select({ enterpriseId: record.enterpriseId, titleCode: record.titleCode }).from(recordEvent)
    .innerJoin(record, eq(record.id, recordEvent.recordId)).where(eq(recordEvent.id, eventId))
  if (!owner) throw new Error('Official event owner missing')
  return appendPostgresEvidenceRevision(tx, { sourceKind: 'official_event', sourceKey: String(eventId), sourceVersion: String(afterRevision),
    ...owner, eventId, beforeFactDigest: evidenceDigest113([eventId, beforeRevision]), factDigest: evidenceDigest113([eventId, afterRevision]),
    metadata: { eventId, beforeRevision, afterRevision },
  })
}

export async function advancePostgresOfficialEventRevision(tx: Tx, eventId: number, expectedRevision: number) {
  const revision = expectedRevision + 1
  const changed = await tx.update(recordEvent).set({ revision }).where(and(
    eq(recordEvent.id, eventId), eq(recordEvent.revision, expectedRevision),
  )).returning({ id: recordEvent.id })
  if (changed.length !== 1) throw Object.assign(new Error('Official event revision changed'), { code: 'stale_revision', statusCode: 409 })
  await capturePostgresOfficialEventRevision(tx, eventId, expectedRevision, revision)
  return revision
}
