import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { RosterImportItemResult, RosterImportPreflight, RosterImportRequest, RosterImportSummary } from '../../lib/roster-import-client'
import { executePostgresAliasItems } from './alias-import-postgres'
import { executePostgresUsccBackfillItems } from './uscc-backfill-postgres'
import {
  executePostgresExportItems, executePostgresRosterImport, lockPostgresRosterImportBatch, type NativeImportExecution,
  type PostgresImportAction, type PostgresImportBatch,
} from './roster-export-import-postgres'
import { usePostgresRosterDb } from './postgres-roster-db'
import { applyPostgresOfficialImport, planPostgresOfficialImport } from './official-evidence-import-postgres'
import { OfficialFactError } from './official-evidence-plan'
import { OfficialEvidenceError } from './official-evidence'
import { hasOfficialFactInput } from './roster-import'
import { hasAnnouncementRows } from '../../lib/roster-import-client'
import { executePostgresPlatformItems } from './collection-import-postgres'
import { stagePostgresAnnouncement } from './announcement-intake-postgres'
import { planPostgresRawAnnouncementPreflight } from './announcement-preflight-postgres'
import { planPostgresAnnouncementReplay, writePostgresAnnouncementReplay } from './announcement-replay-postgres'
import { planPostgresImportDifference, writePostgresImportDifference } from './difference-import-postgres'
import { validateRosterImportPageCounts } from './roster-import-page-validation'
import { applyPostgresRosterMerge, planPostgresRosterMerge } from './roster-merge-postgres'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type ImportStep = {
  execute: (tx: Tx, batch: PostgresImportBatch, action: PostgresImportAction) => Promise<NativeImportExecution>
  writeForPreflight?: boolean
}
const emptySummary = { written: 0, skipped: 0, failed: 0, evidenceRepointed: 0 }

class RollbackImport extends Error {
  constructor(readonly result: NativeImportExecution) { super('roster_import_rollback') }
}

export async function executePostgresImportSteps(
  tx: Tx, batch: PostgresImportBatch, action: PostgresImportAction, steps: readonly ImportStep[],
): Promise<NativeImportExecution> {
  const preflight: RosterImportPreflight = { add: 0, update: 0, remove: 0, review: 0,
    evidenceRepoints: 0, conflicts: [], batchStatus: batch.status }
  const summary: RosterImportSummary = { ...emptySummary }
  const items: RosterImportItemResult[] = []
  const candidateTaskIds: string[] = []
  try {
    return await tx.transaction(async nested => {
      for (const step of steps) {
        const phase = await step.execute(nested, batch, action === 'preflight' && step.writeForPreflight ? 'commit' : action)
        const { preflight: preview } = phase
        for (const key of ['add', 'update', 'remove', 'review', 'evidenceRepoints'] as const) preflight[key] += preview[key]
        for (const key of ['platformLegacyProvenanceSources','platformObservationSources','canonicalProjection','duplicateCandidates','qualificationDiagnostics'] as const) {
          if (preview[key] !== undefined) Object.assign(preflight, { [key]: [...(preflight[key] ?? []), ...preview[key]] })
        }
        if (preview.qualificationReadback) preflight.qualificationReadback = preview.qualificationReadback
        if (preview.officialEvidencePlanHash) preflight.officialEvidencePlanHash = preview.officialEvidencePlanHash
        preflight.conflicts.push(...preview.conflicts)
        if (!phase.summary) continue
        if (phase.error !== null) {
          if (action === 'preflight') {
            if (!preview.conflicts.length) preflight.conflicts.push(...phase.items.filter(item => !item.ok))
            throw new RollbackImport({ preflight })
          }
          const reverted = items.map(item => ({ ...item, ok: false,
            error: { code: 'commit_rolled_back', message: '整批回滚，本项未写入' } }))
          const failed = [...reverted, ...phase.items]
          throw new RollbackImport({ preflight, items: failed, summary: { ...emptySummary, failed: failed.filter(item => !item.ok).length },
            error: phase.error })
        }
        items.push(...phase.items)
        for (const key of ['written','skipped','evidenceRepointed'] as const) summary[key] += phase.summary[key]
        if (phase.summary.canonicalProjection) summary.canonicalProjection = phase.summary.canonicalProjection
        if (phase.summary.platformFields) summary.platformFields = phase.summary.platformFields
        candidateTaskIds.push(...phase.candidateTaskIds ?? [])
      }
      if (action === 'preflight') throw new RollbackImport({ preflight })
      return { preflight, items, summary, error: null, candidateTaskIds }
    })
  } catch (error) {
    if (error instanceof RollbackImport) return error.result
    throw error
  }
}

