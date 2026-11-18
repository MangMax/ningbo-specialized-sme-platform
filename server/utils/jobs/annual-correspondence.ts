import { setImmediate as yieldTurn } from 'node:timers/promises'
import type { LogContext } from '../../../layers/core/lib/logging'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import * as s from '../../../db/schema'
import { newJobId } from '../../../lib/job'
import { ANNUAL_CORRESPONDENCE_KIND as KIND, ANNUAL_CORRESPONDENCE_VERSION as VERSION, type AnnualTaskReceipt, type AnnualTaskResult } from '../../../lib/roster/annual-correspondence'
import { annualDbReadonly, annualFail, annualHash, qualifyAnnualFinal, readAnnualScopes, reconcileAnnualStep, type AnnualDb, type AnnualScopeReader } from '../annual-correspondence'
import { createJob, getJob, setJobResult } from '../job-store'
import { enqueuePersistedJob, ensureJobRunnerReady, getJobSpec, registerJob, requeueFinishedJob, type JobContext, type JobSpec } from '../job-runner'

export const annualTaskInput = z.strictObject({ clientRequestId: z.string().trim().min(1).max(120), eventIds: z.array(z.number().int().positive()).min(1).max(200) })
interface Params extends Record<string, unknown> {
  eventIds: number[]
  clientRequestIds: string[]
  serverIdentity: string
  sourceGenerations: { eventId: number; generation: string }[]
  ruleVersion: string
}
const emptyFinal = () => ({ stepId: null, status: 'none' as const, decisionRefs: [], reasons: ['task_not_processed'] })
function receipt(row: NonNullable<ReturnType<typeof getJob>>): AnnualTaskReceipt {
  return { jobId: row.id, kind: KIND, state: row.state, sourceGenerations: (row.params as Params).sourceGenerations }
}
/** Persists and deduplicates only. Safe inside the archive transaction; activation
 * belongs to the caller after commit, never before SQLite releases its lock. */
