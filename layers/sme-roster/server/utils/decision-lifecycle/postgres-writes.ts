import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { alias } from 'drizzle-orm/pg-core'
import { enterprise as enterpriseTable } from '../../../../../db/postgresql/enterprise-tables'
import { evidenceReviewReceipt114 } from '../../../../../db/postgresql/evidence-review-tables'
import { enterpriseFactRevision } from '../../../../../db/postgresql/qualification-tables'
import { differenceReason } from '../../../../../db/postgresql/roster-selection-tables'
import {
  platformBusinessObservation, platformBusinessRecordVersion, platformCollection, platformObservationAssignment,
} from '../../../../../db/postgresql/platform-tables'
import type { platformBusinessObservation as PlatformBusinessObservationTable, platformCollection as PlatformCollectionTable, platformObservationAssignment as PlatformObservationAssignmentTable } from '../../../../../db/postgresql/platform-tables'
import type { EnterpriseFactRevision } from '../enterprise-fact-model'
import { decodePostgresExactCell } from '../../../../../db/postgresql/exact-cell'
import { readPostgresDifferenceObservations } from '../../../lib/platform/difference-sources-postgres'
import { readPostgresCollectionScopes } from '../../../lib/roster/query-coverage-postgres'
import { postgresRosterRow } from '../../../lib/roster/postgres-rows'
import { checkDecisionFact102, checkDecisionHead102, checkDecisionPriorTime102, checkDecisionQuery102, checkDecisionRelation102, decisionContent102, DecisionError102, decisionReceipt102, decisionRequestHash102, decisionValues102, internalDecisionCommand102, parse102, qualificationCommit102, qualificationPlanHash, qualificationPlanRule, qualificationPreflight102, type DecisionCommand102 } from '../decision-lifecycle/contract'
import { readPostgresDecisionHead102, requirePostgresDecisionEnterprise } from './postgres-reads'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Observation = Omit<typeof PlatformBusinessObservationTable.$inferSelect, 'witnessRdjbValue' | 'witnessPageValue'> & {
  witnessRdjbValue: ReturnType<typeof decodePostgresExactCell>
  witnessPageValue: ReturnType<typeof decodePostgresExactCell>
}
type Fact = EnterpriseFactRevision

export function lockPostgresDecisionOwnership102(tx: Tx) {
  return tx.execute(sql`SELECT pg_advisory_xact_lock(42458,114)`)
}

async function readObservationPin(tx: Tx, id: number) {
  const p = alias(platformBusinessObservation, 'p')
  const [stored] = await tx.select({
    observation: sql<Observation>`${postgresRosterRow(platformBusinessObservation, 'p')}`,
    rdjb: p.witnessRdjbValue, rdjbType: p.witnessRdjbValueSqliteStorage,
    page: p.witnessPageValue, pageType: p.witnessPageValueSqliteStorage,
  }).from(p).where(eq(p.id, id))
  if (!stored) return undefined
  stored.observation.witnessRdjbValue = decodePostgresExactCell(stored.rdjb, stored.rdjbType)
  stored.observation.witnessPageValue = decodePostgresExactCell(stored.page, stored.pageType)
  return stored.observation
}

async function prepareDecision(tx: Tx, command: DecisionCommand102, capturePins: boolean) {
  const owner = await requirePostgresDecisionEnterprise(tx, command.enterpriseId)
  const enterprise = { id: owner.id, usccNorm: owner.usccNorm, nameNorm: owner.nameNorm }
  const previous = await readPostgresDecisionHead102(tx, command)
  checkDecisionHead102(command, previous)
  const d = decisionContent102(command)
  const refs = d.factReferences ?? []
  const fact = alias(enterpriseFactRevision, 'p')
  const factsById = refs.length ? await tx.selectDistinctOn([fact.factId], {
    fact: sql<Fact>`${postgresRosterRow(enterpriseFactRevision, 'p')}`,
  }).from(fact).where(and(eq(fact.enterpriseId, command.enterpriseId), inArray(fact.factId, refs.map(ref => ref.factId))))
    .orderBy(fact.factId, desc(fact.revision)) : []
  const facts = refs.map(ref => {
    const fact = factsById.find(row => row.fact.factId === ref.factId)?.fact
    checkDecisionFact102(command.enterpriseId, ref, fact)
    return fact
  })
  const relation = d.evidenceRelationId ? (await readPostgresDifferenceObservations(tx, [d.evidenceRelationId])).get(d.evidenceRelationId) : null
  checkDecisionRelation102(enterprise, d, relation)
  const queryId = d.evidenceQueryId ?? relation?.queryId
  const c = alias(platformCollection, 'c')
  const targetQuery = queryId ? (await tx.select({
    id: c.publicId, collection: sql<typeof PlatformCollectionTable.$inferSelect>`${postgresRosterRow(platformCollection, 'c')}`,
  }).from(c).where(eq(c.publicId, queryId)))[0] : null
  const collection = targetQuery?.collection
  const needsPages = relation && collection?.rdjb.includes(',')
  const sourceScope = collection && (capturePins || needsPages) ? (await readPostgresCollectionScopes(tx, [collection])).get(collection.id)! : null
  checkDecisionQuery102(command, enterprise, queryId, targetQuery, relation, () => sourceScope!.pages)
  checkDecisionPriorTime102(command, previous)
  if (!capturePins) return { previous, d, targetQuery, relation, pins: null }
  const observation = relation ? await readObservationPin(tx, relation.observationId) : null
  const v = alias(platformBusinessRecordVersion, 'p'), assignmentTable = alias(platformObservationAssignment, 'p')
  const version = observation?.versionId ? (await tx.select({
    id: v.id, recordId: v.recordId, hashAlgorithm: v.hashAlgorithm, contentHash: v.contentHash, createdAt: v.createdAt,
  }).from(v).where(eq(v.id, observation.versionId)))[0] : null
  const assignment = observation ? (await tx.select({
    row: sql<typeof PlatformObservationAssignmentTable.$inferSelect>`${postgresRosterRow(platformObservationAssignment, 'p')}`,
  }).from(assignmentTable).where(eq(assignmentTable.observationId, observation.id)).orderBy(desc(assignmentTable.revision)).limit(1))[0]?.row : null
  const sourceVersions = observation?.recordId ? await tx.select({ id: v.id, contentHash: v.contentHash })
    .from(v).where(eq(v.recordId, observation.recordId)).orderBy(desc(v.id)).limit(1) : []
  const pins = { sourceVersions, enterprise, previous: previous ?? null, relation, observation, version, assignment, sourceScope, facts }
  return { previous, d, targetQuery, relation, pins }
}

