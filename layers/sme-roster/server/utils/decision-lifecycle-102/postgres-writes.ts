import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../../db/schema'
import { decodePostgresExactCell } from '../../../../../db/postgresql/exact-cell'
import { readPostgresDifferenceObservations } from '../../../lib/platform/difference-sources-postgres'
import { readPostgresEvidenceImpacts113 } from '../../../lib/roster/query-assessment-postgres'
import { readPostgresCollectionScopes } from '../../../lib/roster/query-coverage-postgres'
import { postgresRosterRow, readPostgresRosterRowsById } from '../../../lib/roster/postgres-rows'
import {
  checkDecisionFact102, checkDecisionHead102, checkDecisionPriorTime102, checkDecisionQuery102, checkDecisionRelation102,
  decisionContent102, DecisionError102, decisionReceipt102, decisionRequestHash102, decisionValues102, internalDecisionCommand102,
  parse102, qualificationCommit102, qualificationPlanHash, qualificationPlanRule, qualificationPreflight102, type DecisionCommand102,
} from '../decision-lifecycle-102'
import { evidenceKeys113 } from '../evidence-impact-113'
import { readPostgresDecisionHead102, requirePostgresDecisionEnterprise } from './postgres-reads'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type ReceiptRow = Parameters<typeof decisionReceipt102>[0]
type Observation = typeof schema.platformBusinessObservation.$inferSelect
type Fact = typeof schema.enterpriseFactRevision.$inferSelect

export function lockPostgresDecisionOwnership102(tx: Tx) {
  return tx.execute(sql`SELECT pg_advisory_xact_lock(42458,114)`)
}

async function readObservationPin(tx: Tx, id: number) {
  const { rows: [stored] } = await tx.execute<{ observation: Observation;
    rdjb: Buffer | null; rdjbType: string | null; page: Buffer | null; pageType: string | null }>(sql`
    SELECT ${postgresRosterRow(schema.platformBusinessObservation,'p')} AS observation,
      witness_rdjb_value AS rdjb,witness_rdjb_value_sqlite_storage AS "rdjbType",
      witness_page_value AS page,witness_page_value_sqlite_storage AS "pageType"
    FROM platform_business_observation p WHERE p.id=${id}`)
  if (!stored) return undefined
  stored.observation.witnessRdjbValue = decodePostgresExactCell(stored.rdjb, stored.rdjbType)
  stored.observation.witnessPageValue = decodePostgresExactCell(stored.page, stored.pageType)
  return stored.observation
}