async function executePostgresOfficialItems(tx: Tx, batch: PostgresImportBatch, action: PostgresImportAction,
  request: RosterImportRequest, filesDir?: string): Promise<NativeImportExecution> {
  const preflight: RosterImportPreflight = { add: 0, update: 0, remove: 0, review: 0, evidenceRepoints: 0, conflicts: [] }
  try {
    return await tx.transaction(async nested => {
      const plan = await planPostgresOfficialImport(nested, request, { filesDir })
      if (!plan) return action === 'preflight' ? { preflight } : { preflight, items: [], summary: emptySummary, error: null }
      preflight.officialEvidencePlanHash = plan.planHash
      preflight.update = 1
      if (action === 'preflight') return { preflight }
      const item = await applyPostgresOfficialImport(nested, plan, batch.id, request.payload.officialEvidencePlanHash)
      return { preflight, items: [item], summary: { ...emptySummary, written: Number(item.detail?.rowsWritten ?? 0) }, error: null }
    })
  } catch (error) {
    if (!(error instanceof OfficialFactError || error instanceof OfficialEvidenceError)) throw error
    const item: RosterImportItemResult = { ok: false, kind: 'official_evidence', ref: 'payload', error: { code: error.code, message: error.message } }
    preflight.conflicts.push(item)
    return action === 'preflight' ? { preflight } : { preflight, items: [item], summary: { ...emptySummary, failed: 1 }, error: error.message }
  }
}

async function executePostgresDifferenceItems(tx: Tx, action: PostgresImportAction,
  differences: NonNullable<RosterImportRequest['payload']['differences']>): Promise<NativeImportExecution> {
  const plans = []
  for (const [index, difference] of differences.entries()) plans.push(await planPostgresImportDifference(tx,difference,index))
  const items = plans.map(plan=>plan.item)
  const conflicts = items.filter(item=>!item.ok)
  const preflight: RosterImportPreflight = { add: plans.filter(plan=>plan.action==='add').length, update: 0, remove: 0,
    review: plans.filter(plan=>plan.review).length, conflicts, evidenceRepoints: 0 }
  if (action === 'preflight') return { preflight }
  if (conflicts.length) return { preflight, items, summary:{ ...emptySummary, failed: conflicts.length },
    error:'批次校验未通过，未写入任何数据' }
  let written = 0
  for (const [index,plan] of plans.entries()) {
    const item = await writePostgresImportDifference(tx,plan)
    items[index] = item
    if (!item.ok) return { preflight, items: [
      ...items.slice(0,index).map(row=>({ ...row,ok:false,error:{code:'commit_rolled_back',message:'整批回滚，本项未写入'} })),
      item,
      ...items.slice(index+1).map(row=>({ ...row,ok:false,error:{code:'not_executed',message:'整批回滚，本项未执行'} })),
    ], summary: { ...emptySummary, failed: items.length }, error:'批次执行失败，未写入任何数据' }
    written += Number(item.detail?.rowsWritten ?? 0)
  }
  return { preflight, items, summary: { ...emptySummary, written, skipped: items.length-written }, error: null }
}

async function executePostgresMergeItems(tx: Tx, action: PostgresImportAction,
  merges: NonNullable<RosterImportRequest['payload']['merges']>): Promise<NativeImportExecution> {
  const preflight: RosterImportPreflight = { add: 0, update: 0, remove: 0, review: 0, conflicts: [], evidenceRepoints: 0 }
  const items: RosterImportItemResult[] = []
  for (const [index,merge] of merges.entries()) {
    const { item, plan } = await planPostgresRosterMerge(tx,merge,index)
    if (plan) {
      preflight.update++
      preflight.remove++
    } else preflight.conflicts.push(item)
    if (action === 'preflight') continue
    const result = plan ? await applyPostgresRosterMerge(tx,plan) : item
    if (!result.ok) return { preflight, items: [
      ...items.map(row=>({ ...row,ok:false,error:{code:'commit_rolled_back',message:'整批回滚，本项未写入'} })),
      result,
      ...merges.slice(index+1).map((_,offset)=>({ kind:'merge',ref:'merge:'+(index+offset+1),ok:false,
        error:{code:'not_executed',message:'整批回滚，本项未执行'} })),
    ], summary: { ...emptySummary, failed: merges.length }, error:'批次执行失败，未写入任何数据' }
    items.push(result)
  }
  if (action === 'preflight') return { preflight }
  return { preflight, items, summary: { ...emptySummary, written: items.reduce((n,item)=>n+Number(item.detail?.rowsWritten ?? 0),0) },
    error: null }
}

