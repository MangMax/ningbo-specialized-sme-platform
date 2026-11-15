import { createEnterpriseReadProcess } from '../../../server/utils/enterprise-read-process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { initializeDb } from '../../../db/client'
import { createImportExecutor } from '../../../server/utils/import-execution'
import { registerJob, submitJob, whenIdle } from '../../../server/utils/job-runner'
import { getJob } from '../../../server/utils/job-store'
import { submitCandidateDiscovery } from '../../../server/utils/jobs/candidate-discovery'
import type { RosterImportRequest } from '../../../lib/roster-import-client'

it.each(['completion', 'candidate checkpoint'] as const)('persists %s after an active import without blocking lock release or losing its result', async mode => {
  const dir = mkdtempSync(join(tmpdir(), 'job-import-contention-'))
  const path = join(dir, 'roster.db'), db = initializeDb({ create: true, dbPath: path })
  const request: RosterImportRequest = { idempotencyKey: 'job-import-contention', sourceKind: 'platform_export', sourceIdentity: 'synthetic/contention.xlsx', payload: { exportSnapshot: { titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-20', originalFilename: 'contention.xlsx', sha256: 'contention-v1', rows: [{ sourceRowNo: 3, rawFields: { original: 'retained' } }] } } }
  let started!: () => void, complete!: () => void
  const running = new Promise<void>(resolve => { started = resolve })
  const finish = new Promise<void>(resolve => { complete = resolve })
  const executor = createImportExecutor({ createWorker: () => createEnterpriseReadProcess(new URL('../../../.output/server/import-execution-worker.mjs', import.meta.url)) })
  const blocker = new Database(path)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await executor.execute(db, 'preflight', request)
    registerJob({ kind: 'synthetic-import-contention-' + mode, status: 'ready', summary: 'Import contention', parse: params => ({ ok: true, params }), run: async () => { started(); await finish; return { result: { retained: true } } } })
    const id = mode === 'completion'
      ? submitJob(db, { kind: 'synthetic-import-contention-' + mode, params: {}, filesDir: dir }).id
      : submitCandidateDiscovery(db, { clientRequestId: 'candidate-checkpoint', titleCode: 'specialized_sme' }, dir).jobId
    if (mode === 'completion') await running
    else await Promise.resolve()
    blocker.exec('BEGIN IMMEDIATE')
    const imported = executor.execute(db, 'commit', request)
    let released = false
    timer = setTimeout(() => { blocker.exec('ROLLBACK'); released = true }, 50)
    complete()
    expect(await imported).toMatchObject({ status: 'committed' })
    await whenIdle()
    expect(released).toBe(true)
    expect(getJob(db, id)).toMatchObject({ state: 'done', result: mode === 'completion' ? { retained: true } : { counts: { failed: 0 } } })
  } finally {
    if (timer) clearTimeout(timer)
    if (blocker.inTransaction) blocker.exec('ROLLBACK')
    complete()
    await executor.close()
    await whenIdle()
    blocker.close(); db.$client.close(); rmSync(dir, { recursive: true, force: true })
  }
}, 15000)
