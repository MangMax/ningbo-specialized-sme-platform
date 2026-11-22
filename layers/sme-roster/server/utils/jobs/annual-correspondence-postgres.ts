import { job } from '../../../../../db/postgresql/job-tables'
import { and, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { newJobId } from '../../../../core/lib/job'
import type { LogContext } from '../../../../core/lib/logging'
import type { PostgresJobContext, PostgresJobTransaction } from '../../../../core/server/utils/job-runner-postgres'
import {
  createPostgresJob, getPostgresJob, lockPostgresJobAdmission, reopenPostgresJob, setPostgresJobResult,
} from '../../../../core/server/utils/job-store-postgres'
import { requirePostgresJobsWritable, startPostgresJobs } from '../../../../core/server/utils/postgres-jobs'
import {
  ANNUAL_CORRESPONDENCE_KIND as KIND, ANNUAL_CORRESPONDENCE_VERSION as VERSION,
  type AnnualTaskDto, type AnnualTaskResult,
} from '../../../lib/roster/annual-correspondence'
import { annualFail, annualHash, planAnnualStep, projectAnnualFinalQualification, type AnnualWriteScope } from '../annual-correspondence-contract'
import { readPostgresCandidateSourceBytes } from '../candidate-source-bytes-postgres'
import { readPostgresAnnualDecisionRefs, readPostgresAnnualWriteScope } from '../event-annual-process-postgres'
import { commitPostgresCorrespondenceDecision, runPostgresCorrespondenceTransaction } from '../record-correspondence-write-postgres'
import { annualErrorCode, annualTaskInput, annualTaskReceipt, initialAnnualResult, type AnnualTaskParams } from './annual-correspondence-job-contract'

type Tx = PostgresJobTransaction
const snapshot = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const

async function generations(db: NodePgDatabase, eventIds: readonly number[]) {
  const result: AnnualTaskParams['sourceGenerations'] = []
  for (const eventId of eventIds) {
    const scope = await readPostgresAnnualWriteScope(db, eventId)
    result.push({ eventId, generation: scope?.generation ?? 'event_unavailable' })
  }
  return result
}

export async function stagePostgresAnnualCorrespondence(tx: Tx, raw: unknown, onCreated?: (id: string) => void) {
  const parsed = annualTaskInput.safeParse(raw)
  if (!parsed.success) annualFail('invalid_annual_task_request', 400)
  const { clientRequestId } = parsed.data
  const eventIds = [...new Set(parsed.data.eventIds)].sort((a, b) => a - b)
  await lockPostgresJobAdmission(tx, KIND)
  const [request] = await tx.select({ id: job.id }).from(job).where(and(eq(job.kind, KIND),
    sql`(${job.params}::jsonb->'clientRequestIds') ? ${clientRequestId}`)).limit(1)
  if (request) {
    const { row } = (await getPostgresJob(tx, request.id))!
    if (JSON.stringify(row.params.eventIds) !== JSON.stringify(eventIds)) annualFail('idempotency_conflict')
    return annualTaskReceipt(row)
  }
  const sourceGenerations = await generations(tx, eventIds)
  const serverIdentity = annualHash({ sourceGenerations, ruleVersion: VERSION })
  const [sameScope] = await tx.select({ id: job.id }).from(job).where(and(eq(job.kind, KIND),
    eq(sql<string>`${job.params}::json->>'serverIdentity'`, serverIdentity))).limit(1).for('no key update')
  if (sameScope) {
    const { row } = (await getPostgresJob(tx, sameScope.id))!
    const params = row.params as AnnualTaskParams
    await tx.update(job).set({ params: JSON.stringify({ ...params, clientRequestIds: [...params.clientRequestIds, clientRequestId] }) })
      .where(eq(job.id, row.id))
    return annualTaskReceipt(row)
  }
  const params: AnnualTaskParams = { eventIds, clientRequestIds: [clientRequestId], serverIdentity, sourceGenerations, ruleVersion: VERSION }
  const { row, claimToken } = await createPostgresJob(tx, { id: newJobId(), kind: KIND, params, progress: { done: 0, total: eventIds.length } })
  await setPostgresJobResult(tx, row.id, { state: 'queued', claimToken }, initialAnnualResult(sourceGenerations))
  onCreated?.(row.id)
  return annualTaskReceipt(row)
}

export function submitPostgresAnnualCorrespondence(db: NodePgDatabase, raw: unknown, filesDir: string, logContext?: LogContext) {
  requirePostgresJobsWritable()
  const { runner } = startPostgresJobs(filesDir)!
  return runner.trackSubmission(remember => runPostgresCorrespondenceTransaction(db, tx => {
    remember([])
    return stagePostgresAnnualCorrespondence(tx, raw, id => remember([{ id, kind: KIND }]))
  }, [20, 50, 100, 200, 350, 600]), logContext)
}

async function qualify(db: NodePgDatabase, scope: AnnualWriteScope, generation: string) {
  const step = scope.steps.find(item => item.stepId === scope.finalCandidateStepId)
  const refs = step && generation === scope.generation ? await readPostgresAnnualDecisionRefs(db, scope, step) : []
  return projectAnnualFinalQualification(scope, refs, generation)
}

export async function getPostgresAnnualTask(db: NodePgDatabase, id: string, writable: boolean): Promise<AnnualTaskDto | null> {
  return db.transaction(async tx => {
    const job = await getPostgresJob(tx, id)
    if (!job || job.row.kind !== KIND) return null
    const { row } = job
    const result = row.result as AnnualTaskResult | null
    let generationCurrent = true
    for (const event of result?.events ?? []) {
      const scope = await readPostgresAnnualWriteScope(tx, event.eventId)
      if ((scope?.generation ?? 'event_unavailable') !== event.generation) generationCurrent = false
      event.finalQualification = scope ? await qualify(tx, scope, event.generation)
        : { stepId: null, status: 'blocked', decisionRefs: [], reasons: ['event_unavailable'] }
    }
    return { jobId: id, kind: KIND, status: row.state, progress: row.progress, result,
      errorCode: row.state !== 'cancelled' && row.error ? row.error === 'annual_event_failed' ? 'annual_event_failed' : 'annual_task_interrupted' : null,
      capabilities: { cancel: writable && ['queued', 'running'].includes(row.state),
        retry: writable && ['failed', 'cancelled'].includes(row.state) && !!result && result.attempt < 10 && result.ruleVersion === VERSION && generationCurrent } }
  }, snapshot)
}

export async function retryPostgresAnnualCorrespondence(db: NodePgDatabase, id: string, filesDir: string) {
  const receipt = await runPostgresCorrespondenceTransaction(db, async tx => {
    const job = await getPostgresJob(tx, id)
    const result = job?.row.result as AnnualTaskResult | null | undefined
    if (!job || job.row.kind !== KIND || !result || result.attempt >= 10 || result.ruleVersion !== VERSION) annualFail('retry_unavailable')
    const { row, claimToken } = job
    if (row.state !== 'failed' && row.state !== 'cancelled') annualFail('retry_unavailable')
    const current = await generations(tx, result.events.map(event => event.eventId))
    if (current.some((value, i) => value.generation !== result.events[i]!.generation)) annualFail('source_generation_changed')
    const reopened = await reopenPostgresJob(tx, id, KIND, { state: row.state, claimToken }, row.params, null)
    if (!reopened) annualFail('retry_unavailable')
    return annualTaskReceipt(reopened.row)
  })
  startPostgresJobs(filesDir)
  return receipt
}

async function currentScope(db: NodePgDatabase, eventId: number, generation: string) {
  const scope = await readPostgresAnnualWriteScope(db, eventId)
  if (!scope) annualFail('event_unavailable', 422)
  if (scope.generation !== generation) annualFail('source_generation_changed')
  return scope
}

async function reconcile(tx: Tx, eventId: number, generation: string, stepId: string) {
  const scope = await currentScope(tx, eventId, generation)
  const step = scope.steps.find(item => item.stepId === stepId)
  if (!step) annualFail('source_generation_changed')
  const refs = await readPostgresAnnualDecisionRefs(tx, scope, step)
  const plan = planAnnualStep(scope, step, refs)
  if ('outcome' in plan) return plan.outcome
  const bytes = await readPostgresCandidateSourceBytes(tx, plan.relationId)
  if (bytes === undefined || bytes > 4 * 1024 * 1024) annualFail('source_materialization_limit', 422)
  const committed = await commitPostgresCorrespondenceDecision(tx, plan.request)
  const resultingRefs = await readPostgresAnnualDecisionRefs(tx, scope, step)
  return plan.created(resultingRefs.filter(ref => committed.correspondenceIds.includes(ref.id)))
}

export async function runPostgresAnnualCorrespondence(ctx: PostgresJobContext, raw: Record<string, unknown>) {
  const job = await getPostgresJob(ctx.db, ctx.jobId)
  if (!job || job.row.state !== 'running') return { result: null, cancelled: true }
  const result = job.row.result as AnnualTaskResult | null
  if (!result || raw.ruleVersion !== VERSION || result.ruleVersion !== VERSION) annualFail('rule_version_changed')
  result.attempt++
  const persist = async () => {
    await ctx.checkpoint(result)
    await ctx.progress(result.events.filter(event => ['done', 'failed'].includes(event.status)).length, result.events.length)
  }
  await persist()
  for (const event of result.events) {
    if (event.status === 'done') continue
    if (await ctx.cancelled()) return { result, cancelled: true }
    event.status = 'running'
    delete event.errorCode
    await persist()
    try {
      const scope = await ctx.db.transaction(tx => currentScope(tx, event.eventId, event.generation), snapshot)
      for (const step of scope.steps) {
        if (event.outcomes.some(outcome => outcome.stepId === step.stepId)) continue
        if (await ctx.cancelled()) return { result, cancelled: true }
        const outcome = await runPostgresCorrespondenceTransaction(ctx.db, async tx => {
          const outcome = await reconcile(tx, event.eventId, event.generation, step.stepId)
          const checkpoint = { ...result, events: result.events.map(item =>
            item === event ? { ...item, outcomes: [...item.outcomes, outcome] } : item) }
          await ctx.checkpoint(checkpoint, tx)
          return outcome
        })
        event.outcomes.push(outcome)
      }
      event.finalQualification = await ctx.db.transaction(async tx =>
        qualify(tx, await currentScope(tx, event.eventId, event.generation), event.generation), snapshot)
      event.status = 'done'
    } catch (cause) {
      event.status = 'failed'
      event.errorCode = annualErrorCode(cause)
      event.finalQualification = { stepId: null, status: 'blocked', decisionRefs: [], reasons: [event.errorCode] }
    }
    await persist()
  }
  return { result, progress: { done: result.events.length, total: result.events.length },
    ...(result.events.some(event => event.status === 'failed') ? { error: 'annual_event_failed' } : {}) }
}
