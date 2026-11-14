/** One offline path from a frozen schema0 snapshot to the retired runtime. */
import Database from 'better-sqlite3'
import { constants, copyFileSync, existsSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { execFileSync } from 'node:child_process'
import { withFrozenSource, upgradeCollections, fileHash } from './collections'
import { installBusinessStatusPrerequisite } from './business-status'
import { installReconcileSlotPrerequisite } from './reconcile-slot-schema'
import { upgradeObservations } from './observations'
import { upgradeProjections } from './projections'
import { finalizeObservations, finalizeCollectionScopes } from './finalize-observations'
import { finalizeFingerprintBasis } from './fingerprint-basis'
import { finalizeApplyStored } from './apply-stored'
import { finalizeCandidateScopes } from './candidate-scope'
import { finalizeRecognizedStored } from './recognized-stored'
import { finalizeRecognizedWitness } from './recognized-witness'
import { finalizeProcessStored } from './process-stored'
import { transferCorrespondence } from './correspondence'
import { transferDifferenceReferences } from './difference-references'
import { indexLegacyProvenance } from './legacy-provenance'
import { completeReconcileSlotCapture } from './reconcile-slot-capture'
import { retirePlatformModel } from './retire-platform-model'
import { RECONCILE_SLOT_T04 } from '../lib/platform/reconcile-slot-capture'
import { BUSINESS_STATUS_V2 } from '../lib/platform/business-status'
import { withFinalUpgradeIntegrity } from './integrity-policy'

function cloneDatabase(from: string, into: string) {
  if (process.platform === 'darwin') execFileSync('/bin/cp', ['-c', from, into])
  else copyFileSync(from, into, constants.COPYFILE_FICLONE)
}

export function completePlatformMigration(source: string, target: string, evidence: string, resume = false) {
  if (existsSync(target) !== resume) throw new Error('Use a new isolated target, or explicitly resume an existing run')
  const expanded = join(evidence, 'expanded-source.sqlite')
  if (!resume) {
    if (existsSync(expanded)) throw new Error('Expanded source already exists; use a fresh evidence directory')
    const originalHash = withFrozenSource(source, frozen => fileHash(frozen.fd))
    cloneDatabase(source, expanded)
    const db = new Database(expanded)
    try {
      db.pragma('foreign_keys=ON')
      migrate(drizzle(db), { migrationsFolder: new URL('../db/migrations', import.meta.url).pathname })
      db.pragma('journal_mode=DELETE')
    } finally { db.close() }
    writeFileSync(join(evidence, 'source-preparation.json'), JSON.stringify({ originalSource:source, originalSha256:originalHash, expandedSource:expanded, operation:'additive expand migrations on an isolated clone' }, null, 2))
  } else if (!existsSync(expanded)) throw new Error('Resume requires the original prepared source')
  source = expanded
  const checkpoint = join(evidence, 'predecessor.sqlite')
  if (!resume && existsSync(checkpoint)) throw new Error('Evidence predecessor already exists')
  if (resume) {
    const recovery = new Database(target)
    try {
      recovery.prepare('SELECT count(*) FROM sqlite_schema').get()
      const version = z.number().int().parse(recovery.pragma('user_version', { simple:true }))
      // Finish SQLite recovery and retire a cold rollback journal left by a
      // stopped process, without changing the target's logical schema or rows.
      recovery.pragma('journal_mode=DELETE')
      recovery.transaction(() => recovery.pragma(`user_version=${version}`)).immediate()
    } finally { recovery.close() }
    const original = z.object({ sourceSha256:z.string() }).parse(JSON.parse(readFileSync(join(evidence, 'status-prerequisite.json'), 'utf8')))
    withFrozenSource(source, frozen => {
      if (fileHash(frozen.fd) !== original.sourceSha256) throw new Error('Resume source differs from the original frozen snapshot')
    })
  }
  return withFinalUpgradeIntegrity(target, () => {
  const clone = cloneDatabase
  const receiptSchema = z.array(z.object({ stage:z.string(), milliseconds:z.number(), integrity:z.string(), result:z.unknown() }))
  const receipts = resume ? receiptSchema.parse(JSON.parse(readFileSync(join(evidence, 'stages.json'), 'utf8'))) : []
  function run(stage: string, action: () => unknown) {
    if (receipts.some(receipt => receipt.stage === stage)) {
      if (stage === 'retirement') action()
      process.stdout.write(stage + ' retained from completed checkpoint\n'); return
    }
    const start = performance.now(), result = action()
    receipts.push({ stage, milliseconds: performance.now() - start, integrity: stage === 'retirement' ? 'full_check_in_retirement_transaction' : 'deferred_to_retirement', result })
    writeFileSync(join(evidence, 'stages.json'), JSON.stringify(receipts, null, 2))
    process.stdout.write(stage + ' complete\n')
    return result
  }
  function next<T>(stage: string, action: (predecessor: string) => T) {
    if (receipts.some(receipt => receipt.stage === stage)) return run(stage, () => undefined)
    if (existsSync(checkpoint)) unlinkSync(checkpoint)
    clone(target, checkpoint)
    return run(stage, () => action(checkpoint))
  }
  run('prerequisites', () => withFrozenSource(source, frozen => {
    clone(source, target)
    const db = new Database(target)
    try { migrate(drizzle(db), { migrationsFolder: new URL('../db/migrations', import.meta.url).pathname }) } finally { db.close() }
    installBusinessStatusPrerequisite(target, frozen, join(evidence, 'status-prerequisite.json'))
    return installReconcileSlotPrerequisite(target, frozen)
  }))
  const common = { source, target, batchSize: 100, collectionRunId: 'complete-collections', observationRunId: 'complete-observations', projectionRunId: 'complete-projections', finalizationRunId: 'complete-observation-final' }
  withFrozenSource(source, frozen => {
    run('collections', () => upgradeCollections({ ...common, runId: common.collectionRunId, transformVersion: RECONCILE_SLOT_T04 }, frozen))
    run('observations', () => upgradeObservations({ ...common, runId: common.observationRunId }, frozen))
    run('projections', () => upgradeProjections({ ...common, runId: common.projectionRunId, transformVersion: BUSINESS_STATUS_V2 }, frozen))
    run('final-observations', () => finalizeObservations({ ...common, runId: common.finalizationRunId }, frozen))
    run('scopes', () => finalizeCollectionScopes({ ...common, runId: 'complete-scopes' }, frozen))
  })
  next('fingerprints', predecessor => finalizeFingerprintBasis({ source: predecessor, target, runId: 'complete-fingerprints', predecessorRunId: 'complete-scopes', legacySource: source }))
  next('apply', predecessor => finalizeApplyStored({ source: predecessor, target, runId: 'complete-apply', predecessorRunId: 'complete-fingerprints', legacySource: source }))
  next('candidates', predecessor => finalizeCandidateScopes({ source: predecessor, target, runId: 'complete-candidates', predecessorRunId: 'complete-apply' }))
  next('recognized', predecessor => finalizeRecognizedStored({ source: predecessor, target, runId: 'complete-recognized', predecessorRunId: 'complete-candidates' }))
  next('witness', predecessor => finalizeRecognizedWitness({ source: predecessor, target, runId: 'complete-witness', predecessorRunId: 'complete-recognized' }))
  next('process', predecessor => finalizeProcessStored({ source: predecessor, target, runId: 'complete-process', predecessorRunId: 'complete-witness', legacySource: source }))
  next('correspondence', predecessor => transferCorrespondence({ source: predecessor, target, runId: 'complete-correspondence' }))
  next('differences', predecessor => transferDifferenceReferences({ source: predecessor, target, runId: 'complete-differences' }))
  next('provenance', predecessor => indexLegacyProvenance({ source: predecessor, target, runId: 'complete-provenance', batchSize: 1000 }))
  run('reconcile', () => completeReconcileSlotCapture({ source, target, runId: 'complete-reconcile', collectionRunId: common.collectionRunId }))
  run('source-final-hash', () => withFrozenSource(source, frozen => {
    const original = z.object({ sourceSha256:z.string() }).parse(JSON.parse(readFileSync(join(evidence, 'status-prerequisite.json'), 'utf8')))
    const sha256 = fileHash(frozen.fd, true)
    if (sha256 !== original.sourceSha256) throw new Error('Frozen source changed during complete migration')
    return { sha256 }
  }))
  run('retirement', () => {
    const db = new Database(target)
    try { db.pragma('foreign_keys=ON'); return retirePlatformModel(db) } finally { db.close() }
  })
  if (existsSync(checkpoint)) unlinkSync(checkpoint)
  return receipts
  })
}
