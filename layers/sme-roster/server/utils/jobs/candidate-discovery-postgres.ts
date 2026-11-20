import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { LogContext } from '../../../../core/lib/logging'
import { type PostgresJobContext, stagePostgresJob } from '../../../../core/server/utils/job-runner-postgres'
import { getPostgresJob, reopenPostgresJob } from '../../../../core/server/utils/job-store-postgres'
import { startPostgresJobs } from '../../../../core/server/utils/postgres-jobs'
import { readPostgresCandidateSourceBytes } from '../candidate-target-sources'
import { EVENT_ARCHIVE_RULE_VERSION, normalizedUscc } from '../event-archive-discovery'
import { importPostgresReceiptRedactor } from '../import-receipt-redaction'
import { discoverPostgresEventArchives } from '../record-correspondence-candidates-postgres'
import { commitPostgresCorrespondenceDecision, runPostgresCorrespondenceTransaction } from '../record-correspondence-write-postgres'
import { stagePostgresAnnualCorrespondence } from './annual-correspondence-postgres'
import {
  CANDIDATE_JOB_KIND, candidateDiscoverySpec, candidateJobParams, candidateResult, candidateRequest,
  candidateSourceLimitError, candidateCompletion, updateCounts, type CandidateJobResult, type CandidateJobParams,
} from './candidate-discovery'

const ids = (values: readonly number[]) => sql`${sql.param(values)}::bigint[]`
const readOnly = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const
const fail = (message: string, statusCode = 400): never => { throw Object.assign(new Error(message), { statusCode }) }

async function initializePostgresCandidates(db: NodePgDatabase, params: CandidateJobParams) {
  const canonical = normalizedUscc(sql`coalesce(r.uscc_raw,e.uscc_norm)`)
  const raw = normalizedUscc(sql`original.uscc_raw`)
  const affected = params.queryId === undefined ? sql.empty() : sql`AND EXISTS (
    SELECT 1 FROM platform_legacy_query_alias q JOIN platform_collection c ON c.id=q.collection_id
    WHERE q.old_id=${params.queryId}
      AND (coalesce(c.title_code,CASE c.rdjb WHEN '1' THEN 'innovative_sme' WHEN '2' THEN 'specialized_sme' WHEN '3' THEN 'little_giant' END)=r.title_code
        OR c.interface='recognized_list' AND c.title_code IS NULL
          AND (CASE r.title_code WHEN 'innovative_sme' THEN '1' WHEN 'specialized_sme' THEN '2' WHEN 'little_giant' THEN '3' END)=ANY(string_to_array(c.rdjb,',')))
      AND (c.query_key=${canonical} OR c.query_key='name:'||e.name_norm
        OR EXISTS(SELECT 1 FROM enterprise_alias a WHERE a.enterprise_id=e.id AND a.verification_status='confirmed' AND c.query_key='name:'||a.name_norm)
        OR EXISTS (
          SELECT 1 FROM platform_business_observation o
          JOIN platform_observation_assignment original ON original.observation_id=o.id AND original.revision=1
          JOIN LATERAL (SELECT enterprise_id,verification_status FROM platform_observation_assignment
            WHERE observation_id=o.id ORDER BY revision DESC LIMIT 1) a ON true
          WHERE o.collection_id=c.id AND (a.enterprise_id IS NULL OR a.enterprise_id=e.id)
            AND ((${raw}<>'' AND ${raw}=${canonical}) OR (a.enterprise_id=e.id AND a.verification_status='confirmed' AND ${raw}=''))
        ))
  )`
  const { rows: [result] } = await db.execute<{ high: number; events: { eventId: number; enterpriseId: number }[] }>(sql`
    WITH upper_bound AS (SELECT coalesce(${params.throughEventId ?? null},(SELECT max(id) FROM record_event),0) AS id),
    entries AS (SELECT v.id AS "eventId",r.enterprise_id AS "enterpriseId"
      FROM record_event v JOIN record r ON r.id=v.record_id JOIN enterprise e ON e.id=r.enterprise_id
      WHERE r.source='jxj' AND v.event_type IN ('award','review')
        AND v.id>${params.afterEventId} AND v.id<=(SELECT id FROM upper_bound)
        ${params.eventIds ? sql`AND v.id=ANY(${ids(params.eventIds)})` : sql.empty()}
        ${params.titleCode ? sql`AND r.title_code=${params.titleCode}` : sql.empty()} ${affected}
      ORDER BY v.id LIMIT 201)
    SELECT id::float8 AS high,(SELECT coalesce(json_agg(entries ORDER BY "eventId"),'[]'::json) FROM entries) AS events FROM upper_bound`)
  return candidateResult(result!.events, result!.high, params.eventIds)
}

