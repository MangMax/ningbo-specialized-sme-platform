import { postgresCandidateDiscoverySpec } from './candidate-discovery-postgres-spec'
import { type CandidateJobParams, type CandidateJobResult, candidateResult, candidateSourceLimitError, candidateJobParams, updateCounts, candidateRequest, candidateCompletion, CANDIDATE_JOB_KIND, candidateJobInput } from './candidate-discovery-contract'
import { whenImportWriterIdle } from '../import-write-barrier'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import type { LogContext } from '../../../../core/lib/logging'
import { createHash } from 'node:crypto'
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'
import * as schema from '../../../../../db/schema'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { correspondenceTable, externalRelationColumn } from '../record-correspondence-store'
import { candidateTargetSourceBytes, targetCandidateTables } from '../candidate-target-sources'
import { discoverEventArchives } from '../event-archive-discovery'
import { EVENT_ARCHIVE_RULE_VERSION, normalizedUscc } from '../event-archive-discovery-model'
import { commitRecordCorrespondences, preflightRecordCorrespondences } from '../record-correspondence'
import { createJob, getJob, setJobResult } from '../../../../core/server/utils/job-store'
import { newJobId } from '../../../../core/lib/job'
import { stageAnnualCorrespondence, activateAnnualCorrespondence } from './annual-correspondence'
import { ensureJobRunnerReady, enqueuePersistedJob, requeueFinishedJob, submitJob, type JobContext, type JobSpec } from '../../../../core/server/utils/job-runner'
import { getJobSpec, registerJob } from '../../../../core/server/utils/job-spec-registry'
type Db = BetterSQLite3Database<typeof schema>
function fail(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode })
}
/** A query targets only verified identity/name coverage, never every event. No raw columns. */
function affectedWhere(db: Db, queryId: number) {
  const { q, r: p } = targetCandidateTables(db)
  const r = schema.record, e = schema.enterprise
  return sql`exists (select 1 from ${q} where ${q.id} = ${queryId}
    and (coalesce(${q.titleCode}, case ${q.rdjb} when '1' then 'innovative_sme' when '2' then 'specialized_sme' when '3' then 'little_giant' end) = ${r.titleCode}
      or (${q.interface} = 'recognized_list' and ${q.titleCode} is null and instr(',' || ${q.rdjb} || ',', ',' || case ${r.titleCode} when 'innovative_sme' then '1' when 'specialized_sme' then '2' when 'little_giant' then '3' end || ',') > 0))
    and (${q.queryKey} = ${normalizedUscc(sql`coalesce(${r.usccRaw},${e.usccNorm})`)}
      or ${q.queryKey} = 'name:' || ${e.nameNorm}
      or exists (select 1 from enterprise_alias a where a.enterprise_id = ${e.id} and a.verification_status = 'confirmed' and ${q.queryKey} = 'name:' || a.name_norm)
      or exists (select 1 from ${p} where ${p.queryId} = ${q.id} and (${p.enterpriseId} is null or ${p.enterpriseId} = ${e.id}) and
        ((${normalizedUscc(p.usccRaw)} != '' and ${normalizedUscc(p.usccRaw)} = ${normalizedUscc(sql`coalesce(${r.usccRaw},${e.usccNorm})`)}) or (${p.enterpriseId} = ${e.id} and ${p.verificationStatus} = 'confirmed' and ${normalizedUscc(p.usccRaw)} = '')))))`
}
function initialize(db: Db, params: CandidateJobParams): CandidateJobResult {
  const v = schema.recordEvent,
    r = schema.record,
    e = schema.enterprise
  const high =
    params.throughEventId ??
    db
      .select({ n: sql<number>`coalesce(max(${v.id}),0)` })
      .from(v)
      .get()!.n
  const rows = db
    .select({ eventId: v.id, enterpriseId: r.enterpriseId })
    .from(v)
    .innerJoin(r, eq(v.recordId, r.id))
    .innerJoin(e, eq(r.enterpriseId, e.id))
    .where(
      and(
        eq(r.source, 'jxj'),
        inArray(v.eventType, ['award', 'review']),
        gt(v.id, params.afterEventId),
        sql`${v.id} <= ${high}`,
        params.eventIds ? inArray(v.id, params.eventIds) : undefined,
        params.titleCode ? eq(r.titleCode, params.titleCode) : undefined,
        params.queryId ? affectedWhere(db, params.queryId) : undefined,
      ),
    )
    .orderBy(asc(v.id))
    .limit(201)
    .all()
  return candidateResult(rows, high, params.eventIds)
}
// Bounds source hydration without imposing a domain import limit.
const MAX_SOURCE_BYTES = 4 * 1024 * 1024
function checkSourceBudget(db: Db, relationId: number) {
  const bytes = candidateTargetSourceBytes(db, relationId)
  if (bytes == null || bytes > MAX_SOURCE_BYTES)
    throw candidateSourceLimitError()
}
async function run(ctx: JobContext, raw: Record<string, unknown>) {
  // submitJob can begin executing before returning. Never discover in archive transactions.
  await yieldTurn(); await whenImportWriterIdle()
  const current = getJob(ctx.db, ctx.jobId)
  // Staging may have rolled back after the queue was notified.
  if (!current || current.state !== 'running')
    return { result: null, cancelled: true }
  const params = candidateJobParams.parse(raw)
  const previous = current.result as CandidateJobResult | null
  const result = previous ?? initialize(ctx.db, params)
  if (result.ruleVersion !== EVENT_ARCHIVE_RULE_VERSION)
    fail('任务规则已变化，请新建任务', 409)
  result.attempt++
  const persist = () => {
    updateCounts(result)
    setJobResult(ctx.db, ctx.jobId, result)
    ctx.progress(
      result.counts.succeeded + result.counts.failed,
      result.items.length,
    )
  }
  persist()
  for (const item of result.items) {
    if (item.status === 'done') continue
    item.status = 'running'
    delete item.errorCode
    persist()
    try {
      let complete = false
      while (!complete) {
        if (ctx.cancelled()) return { result, cancelled: true }
        const page = discoverEventArchives(ctx.db, {
          eventId: item.eventId,
          page: item.page,
          pageSize: 25,
          queryPage: 1,
          queryPageSize: 1,
        })
        if (!page) fail('event_unavailable', 422)
        if (
          !page.rows.length ||
          page.interfaces.some(
            (i) =>
              !i.queried ||
              i.states.some((s) =>
                ['failed', 'partial', 'not_queried'].includes(s.status),
              ),
          )
        )
          item.needsReview = true
        while (item.rowIndex < page.rows.length) {
          if (ctx.cancelled()) return { result, cancelled: true }
          const candidate = page.rows[item.rowIndex]!
          const request = candidateRequest(ctx.jobId, item.eventId, candidate)
          const edge = request.operations[0].edge
          const beforeRow = { ...item }
          try {
            ctx.db.transaction(
              () => {
                // All roles count as an existing decision. This check and domain commit
                // share the immediate lock, closing discovery -> manual-decision races.
                const correspondence = correspondenceTable(ctx.db)
                const prior = ctx.db
                  .select({ status: correspondence.status })
                  .from(correspondence)
                  .where(
                    and(
                      eq(correspondence.eventId, item.eventId),
                      eq(
                        externalRelationColumn(ctx.db),
                        edge.relationId,
                      ),
                      eq(correspondence.type, edge.type),
                    ),
                  )
                  .get()
                if (prior || candidate.recommendation === 'existing_decision') {
                  item.existing++
                  if (prior?.status === 'candidate') item.needsReview = true
                } else {
                  checkSourceBudget(ctx.db, edge.relationId)
                  const plan = preflightRecordCorrespondences(ctx.db, request)
                  commitRecordCorrespondences(ctx.db, request, plan.planHash)
                  item.created++
                  item.needsReview = true
                }
                item.rowIndex++
                persist()
              },
              { behavior: 'immediate' },
            )
          } catch (cause) {
            Object.assign(item, beforeRow)
            throw cause
          }
          await yieldTurn(); await whenImportWriterIdle()
        }
        complete = item.page * 25 >= page.total
        if (complete) item.status = 'done'
        else {
          item.page++
          item.rowIndex = 0
        }
        persist()
        await yieldTurn(); await whenImportWriterIdle()
      }
    } catch (cause) {
      item.status = 'failed'
      item.errorCode =
        cause instanceof Error &&
        ['source_materialization_limit', 'event_unavailable'].includes(
          cause.message,
        )
          ? cause.message
          : 'candidate_persistence_failed'
      persist()
      await yieldTurn(); await whenImportWriterIdle()
    }
  }
  // Only the already-resolved archive query slice is automatic. Explicit event
  // and bulk-title candidate requests retain their existing manual semantics.
  if (params.queryId && result.items.length && !ctx.cancelled()) {
    // Native import only stages candidates. Do not load Nuxt's @db-dependent
    // adapter in that process; annual reads belong to the application runner.
    const { readAnnualWriteScope } = await import('../annual-correspondence-read')
    await whenImportWriterIdle()
    if (ctx.cancelled()) return { result, cancelled: true }
    const eventIds = result.items.map(item => item.eventId)
    const identity = createHash('sha256').update(JSON.stringify({
      archiveGeneration: params.archiveGeneration ?? ctx.jobId,
      candidateJobId: ctx.jobId,
      throughEventId: result.throughEventId,
      eventIds,
    })).digest('hex')
    const annual = ctx.db.transaction(() => {
      const receipt = stageAnnualCorrespondence(ctx.db, readAnnualWriteScope, {
        clientRequestId: `archive-annual:${identity}`,
        eventIds,
      }, ctx.logContext)
      // The annual generation/request binding and completed candidate slice
      // checkpoint commit together. A failure leaves this task retryable.
      persist()
      return receipt
    }, { behavior: 'immediate' })
    // Never notify a runner from inside a transaction. Startup reconciliation
    // exposes a committed-but-unactivated job for the existing explicit retry.
    activateAnnualCorrespondence(ctx.db, readAnnualWriteScope, [annual.jobId], ctx.filesDir, ctx.logContext)
  }
  // Large affected scopes continue in bounded jobs. Bulk title scopes explicitly
  // expose nextAfterEventId so operators choose whether to start the next slice.
  if (
    params.queryId &&
    result.nextAfterEventId &&
    !result.counts.failed &&
    !ctx.cancelled()
  ) {
    const archiveGeneration = params.archiveGeneration ?? ctx.jobId
    const next = submitCandidateDiscovery(
      ctx.db,
      {
        queryId: params.queryId,
        afterEventId: result.nextAfterEventId,
        throughEventId: result.throughEventId,
        archiveGeneration,
        clientRequestId: `archive:${params.queryId}:${archiveGeneration}:${result.nextAfterEventId}:${result.throughEventId}`,
      },
      ctx.filesDir,
      ctx.logContext,
    )
    result.continuationJobId = next.jobId
    persist()
  }
  return candidateCompletion(result, ctx.cancelled())
}
export const candidateDiscoverySpec: JobSpec = { ...postgresCandidateDiscoverySpec, run }
export function submitCandidateDiscovery(
  db: Db,
  input: unknown,
  filesDir: string,
  logContext?: LogContext,
) {
  const parsed = candidateDiscoverySpec.parse(input as Record<string, unknown>)
  if (!parsed.ok) fail(parsed.message)
  if (!getJobSpec(CANDIDATE_JOB_KIND)) registerJob(candidateDiscoverySpec)
  ensureJobRunnerReady(db)
  const row = submitJob(db, {
    kind: CANDIDATE_JOB_KIND,
    params: parsed.params,
    filesDir,
    logContext,
  })
  return { jobId: row.id, kind: row.kind, state: row.state }
}
export function retryCandidateDiscovery(db: Db, id: string, filesDir: string, logContext?: LogContext) {
  const row = getJob(db, id)
  const result = row?.result as CandidateJobResult | null
  if (
    !row ||
    row.kind !== CANDIDATE_JOB_KIND ||
    !['failed', 'cancelled'].includes(row.state) ||
    (result?.attempt ?? 0) >= 10 ||
    (result?.ruleVersion && result.ruleVersion !== EVENT_ARCHIVE_RULE_VERSION)
  )
    fail('此任务当前不支持安全重试', 409)
  if (!getJobSpec(CANDIDATE_JOB_KIND)) registerJob(candidateDiscoverySpec)
  if (
    !requeueFinishedJob(db, {
      id,
      kind: row.kind,
      params: row.params,
      filesDir,
      logContext,
    })
  )
    fail('任务状态已变化', 409)
  return { jobId: id }
}
/** Called only after all archive rows were staged successfully. Queue work yields
 * before any discovery. The job row shares the archive commit transaction. */