export async function preflightPostgresQualification102(db: NodePgDatabase, input: unknown) {
  const command = parse102(qualificationPreflight102, input)
  return db.transaction(async tx => {
    const { pins } = await prepareDecision(tx, command, true)
    return { command, planHash: qualificationPlanHash(command, pins), planRuleVersion: qualificationPlanRule,
      qualification: command.decision!.currentQualification!, movedIn: command.decision!.movedIn ?? null,
      facts: pins!.facts, source: pins!.relation, latestKnownSourceVersion: pins!.sourceVersions[0] ?? null }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export function savePostgresDecision102(db: NodePgDatabase, input: DecisionCommand102, planHash?: string) {
  const command = parse102(internalDecisionCommand102, input)
  const hash = decisionRequestHash102(command, planHash)
  return db.transaction(async tx => {
    await lockPostgresDecisionOwnership102(tx)
    const receipt = evidenceReviewReceipt114
    const [review] = await tx.select({ hash: receipt.requestHash, response: sql<Record<string, unknown>>`${receipt.response}::json` })
      .from(receipt).where(eq(receipt.idempotencyKey, command.idempotencyKey))
    if (review) {
      if (review.hash !== hash) throw new DecisionError102(409, 'idempotency_conflict', 'Idempotency key already has a different request')
      return review.response
    }
    const reason = differenceReason
    const columns = { id: reason.id, lifecycleAction: reason.lifecycleAction, previousId: reason.previousId, recordedAt: reason.recordedAt }
    const [prior] = await tx.select({ ...columns, hash: reason.requestHash })
      .from(reason).where(eq(reason.idempotencyKey, command.idempotencyKey))
    if (prior) {
      if (prior.hash !== hash) throw new DecisionError102(409, 'idempotency_conflict', 'Idempotency key already has a different request')
      return decisionReceipt102(prior)
    }
    await tx.select({ id: enterpriseTable.id }).from(enterpriseTable).where(eq(enterpriseTable.id, command.enterpriseId)).for('update')
    if (command.reviewedEvidence || command.action === 'maintain') throw new DecisionError102(422, 'invalid_request', 'Automatic evidence review has been retired')
    const { previous, d, targetQuery, relation, pins } = await prepareDecision(tx, command, !!planHash)
    if (planHash && qualificationPlanHash(command, pins) !== planHash) throw new DecisionError102(409, 'stale_plan', 'Qualification plan changed; preflight again')
    const value = decisionValues102(command, previous, d, hash)
    const [row] = await tx.insert(reason).values({
      ...value,
      factReferences: JSON.stringify(value.factReferences),
      currentQualification: value.currentQualification === null ? null : JSON.stringify(value.currentQualification),
      actor: JSON.stringify(value.actor), createdAt: new Date().toISOString(),
      evidenceQueryId: d.evidenceQueryId ? targetQuery!.collection.id : null,
      evidenceRelationId: relation?.observationId ?? null,
    }).returning(columns)
    return decisionReceipt102(row!)
  })
}

export function commitPostgresQualification102(db: NodePgDatabase, input: unknown) {
  const envelope = parse102(qualificationCommit102, input)
  return savePostgresDecision102(db, envelope.command, envelope.planHash)
}