export async function runPostgresCandidateDiscovery(ctx: PostgresJobContext, raw: Record<string, unknown>) {
  const current = await getPostgresJob(ctx.db, ctx.jobId)
  if (!current || current.row.state !== 'running') return { result: null, cancelled: true }
  const params = candidateJobParams.parse(raw)
  const result = (current.row.result as CandidateJobResult | null) ?? await initializePostgresCandidates(ctx.db, params)
  if (result.ruleVersion !== EVENT_ARCHIVE_RULE_VERSION) return fail('任务规则已变化，请新建任务', 409)
  const redact = await importPostgresReceiptRedactor(ctx.db)
  result.attempt++
  const persist = async () => {
    updateCounts(result)
    await ctx.checkpoint(result)
    await ctx.progress(result.counts.succeeded + result.counts.failed, result.items.length)
  }
  await persist()
  for (const [position, item] of result.items.entries()) {
    if (item.status === 'done') continue
    item.status = 'running'
    delete item.errorCode
    await persist()
    try {
      while (item.status === 'running') {
        if (await ctx.cancelled()) return { result, cancelled: true }
        const page = await ctx.db.transaction(tx => discoverPostgresEventArchives(tx, {
          eventId: item.eventId, page: item.page, pageSize: 25, queryPage: 1, queryPageSize: 1,
        }, redact), readOnly)
        if (!page) throw new Error('event_unavailable')
        if (!page.rows.length || page.interfaces.some(source =>
          !source.queried || source.states.some(state => ['failed', 'partial', 'not_queried'].includes(state.status)))) item.needsReview = true
        while (item.rowIndex < page.rows.length) {
          if (await ctx.cancelled()) return { result, cancelled: true }
          const candidate = page.rows[item.rowIndex]!
          const request = candidateRequest(ctx.jobId, item.eventId, candidate)
          const edge = request.operations[0].edge
          const committed = await runPostgresCorrespondenceTransaction(ctx.db, async tx => {
            const { rows: [prior] } = await tx.execute<{ status: string }>(sql`
              SELECT p.status FROM record_correspondence p JOIN platform_legacy_relation_alias a ON a.observation_id=p.observation_id
              WHERE p.event_id=${item.eventId} AND a.old_id=${edge.relationId} AND p.type=${edge.type} ORDER BY p.id LIMIT 1`)
            const next = { ...item, rowIndex: item.rowIndex + 1 }
            if (prior || candidate.recommendation === 'existing_decision') {
              next.existing++
              if (prior?.status === 'candidate') next.needsReview = true
            } else {
              await checkPostgresCandidateSourceBudget(tx, edge.relationId)
              await commitPostgresCorrespondenceDecision(tx, request)
              next.created++
              next.needsReview = true
            }
            const checkpoint = { ...result, items: result.items.map((row, index) => index === position ? next : row) }
            updateCounts(checkpoint)
            await ctx.checkpoint(checkpoint, tx)
            return next
          })
          Object.assign(item, committed)
        }
        if (item.page * 25 >= page.total) item.status = 'done'
        else {
          item.page++
          item.rowIndex = 0
        }
        await persist()
      }
    } catch (cause) {
      item.status = 'failed'
      const message = (cause as Error)?.message
      item.errorCode = ['source_materialization_limit', 'event_unavailable'].includes(message) ? message : 'candidate_persistence_failed'
      await persist()
    }
  }
  if (params.queryId && result.items.length && !await ctx.cancelled()) {
    const eventIds = result.items.map(item => item.eventId)
    const archiveGeneration = params.archiveGeneration ?? ctx.jobId
    const identity = createHash('sha256').update(JSON.stringify({
      archiveGeneration, candidateJobId: ctx.jobId, throughEventId: result.throughEventId, eventIds,
    })).digest('hex')
    const continuation = await runPostgresCorrespondenceTransaction(ctx.db, async tx => {
      await stagePostgresAnnualCorrespondence(tx, { clientRequestId: 'archive-annual:' + identity, eventIds })
      if (!result.nextAfterEventId || result.counts.failed) {
        await ctx.checkpoint(result, tx)
        return undefined
      }
      const paramsForNext = candidateJobParams.parse({ queryId: params.queryId, afterEventId: result.nextAfterEventId,
        throughEventId: result.throughEventId, archiveGeneration,
        clientRequestId: ['archive', params.queryId, archiveGeneration, result.nextAfterEventId, result.throughEventId].join(':') })
      const { row } = await stagePostgresJob(tx, { kind: CANDIDATE_JOB_KIND, params: paramsForNext })
      await ctx.checkpoint({ ...result, continuationJobId: row.id }, tx)
      return row.id
    })
    if (continuation) result.continuationJobId = continuation
  }
  return candidateCompletion(result, await ctx.cancelled())
}

async function checkPostgresCandidateSourceBudget(db: NodePgDatabase, relationId: number) {
  const bytes = await readPostgresCandidateSourceBytes(db, relationId)
  if (bytes === undefined || bytes > 4 * 1024 * 1024) throw candidateSourceLimitError()
}

export async function submitPostgresCandidateDiscovery(input: unknown, filesDir: string, logContext?: LogContext) {
  const parsed = candidateDiscoverySpec.parse(input as Record<string, unknown>)
  if (!parsed.ok) return fail(parsed.message)
  const runtime = startPostgresJobs(filesDir)
  if (!runtime) return fail('PostgreSQL 任务中心未启用', 503)
  const row = await runtime.runner.submit({ kind: CANDIDATE_JOB_KIND, params: parsed.params, logContext })
  return { jobId: row.id, kind: row.kind, state: row.state }
}

export async function retryPostgresCandidateDiscovery(db: NodePgDatabase, id: string) {
  const job = await getPostgresJob(db, id)
  const result = job?.row.result as CandidateJobResult | null | undefined
  if (!job || job.row.kind !== CANDIDATE_JOB_KIND || (result?.attempt ?? 0) >= 10
    || (result?.ruleVersion && result.ruleVersion !== EVENT_ARCHIVE_RULE_VERSION)) return fail('此任务当前不支持安全重试', 409)
  const { row, claimToken } = job
  if (row.state !== 'failed' && row.state !== 'cancelled') return fail('此任务当前不支持安全重试', 409)
  if (!await reopenPostgresJob(db, id, row.kind, { state: row.state, claimToken }, row.params)) return fail('任务状态已变化', 409)
  return { jobId: id }
}
