import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { expect, it } from 'vitest'
import { readPostgresLegacyQualification } from '../../../layers/sme-roster/lib/roster/current-qualification-postgres'
import { readPostgresQueryAssessments } from '../../../layers/sme-roster/lib/roster/query-assessment-postgres'
import { decisionRequestHash102, type DecisionCommand102 } from '../../../layers/sme-roster/server/utils/decision-lifecycle/contract'
import { savePostgresDecision102 } from '../../../layers/sme-roster/server/utils/decision-lifecycle/postgres-writes'
import { evidenceReviewReceipt114 } from '../../../db/postgresql/evidence-review-tables'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

it('preserves decision validity and existing review receipts after retiring impact tracking', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'retired-evidence-pg-'))
  let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
  let pool: pg.Pool | undefined
  try {
    runtime = await postgresRuntimeFixture({ dir })
    pool = new pg.Pool({ connectionString: runtime.url, options: '-c search_path=business,public' })
    const db = drizzle({ client: pool })
    await pool.query(`
      ALTER TABLE difference_reason DROP COLUMN retired_evidence_validity, DROP COLUMN retired_evidence_reviewed;
      CREATE TABLE explanation_impact_113 (
        decision_id bigint, enterprise_id bigint, title_code text, direction text,
        latest_revision_id bigint, reviewed_revision_id bigint, classification text
      );
      CREATE TABLE evidence_scope_version_113 (scope_key text, pending_count bigint);
      INSERT INTO enterprise(id,name,name_norm) VALUES (11,'甲','甲'),(12,'乙','乙'),(13,'丙','丙'),(14,'丁','丁'),(15,'戊','戊');
      INSERT INTO difference_reason(id,enterprise_id,title_code,direction,status,recorded_at,created_at)
      SELECT id,id,'specialized_sme','missing_in_miit','confirmed_reason','2026-01-01','2026-01-01'
      FROM generate_series(11,15) id;
      UPDATE difference_reason SET reason_code = 'moved_out', measure_code = 'mark_moved_out',
        verification_status = 'confirmed' WHERE id IN (11,12);
      INSERT INTO explanation_impact_113 VALUES
        (11,11,'specialized_sme','missing_in_miit',2,2,'evidence_changed'),
        (12,12,'specialized_sme','missing_in_miit',2,2,'evidence_changed'),
        (13,13,'specialized_sme','missing_in_miit',3,NULL,'premise_invalid'),
        (14,14,'specialized_sme','missing_in_miit',3,2,'evidence_changed'),
        (15,14,'specialized_sme','missing_in_miit',3,2,'evidence_changed');
      INSERT INTO evidence_scope_version_113 VALUES ('[12,null,"missing_in_miit"]',1),('[11,null,"extra_in_miit"]',1);
    `)
    const scope = (enterpriseId: number) => ({
      enterpriseId, titleCode: 'specialized_sme', direction: 'missing_in_miit' as const,
    })
    const request = {
      ...scope(11), titleCode: 'specialized_sme', action: 'maintain', expectedCurrentId: 11,
      idempotencyKey: 'historical-review', actor: { type: 'agent', id: 'history-fixture' }, basis: '历史核实',
      ruleVersion: 'fixture-1', effectiveAt: '2026-01-01T00:00:00Z',
      reviewedEvidence: { latestRevisionId: 2, projectionReady: true },
    } satisfies DecisionCommand102
    const response = { versionId: 11, currentId: 11, action: 'maintain', reviewedRevisionId: 2 }
    await db.insert(evidenceReviewReceipt114).values({
      idempotencyKey: request.idempotencyKey, requestHash: decisionRequestHash102(request),
      kind: 'maintain', ...scope(11), decisionId: 11, reviewedRevisionId: 2,
      actor: JSON.stringify(request.actor), basis: request.basis, ruleVersion: request.ruleVersion,
      effectiveAt: request.effectiveAt, response: JSON.stringify(response), recordedAt: request.effectiveAt,
    })
    for (let run = 0; run < 2; run++) runtime.psql(['-f', 'upgrade/pg/2026-11-data-compaction/steps/14-retire-evidence-impact-tracker.sql'])
    await pool.query(`
      INSERT INTO evidence_review_receipt_114 (idempotency_key, request_hash, kind, actor, basis, response, recorded_at)
      VALUES ('historical-process', repeat('0', 64), 'process', '{}', 'queue drain', '{}', '2026-01-01')
    `)
    runtime.psql(['-f', 'upgrade/pg/2026-11-evidence-review-cutover/apply.sql'])
    await pool.query('DROP TABLE evidence_review_receipt_114')
    await expect(savePostgresDecision102(db, { ...request, idempotencyKey: 'historical-process' })).rejects.toMatchObject({
      statusCode: 409, code: 'idempotency_conflict',
    })
    const assessments = await readPostgresQueryAssessments(db, [11, 12, 13, 14, 15].map(scope))
    expect(assessments.map(item => [item.currentDecision.versionId, item.explanationValidity.status])).toEqual([
      [11, 'valid'], [12, 'evidence_changed'], [13, 'premise_invalid'], [14, 'evidence_changed'], [15, 'unknown'],
    ])
    const asOf = Date.parse('2026-01-02T00:00:00Z')
    const legacyQualification = (enterpriseId: number) =>
      db.transaction(tx => readPostgresLegacyQualification(tx, enterpriseId, asOf), { isolationLevel: 'repeatable read' })
    const valid = await legacyQualification(11)
    const stale = await legacyQualification(12)
    expect(valid.titles.find(title => title.titleCode === 'specialized_sme')).toMatchObject({
      group: 'excluded', region: { status: 'outside_ningbo', decisionIds: [11] },
    })
    expect(stale.titles.find(title => title.titleCode === 'specialized_sme')).toMatchObject({
      group: 'pending', region: { status: 'unresolved' },
    })
    expect(await savePostgresDecision102(db, request)).toEqual(response)
    await expect(savePostgresDecision102(db, { ...request, idempotencyKey: 'new-review' })).rejects.toMatchObject({
      statusCode: 422, code: 'invalid_request',
    })
    const { rows } = await pool.query("SELECT to_regclass('explanation_impact_113') AS impact, to_regclass('evidence_scope_version_113') AS scope")
    expect(rows).toEqual([{ impact: null, scope: null }])
  } finally {
    try { await pool?.end() }
    finally {
      runtime?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}, 30_000)