export function stageAnnualCorrespondence(db: AnnualDb, read: AnnualScopeReader, raw: unknown, logContext?: LogContext): AnnualTaskReceipt {
  const parsed = annualTaskInput.safeParse(raw)
  if (!parsed.success) annualFail('invalid_annual_task_request',400)
  const eventIds = [...new Set(parsed.data.eventIds)].sort((a,b) => a-b)
  return db.transaction(() => {
    const oldRequest = db.select().from(s.job).where(and(eq(s.job.kind,KIND), sql`exists (select 1 from json_each(${s.job.params},'$.clientRequestIds') where value = ${parsed.data.clientRequestId})`)).get()
    if (oldRequest) {
      if (JSON.stringify(oldRequest.params.eventIds) !== JSON.stringify(eventIds)) annualFail('idempotency_conflict')
      return receipt(oldRequest)
    }
    const scopes = readAnnualScopes(db, read, eventIds)
    const sourceGenerations = eventIds.map(eventId => ({ eventId, generation: scopes.get(eventId)?.generation ?? 'event_unavailable' }))
    const serverIdentity = annualHash({ sourceGenerations, ruleVersion: VERSION })
    const oldScope = db.select().from(s.job).where(and(eq(s.job.kind,KIND),sql`json_extract(${s.job.params},'$.serverIdentity') = ${serverIdentity}`)).get()
    if (oldScope) {
      const params = oldScope.params as Params
      db.update(s.job).set({ params: { ...params, clientRequestIds: [...params.clientRequestIds, parsed.data.clientRequestId] } }).where(eq(s.job.id,oldScope.id)).run()
      return receipt(oldScope)
    }
    const params: Params = { eventIds, clientRequestIds: [parsed.data.clientRequestId], serverIdentity, sourceGenerations, ruleVersion: VERSION }
    const result: AnnualTaskResult = { ruleVersion: VERSION, attempt: 0, events: sourceGenerations.map(source => ({ ...source, status: 'pending', outcomes: [], finalQualification: emptyFinal() })) }
    const row = createJob(db,{ id: newJobId(), kind: KIND, params, progress: { done: 0, total: eventIds.length }, logContext })
    setJobResult(db,row.id,result)
    return receipt(row)
  },{behavior:'immediate'})
}
export function annualCorrespondenceSpec(read: AnnualScopeReader): JobSpec {
  return {
    kind: KIND, status: 'ready', summary: '完整年度过程对应与最终资格核对',
    paramsHint: '请使用年度专属入口；显式eventIds 1..200，来源代次由服务器计算。',
    parse: () => ({ ok: false, message: '请使用年度对应任务入口' }),
    run: async (ctx: JobContext, raw) => {
      await yieldTurn()
      const row = getJob(ctx.db,ctx.jobId)
      if (!row || row.state !== 'running') return { result: null, cancelled: true }
      const params = raw as Params
      const result = row.result as AnnualTaskResult
      if (!result || params.ruleVersion !== VERSION || result.ruleVersion !== VERSION) annualFail('rule_version_changed')
      // Request-local batching. SQLite's connection counters invalidate the source
      // cache across yields; decisions are still read live under each step lock.
      // Own synchronous job/decision writes advance only the acknowledged counter.
      let cached: ReturnType<typeof readAnnualScopes> | undefined
      let ownChanges = -1, dataVersion = -1
      const changes = () => ctx.db.get<{ n: number }>(sql`select total_changes() n`)!.n
      const ownWrite = <T>(write: () => T): T => {
        const before = changes()
        try { return write() } finally { ownChanges += changes() - before }
      }
      const readCurrent: AnnualScopeReader = read.batch ? (db, id) => {
        const version = db.get<{ data_version: number }>(sql`PRAGMA data_version`)!.data_version
        if (!cached || ownChanges !== changes() || dataVersion !== version) {
          cached = readAnnualScopes(db, read, params.eventIds)
          ownChanges = changes()
          dataVersion = version
        }
        return cached.get(id) ?? null
      } : read
      result.attempt++
      const persist = () => ownWrite(() => {
        setJobResult(ctx.db,ctx.jobId,result)
        ctx.progress(result.events.filter(e => ['done','failed'].includes(e.status)).length,result.events.length)
      })
      persist()
      for (const event of result.events) {
        if (event.status === 'done') continue
        if (ctx.cancelled()) return { result, cancelled: true }
        event.status = 'running'
        delete event.errorCode
        persist()
        try {
          const scope = readCurrent(ctx.db,event.eventId)
          if (!scope) annualFail('event_unavailable',422)
          if (scope.generation !== event.generation) annualFail('source_generation_changed')
          for (const step of scope.steps) {
            if (event.outcomes.some(o => o.stepId === step.stepId)) continue
            if (ctx.cancelled()) return { result, cancelled: true }
            // Each step commit is independently durable. A crash before this
            // checkpoint re-reads its real decision without appending an audit.
            const outcome = ownWrite(() => reconcileAnnualStep(ctx.db,readCurrent,{ eventId: event.eventId, generation: event.generation, stepId: step.stepId }))
            event.outcomes.push(outcome)
            persist()
            await yieldTurn()
          }
          const fresh = readCurrent(ctx.db,event.eventId)
          if (!fresh) annualFail('event_unavailable',422)
          event.finalQualification = qualifyAnnualFinal(ctx.db,fresh,event.generation)
          if (fresh.generation !== event.generation) annualFail('source_generation_changed')
          event.status = 'done'
        } catch (cause) {
          event.status = 'failed'
          event.errorCode = annualErrorCode(cause)
          event.finalQualification = { stepId:null,status:'blocked',decisionRefs:[],reasons:[event.errorCode] }
        }
        persist()
        await yieldTurn()
      }
      return { result, progress: { done: result.events.length, total: result.events.length }, ...(result.events.some(e => e.status === 'failed') ? {error:'annual_event_failed'} : {}) }
    },
  }
}
export function annualErrorCode(cause: unknown): string {
  const code = (cause as {code?:string})?.code
  return ['source_generation_changed','event_unavailable','source_materialization_limit','rule_version_changed','invalid_annual_task_request','idempotency_conflict','protected_decision','retry_unavailable','invalid_endpoint_type','identity_conflict','title_conflict','ambiguous_candidate','incomplete_coverage','stale_revision','plan_mismatch'].includes(code ?? '') ? code! : 'annual_step_failed'
}
export function activateAnnualCorrespondence(db: AnnualDb, read: AnnualScopeReader, ids: readonly string[], filesDir: string, logContext?: LogContext) {
  if (!getJobSpec(KIND)) registerJob(annualCorrespondenceSpec(read))
  for (const id of ids) enqueuePersistedJob(db,id,filesDir,logContext)
}
/** Server startup, never a read-request side effect. The existing runner marks
 * interrupted work failed so a refresh can offer explicit checkpoint retry. */
export function initializeAnnualCorrespondenceRunner(db: AnnualDb, read: AnnualScopeReader): number {
  if (!getJobSpec(KIND)) registerJob(annualCorrespondenceSpec(read))
  return annualDbReadonly(db) ? 0 : ensureJobRunnerReady(db)
}
export function submitAnnualCorrespondence(db: AnnualDb, read: AnnualScopeReader, raw: unknown, filesDir: string, logContext?: LogContext) {
  ensureJobRunnerReady(db)
  const accepted = stageAnnualCorrespondence(db,read,raw,logContext)
  activateAnnualCorrespondence(db,read,[accepted.jobId],filesDir,logContext)
  return accepted
}
export function retryAnnualCorrespondence(db: AnnualDb, read: AnnualScopeReader, id: string, filesDir: string, logContext?: LogContext) {
  ensureJobRunnerReady(db)
  const row = getJob(db,id)
  const result = row?.result as AnnualTaskResult | null
  if (!row || row.kind !== KIND || !['failed','cancelled'].includes(row.state) || !result || result.attempt >= 10 || result.ruleVersion !== VERSION) annualFail('retry_unavailable')
  // A stale generation needs a new submission, never an old continuation.
  db.transaction(() => {
    const scopes = readAnnualScopes(db, read, result.events.map(e => e.eventId))
    for (const event of result.events) if ((scopes.get(event.eventId)?.generation ?? 'event_unavailable') !== event.generation) annualFail('source_generation_changed')
  })
  if (!getJobSpec(KIND)) registerJob(annualCorrespondenceSpec(read))
  if (!requeueFinishedJob(db,{id,kind:KIND,params:row.params,filesDir,logContext})) annualFail('retry_unavailable')
  return receipt(getJob(db,id)!)
}