export function runPostgresMixedImport(action: 'preflight' | 'commit' | 'replay', request: RosterImportRequest, filesDir?: string) {
  const announcement = hasAnnouncementRows(request)
  const db = usePostgresRosterDb(true)
  if (!db) return
  if (action === 'replay') return executePostgresRosterImport(db, action, request, async (tx,batch) => {
    const original = await lockPostgresRosterImportBatch(tx, request.idempotencyKey)
    const plan = await planPostgresAnnouncementReplay(tx, request, original)
    const { items, update, evidenceRepointed } = await writePostgresAnnouncementReplay(tx, request, plan)
    const failed = items.filter(item=>!item.ok).length
    return { preflight: { ...plan.preflight, batchStatus: batch.status }, items,
      summary: { ...emptySummary, failed, evidenceRepointed }, replayUpdate: update,
      error: failed ? '收敛重放未执行：载荷有 '+failed+' 项不合法，未改动任何行' : null }
  })
  if (announcement && action === 'commit') {
    return validateRosterImportPageCounts(request, filesDir).then(errors=>stagePostgresAnnouncement(request,errors))
  }
  const steps = createPostgresImportSteps(action,request,filesDir)
  return executePostgresRosterImport(db, action, request, (tx,batch) => executePostgresImportSteps(tx,batch,action,steps))
}

export function createPostgresImportSteps(action: PostgresImportAction, request: RosterImportRequest,
  filesDir?: string, afterAnnouncement = false): ImportStep[] {
  const { aliases, exportSnapshot, usccBackfills, platformQueries, platformLegacyProvenance,
    platformRecordObservations, differences, merges } = request.payload
  const announcement = hasAnnouncementRows(request)
  const steps: ImportStep[] = []
  if (announcement && !afterAnnouncement) steps.push({
    execute: async tx => {
      const pageCountErrors = await validateRosterImportPageCounts(request, filesDir)
      return { preflight: await planPostgresRawAnnouncementPreflight(tx, request, { filesDir, pageCountErrors }) }
    },
  })
  if (platformQueries?.length || platformLegacyProvenance?.length || platformRecordObservations?.length) steps.push({
    writeForPreflight: Boolean(platformQueries?.length && (aliases?.length || differences?.length || merges?.length)),
    execute: (tx,batch,operation) => executePostgresPlatformItems(tx,batch,operation,request,undefined,action==='commit'),
  })
  if (Array.isArray(aliases) && aliases.length) steps.push({
    execute: (tx,batch,operation) => executePostgresAliasItems(tx,batch,operation,aliases),
  })
  if (Array.isArray(differences) && differences.length) steps.push({
    execute: (tx,_batch,operation) => executePostgresDifferenceItems(tx,operation,differences),
  })
  if (exportSnapshot) steps.push({
    execute: (tx,batch,operation) => executePostgresExportItems(tx,batch,operation,exportSnapshot),
  })
  if (Array.isArray(usccBackfills) && usccBackfills.length) steps.push({
    writeForPreflight: Boolean(merges?.length),
    execute: (tx,batch,operation) => executePostgresUsccBackfillItems(tx,batch,operation,usccBackfills),
  })
  if (!announcement && !afterAnnouncement && hasOfficialFactInput(request)) steps.push({
    execute: (tx,batch,operation) => executePostgresOfficialItems(tx,batch,operation,request,filesDir),
  })
  if (Array.isArray(merges) && merges.length) steps.push({
    execute: (tx,_batch,operation) => executePostgresMergeItems(tx,operation,merges),
  })
  return steps
}
