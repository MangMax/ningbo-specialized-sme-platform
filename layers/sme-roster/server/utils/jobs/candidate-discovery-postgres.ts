import { createHash } from 'node:crypto'
import { and, desc, eq, exists, gt, inArray, isNull, lte, max, ne, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { enterprise, enterpriseAlias } from '../../../../../db/postgresql/enterprise-tables'
import { record, recordEvent } from '../../../../../db/postgresql/ledger-tables'
import {
  platformBusinessObservation as observation, platformCollection as collection, platformLegacyQueryAlias as queryAlias,
  platformObservationAssignment as assignment,
} from '../../../../../db/postgresql/platform-tables'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { LogContext } from '../../../../core/lib/logging'
import { ANNUAL_CORRESPONDENCE_KIND } from '../../../lib/roster/annual-correspondence'
import { type PostgresJobContext, stagePostgresJob } from '../../../../core/server/utils/job-runner-postgres'
import { getPostgresJob, reopenPostgresJob } from '../../../../core/server/utils/job-store-postgres'
import { startPostgresJobs } from '../../../../core/server/utils/postgres-jobs'
import { EVENT_ARCHIVE_RULE_VERSION, normalizedUscc } from '../event-archive-discovery-model'
import { importPostgresReceiptRedactor } from '../import-receipt-redaction'
import { discoverPostgresEventArchives } from '../record-correspondence-candidates-postgres'
import { runPostgresCorrespondenceTransaction } from '../record-correspondence-write-postgres'
import { stagePostgresAnnualCorrespondence } from './annual-correspondence-postgres'
import { postgresCandidateDiscoverySpec } from './candidate-discovery-postgres-spec'
import { CANDIDATE_JOB_KIND, candidateJobParams, candidateResult, candidateCompletion, updateCounts, type CandidateJobResult, type CandidateJobParams } from './candidate-discovery-contract'

const readOnly = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const
const fail = (message: string, statusCode = 400): never => { throw Object.assign(new Error(message), { statusCode }) }

function affectedByQuery(db: NodePgDatabase, queryId: number) {
  const original = alias(assignment, 'original')
  const canonical = normalizedUscc(sql`coalesce(${record.usccRaw}, ${enterprise.usccNorm})`)
  const raw = normalizedUscc(original.usccRaw)
  const latest = db.select({ enterpriseId: assignment.enterpriseId, status: assignment.verificationStatus })
    .from(assignment).where(eq(assignment.observationId, observation.id)).orderBy(desc(assignment.revision)).limit(1).as('latest')
  const matchingObservation = db.select({ id: observation.id }).from(observation)
    .innerJoin(original, and(eq(original.observationId, observation.id), eq(original.revision, 1)))
    .crossJoinLateral(latest)
    .where(and(eq(observation.collectionId, collection.id), or(isNull(latest.enterpriseId), eq(latest.enterpriseId, enterprise.id)),
      or(and(ne(raw, ''), eq(raw, canonical)), and(eq(latest.enterpriseId, enterprise.id), eq(latest.status, 'confirmed'), eq(raw, '')))))
  const namedAlias = db.select({ id: enterpriseAlias.id }).from(enterpriseAlias).where(and(
    eq(enterpriseAlias.enterpriseId, enterprise.id), eq(enterpriseAlias.verificationStatus, 'confirmed'),
    eq(collection.queryKey, sql`'name:' || ${enterpriseAlias.nameNorm}`)))
  const scopedTitle = sql`coalesce(${collection.titleCode}, case ${collection.rdjb}
    when '1' then 'innovative_sme' when '2' then 'specialized_sme' when '3' then 'little_giant' end)`
  const requestedLevel = sql`case ${record.titleCode} when 'innovative_sme' then '1'
    when 'specialized_sme' then '2' when 'little_giant' then '3' end`
  return exists(db.select({ id: collection.id }).from(queryAlias)
    .innerJoin(collection, eq(collection.id, queryAlias.collectionId)).where(and(eq(queryAlias.oldId, queryId),
      or(eq(scopedTitle, record.titleCode), and(eq(collection.interface, 'recognized_list'), isNull(collection.titleCode),
        sql`${requestedLevel} = any(string_to_array(${collection.rdjb}, ','))`)),
      or(eq(collection.queryKey, canonical), eq(collection.queryKey, sql`'name:' || ${enterprise.nameNorm}`),
        exists(namedAlias), exists(matchingObservation)))))
}

async function initializePostgresCandidates(db: NodePgDatabase, params: CandidateJobParams) {
  return db.transaction(async tx => {
    const high = params.throughEventId ?? (await tx.select({ id: max(recordEvent.id) }).from(recordEvent))[0]?.id ?? 0
    const events = await tx.select({ eventId: recordEvent.id, enterpriseId: record.enterpriseId }).from(recordEvent)
      .innerJoin(record, eq(record.id, recordEvent.recordId)).innerJoin(enterprise, eq(enterprise.id, record.enterpriseId))
      .where(and(eq(record.source, 'jxj'), inArray(recordEvent.eventType, ['award', 'review']),
        gt(recordEvent.id, params.afterEventId), lte(recordEvent.id, high),
        params.eventIds && inArray(recordEvent.id, params.eventIds),
        params.titleCode && eq(record.titleCode, params.titleCode),
        params.queryId === undefined ? undefined : affectedByQuery(tx, params.queryId)))
      .orderBy(recordEvent.id).limit(201)
    return candidateResult(events, high, params.eventIds)
  }, readOnly)
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
  for (const item of result.items) {
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
          if (candidate.recommendation === 'existing_decision') item.existing++
          if (candidate.recommendation !== 'existing_decision' || candidate.existingStatus === 'candidate') item.needsReview = true
          item.rowIndex++
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
    const continuation = await ctx.trackSubmissions(remember => runPostgresCorrespondenceTransaction(ctx.db, async tx => {
      remember([])
      const queued: { id: string; kind: string }[] = []
      await stagePostgresAnnualCorrespondence(tx, { clientRequestId: 'archive-annual:' + identity, eventIds }, id => {
        queued.push({ id, kind: ANNUAL_CORRESPONDENCE_KIND })
      })
      if (!result.nextAfterEventId || result.counts.failed) {
        await ctx.checkpoint(result, tx)
        remember(queued)
        return undefined
      }
      const paramsForNext = candidateJobParams.parse({ queryId: params.queryId, afterEventId: result.nextAfterEventId,
        throughEventId: result.throughEventId, archiveGeneration,
        clientRequestId: ['archive', params.queryId, archiveGeneration, result.nextAfterEventId, result.throughEventId].join(':') })
      const { row, inserted } = await stagePostgresJob(tx, { kind: CANDIDATE_JOB_KIND, params: paramsForNext })
      await ctx.checkpoint({ ...result, continuationJobId: row.id }, tx)
      if (inserted) queued.push(row)
      remember(queued)
      return row.id
    }))
    if (continuation) result.continuationJobId = continuation
  }
  return candidateCompletion(result, await ctx.cancelled())
}

export async function submitPostgresCandidateDiscovery(input: unknown, filesDir: string, logContext?: LogContext) {
  const parsed = postgresCandidateDiscoverySpec.parse(input as Record<string, unknown>)
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
