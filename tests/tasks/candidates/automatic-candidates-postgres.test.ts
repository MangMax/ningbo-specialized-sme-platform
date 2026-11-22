import { receiptRedactor } from '../../../layers/sme-roster/server/utils/import-receipt-redaction'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { expect, it } from 'vitest'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { importBatch } from '../../../db/postgresql/import-tables'
import { record, recordEvent } from '../../../db/postgresql/ledger-tables'
import { recordCorrespondence, recordCorrespondenceAudit } from '../../../db/postgresql/qualification-tables'
import { createPostgresJobRunner } from '../../../layers/core/server/utils/job-runner-postgres'
import { getPostgresJob } from '../../../layers/core/server/utils/job-store-postgres'
import { discoverPostgresEventArchives } from '../../../layers/sme-roster/server/utils/record-correspondence-candidates-postgres'
import { commitPostgresCorrespondenceDecision } from '../../../layers/sme-roster/server/utils/record-correspondence-write-postgres'
import type { CorrespondenceRequest } from '../../../layers/sme-roster/server/utils/record-correspondence-model'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

it('removes only untouched worker suggestions and rediscovers them without storing new decisions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'candidate-discovery-pg-'))
  let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
  let pool: pg.Pool | undefined
  let runner: ReturnType<typeof createPostgresJobRunner> | undefined
  try {
    runtime = await postgresRuntimeFixture({ dir })
    runtime.psql(['-c', `ALTER TABLE business.platform_collection ALTER COLUMN public_id RESTART WITH 301;
      ALTER TABLE business.platform_business_observation ALTER COLUMN public_id RESTART WITH 701`])
    pool = new pg.Pool({ connectionString: runtime.url, options: '-c search_path=business,public' })
    const db = drizzle({ client: pool })
    const uscc = '91330211255994457P'
    const [owner] = await db.insert(enterprise).values({ name: '合成企业', nameNorm: '合成企业', usccNorm: uscc }).returning()
    const [ledger] = await db.insert(record).values({ enterpriseId: owner!.id, source: 'jxj', titleCode: 'specialized_sme', usccRaw: uscc }).returning()
    const [event] = await db.insert(recordEvent).values({ recordId: ledger!.id, eventType: 'award', year: 2022, batchSeq: 1 }).returning()
    const submit = (request: CorrespondenceRequest) => db.transaction(tx => commitPostgresCorrespondenceDecision(tx, request))
    const manual = (idempotencyKey: string, operations: CorrespondenceRequest['operations']): CorrespondenceRequest => ({
      idempotencyKey, sourceIdentity: 'review', actor: { type: 'user', id: 'reviewer' },
      basis: '已逐条核对', ruleId: 'manual', ruleVersion: '1', operations,
    })
    const previous = new Map<string, { edgeId: number; batchId: number; relationId: number }>()
    for (const [index, status] of ['untouched', 'confirmed', 'rejected', 'manual', 'revalidated'].entries()) {
      const query = await seedPostgresPlatformQuery(db, {
        interface: 'business_list', titleCode: 'specialized_sme', rdjb: '2', queryKey: uscc,
        queriedAt: `2026-01-01T00:00:0${index}Z`, status: 'success', rawResponse: '合成原文',
        relations: [{ sequenceNo: 1, relationKey: 'row-' + index, enterpriseId: owner!.id, usccRaw: uscc,
          year: 2022, batch: '2022-1', declareKind: 'apply', verificationStatus: 'confirmed', rawFields: { original: index } }],
      })
      const relationId = query.relationIds[0]!
      expect(query.queryId).toBe(301 + index)
      expect(relationId).toBe(701 + index)
      const operations = [{ action: 'create', status: 'candidate', edge: {
        type: 'event_process', eventId: event!.id, relationId, role: 'supports_award',
      } }] satisfies CorrespondenceRequest['operations']
      const receipt = await submit(status === 'manual' ? manual('manual-create', operations) : {
        idempotencyKey: `candidate-job:synthetic-task:${event!.id}:${relationId}`,
        sourceIdentity: 'candidate-job/synthetic-task', actor: { type: 'agent', id: 'candidate-discovery-job' },
        basis: '归档原行精确身份与称号匹配；仅生成待核候选，人工核对后决定。',
        ruleId: 'archived-row-exact-identity-title', ruleVersion: 'event-archive-212-v1', operations,
      })
      const edgeId = receipt.correspondenceIds[0]!
      previous.set(status, { edgeId, batchId: receipt.batchId, relationId })
      if (status === 'confirmed' || status === 'rejected') {
        await submit(manual(status, [{ action: 'decide', correspondenceId: edgeId, expectedRevision: 1, status }]))
      }
      if (status === 'revalidated') {
        await db.update(recordEvent).set({ revision: 2 }).where(eq(recordEvent.id, event!.id))
        await submit(manual(status, [{ action: 'revalidate', correspondenceId: edgeId, expectedRevision: 1 }]))
      }
    }

    const readHistory = () => db.select().from(recordCorrespondenceAudit).orderBy(recordCorrespondenceAudit.id)
    const histories = await readHistory()
    const removed = previous.get('untouched')!
    const migration = 'upgrade/pg/2026-11-data-compaction/steps/04-remove-automatic-correspondence-candidates.sql'
    runtime.psql(['-f', migration])
    runtime.psql(['-f', migration])
    const remaining = [...previous.values()].filter(row => row.edgeId !== removed.edgeId)
    expect(await readHistory()).toEqual(histories.filter(row => row.correspondenceId !== removed.edgeId))
    expect((await db.select({ id: importBatch.id }).from(importBatch)
      .where(inArray(importBatch.id, [...previous.values()].map(row => row.batchId))).orderBy(importBatch.id)).map(row => row.id))
      .toEqual(remaining.map(row => row.batchId))
    expect(await db.select().from(recordCorrespondence).where(eq(recordCorrespondence.id, removed.edgeId))).toEqual([])
    const candidates = await db.transaction(tx => discoverPostgresEventArchives(tx, {
      eventId: event!.id, page: 1, pageSize: 25, queryPage: 1, queryPageSize: 1,
    }, receiptRedactor([])))
    expect(candidates?.rows).toContainEqual(expect.objectContaining({
      edge: expect.objectContaining({ relationId: removed.relationId }), recommendation: 'candidate', existingCorrespondenceId: null,
    }))

    runner = createPostgresJobRunner(db, dir)
    runner.start()
    const task = await runner.submit({ kind: 'event-archive-candidates', params: {
      eventIds: [event!.id], clientRequestId: 'review-suggestions', afterEventId: 0,
    } })
    await expect.poll(async () => (await getPostgresJob(db, task.id))?.row, { timeout: 8000 }).toMatchObject({
      state: 'done', progress: { done: 1, total: 1 },
      result: { counts: { succeeded: 1, needsReview: 1, failed: 0, created: 0, existing: 4 } },
    })
    expect(await readHistory()).toEqual(histories.filter(row => row.correspondenceId !== removed.edgeId))
    expect((await db.select({ id: recordCorrespondence.id }).from(recordCorrespondence).orderBy(recordCorrespondence.id)).map(row => row.id))
      .toEqual(remaining.map(row => row.edgeId))
  } finally {
    try { await runner?.stop() }
    finally {
      try { await pool?.end() }
      finally {
        runtime?.close()
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }
}, 30_000)