async function prepareDecision(tx: Tx, command: DecisionCommand102, capturePins: boolean) {
  const owner = await requirePostgresDecisionEnterprise(tx, command.enterpriseId)
  const enterprise = { id: owner.id, usccNorm: owner.usccNorm, nameNorm: owner.nameNorm }
  const previous = await readPostgresDecisionHead102(tx, command)
  const token = command.reviewedEvidence ? (await readPostgresEvidenceImpacts113(tx, [{
    scope: command, decisionId: null, latestDecisionId: previous?.id ?? null,
  }]))[0]!.token : undefined
  checkDecisionHead102(command, previous, token)
  const d = decisionContent102(command)
  const refs = d.factReferences ?? []
  const factsById = refs.length ? (await tx.execute<{ fact: Fact }>(sql`
    SELECT DISTINCT ON(p.fact_id) ${postgresRosterRow(schema.enterpriseFactRevision,'p')} AS fact
    FROM enterprise_fact_revision p WHERE enterprise_id=${command.enterpriseId}
      AND fact_id=ANY(${sql.param(refs.map(ref => ref.factId))}::bigint[]) ORDER BY p.fact_id,p.revision DESC`)).rows : []
  const facts = refs.map(ref => {
    const fact = factsById.find(row => row.fact.factId === ref.factId)?.fact
    checkDecisionFact102(command.enterpriseId, ref, fact)
    return fact
  })
  const relation = d.evidenceRelationId ? (await readPostgresDifferenceObservations(tx, [d.evidenceRelationId])).get(d.evidenceRelationId) : null
  checkDecisionRelation102(enterprise, d, relation)
  const queryId = d.evidenceQueryId ?? relation?.queryId
  const targetQuery = queryId ? (await tx.execute<{ id: number; collection: typeof schema.platformCollection.$inferSelect }>(sql`
    SELECT a.old_id::float8 AS id,${postgresRosterRow(schema.platformCollection,'c')} AS collection
    FROM platform_legacy_query_alias a JOIN platform_collection c ON c.id=a.collection_id WHERE a.old_id=${queryId}`)).rows[0] : null
  const collection = targetQuery?.collection
  const needsPages = relation && collection?.rdjb.includes(',')
  const sourceScope = collection && (capturePins || needsPages) ? (await readPostgresCollectionScopes(tx, [collection])).get(collection.id)! : null
  checkDecisionQuery102(command, enterprise, queryId, targetQuery, relation, () => sourceScope!.pages)
  checkDecisionPriorTime102(command, previous)
  if (!capturePins) return { previous, d, targetQuery, relation, pins: null }
  const observation = relation ? await readObservationPin(tx, relation.observationId) : null
  const version = observation?.versionId ? (await readPostgresRosterRowsById(tx, schema.platformBusinessRecordVersion,
    sql`FROM platform_business_record_version p WHERE id=${observation.versionId}`))[0] : null
  const assignment = observation ? (await tx.execute<{ row: typeof schema.platformObservationAssignment.$inferSelect }>(sql`
    SELECT ${postgresRosterRow(schema.platformObservationAssignment,'p')} AS row
    FROM platform_observation_assignment p WHERE observation_id=${observation.id} ORDER BY revision DESC LIMIT 1`)).rows[0]?.row : null
  const sourceVersions = observation?.recordId ? (await tx.execute<{ id: number; contentHash: string }>(sql`
    SELECT id::float8 AS id,content_hash AS "contentHash" FROM platform_business_record_version
    WHERE record_id=${observation.recordId} ORDER BY id DESC LIMIT 1`)).rows : []
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

async function finishReview(tx: Tx, command: DecisionCommand102, hash: string, result: ReturnType<typeof decisionReceipt102>, previousId: number | null) {
  if (!command.reviewedEvidence) return result
  const revisionId = command.reviewedEvidence.latestRevisionId
  const decisionId = result.versionId
  await tx.execute(sql`INSERT INTO explanation_impact_113(enterprise_id,title_code,direction,decision_id,latest_revision_id,
    pending_since_revision_id,reviewed_revision_id,classification)
    VALUES(${command.enterpriseId},${command.titleCode},${command.direction},${decisionId},${revisionId},${revisionId},${revisionId},'evidence_changed')
    ON CONFLICT(enterprise_id,title_code,direction,decision_id) DO UPDATE SET reviewed_revision_id=excluded.reviewed_revision_id`)
  if (previousId !== null && previousId !== decisionId) {
    await tx.execute(sql`UPDATE explanation_impact_113 SET reviewed_revision_id=${revisionId} WHERE decision_id=${previousId}
      AND enterprise_id=${command.enterpriseId} AND title_code=${command.titleCode} AND direction=${command.direction}`)
  }
  const response = { ...result, reviewedRevisionId: revisionId }
  await tx.execute(sql`INSERT INTO evidence_review_receipt_114(idempotency_key,request_hash,kind,enterprise_id,title_code,
    direction,decision_id,source_decision_id,reviewed_revision_id,actor,basis,rule_version,effective_at,response,recorded_at)
    VALUES(${command.idempotencyKey},${hash},${command.action},${command.enterpriseId},${command.titleCode},${command.direction},
      ${decisionId},${previousId},${revisionId},${JSON.stringify(command.actor)},${command.basis},${command.ruleVersion},
      ${command.effectiveAt},${JSON.stringify(response)},${new Date().toISOString()})`)
  return response
}

export function savePostgresDecision102(db: NodePgDatabase, input: DecisionCommand102, planHash?: string) {
  const command = parse102(internalDecisionCommand102, input)
  const hash = decisionRequestHash102(command, planHash)
  return db.transaction(async tx => {
    await lockPostgresDecisionOwnership102(tx)
    const { rows: [review] } = await tx.execute<{ hash: string; response: Record<string, unknown> }>(sql`
      SELECT request_hash AS hash,response::json AS response FROM evidence_review_receipt_114 WHERE idempotency_key=${command.idempotencyKey}`)
    if (review) {
      if (review.hash !== hash) throw new DecisionError102(409, 'idempotency_conflict', 'Idempotency key already has a different request')
      return review.response
    }
    const columns = sql`id::float8 AS id,lifecycle_action AS "lifecycleAction",previous_id::float8 AS "previousId",recorded_at AS "recordedAt"`
    const { rows: [prior] } = await tx.execute<ReceiptRow & { hash: string }>(sql`
      SELECT ${columns},request_hash AS hash FROM difference_reason WHERE idempotency_key=${command.idempotencyKey}`)
    if (prior) {
      if (prior.hash !== hash) throw new DecisionError102(409, 'idempotency_conflict', 'Idempotency key already has a different request')
      return decisionReceipt102(prior)
    }
    await tx.execute(sql`SELECT id FROM enterprise WHERE id=${command.enterpriseId} FOR UPDATE`)
    if (command.reviewedEvidence) {
      await tx.execute(sql`SELECT scope_key FROM evidence_scope_version_113
        WHERE scope_key=ANY(${sql.param(evidenceKeys113(command))}::text[]) ORDER BY scope_key FOR UPDATE`)
    }
    const { previous, d, targetQuery, relation, pins } = await prepareDecision(tx, command, !!planHash)
    if (planHash && qualificationPlanHash(command, pins) !== planHash) throw new DecisionError102(409, 'stale_plan', 'Qualification plan changed; preflight again')
    if (command.action === 'maintain') {
      const { rows: [row] } = await tx.execute<ReceiptRow>(sql`SELECT ${columns} FROM difference_reason WHERE id=${previous!.id}`)
      return finishReview(tx, command, hash, { ...decisionReceipt102(row!), action: 'maintain', recordedAt: new Date().toISOString() }, previous!.id)
    }
    const value = decisionValues102(command, previous, d, hash)
    const { rows: [row] } = await tx.execute<ReceiptRow>(sql`
      INSERT INTO difference_reason(enterprise_id,title_code,direction,status,reason_code,reason_note,measure_code,measure_note,
        verification_status,moved_in_city,moved_in_title_code,moved_in_year,moved_in_batch,fact_references,current_qualification,
        lifecycle_action,previous_id,actor,basis,rule_version,effective_at,idempotency_key,request_hash,recorded_at,created_at,evidence_query_id,evidence_relation_id)
      VALUES(${value.enterpriseId},${value.titleCode},${value.direction},${value.status},${value.reasonCode},${value.reasonNote},
        ${value.measureCode},${value.measureNote},${value.verificationStatus},${value.movedInCity},${value.movedInTitleCode},
        ${value.movedInYear},${value.movedInBatch},${JSON.stringify(value.factReferences)},
        ${value.currentQualification === null ? null : JSON.stringify(value.currentQualification)},${value.lifecycleAction},
        ${value.previousId},${JSON.stringify(value.actor)},${value.basis},${value.ruleVersion},${value.effectiveAt},${value.idempotencyKey},
        ${value.requestHash},${value.recordedAt},${new Date().toISOString()},${d.evidenceQueryId ? targetQuery!.collection.id : null},${relation?.observationId ?? null})
      RETURNING ${columns}`)
    return finishReview(tx, command, hash, decisionReceipt102(row!), previous?.id ?? null)
  })
}

export function commitPostgresQualification102(db: NodePgDatabase, input: unknown) {
  const envelope = parse102(qualificationCommit102, input)
  return savePostgresDecision102(db, envelope.command, envelope.planHash)
}