export function enqueueArchivedCandidates(
  db: Db,
  queries: readonly {
    interface: string
    queryKey: string
    rdjb?: string
    queriedAt: string
  }[],
  filesDir = '',
  deferDispatch = false,
  logContext?: LogContext,
) {
  const ids: string[] = []
  for (const query of queries) {
    const { q, r } = targetCandidateTables(db)
    const row = db
      .select({ id: q.id })
      .from(q)
      .where(
        and(
          eq(
            q.interface,
            query.interface as (typeof schema.platformCollection.$inferSelect)['interface'],
          ),
          eq(q.queryKey, query.queryKey.trim()),
          eq(q.rdjb, query.rdjb?.trim() ?? ''),
          eq(q.queriedAt, query.queriedAt.trim()),
        ),
      )
      .get()
    if (row) {
      if (!deferDispatch) ensureJobRunnerReady(db)
      const lastRelationId = db
        .select({
          id: sql<number>`coalesce(max(${r.id}),0)`,
        })
        .from(r)
        .where(eq(sql<number>`${r.queryId}`, row.id))
        .get()!.id
      const clientRequestId = `archive:${row.id}:${lastRelationId}:${EVENT_ARCHIVE_RULE_VERSION}`
      const existing = db
        .select({ id: schema.job.id })
        .from(schema.job)
        .where(
          and(
            eq(schema.job.kind, CANDIDATE_JOB_KIND),
            sql`json_extract(${schema.job.params}, '$.clientRequestId') = ${clientRequestId}`,
          ),
        )
        .get()
      const id =
        existing?.id ??
        createJob(db, {
          id: newJobId(),
          kind: CANDIDATE_JOB_KIND,
          params: {
            ...candidateJobInput.parse({ queryId: row.id, clientRequestId }),
          },
          progress: { done: 0, total: 1 },
          logContext,
        }).id
      ids.push(id)
      if (!deferDispatch) activateCandidateDiscoveryTasks(db, [id], filesDir, logContext)
    }
  }
  return ids
}
/** Main process only. Native import stages rows atomically, then its caller
 * adopts them into the one shared task runner after the commit receipt arrives. */
export function activateCandidateDiscoveryTasks(
  db: Db,
  ids: readonly string[],
  filesDir: string,
  logContext?: LogContext,
) {
  if (!getJobSpec(CANDIDATE_JOB_KIND)) registerJob(candidateDiscoverySpec)
  for (const id of ids) enqueuePersistedJob(db, id, filesDir, logContext)
}
export { CANDIDATE_JOB_KIND, candidateJobInput, candidateJobParams, type CandidateJobParams, type CandidateJobItem, type CandidateJobResult, candidateResult, updateCounts, candidateSourceLimitError, candidateCompletion, candidateRequest } from './candidate-discovery-contract'
