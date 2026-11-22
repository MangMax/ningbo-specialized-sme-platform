import { afterEach, it, expect, vi } from 'vitest'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appLog, applicationLogs, closeApplicationLogging, initializeWorkerLogging } from '../../../layers/core/lib/logging'
const live = it.skipIf(!process.env.ROSTER_TEST_POSTGRES_BIN)
let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
let directory: string | undefined

async function useRuntimeLogs() {
  directory = mkdtempSync(join(tmpdir(), 'evlog-'))
  runtime = await postgresRuntimeFixture({ dir: directory, logsOnly: true })
  for (const [key, value] of Object.entries(runtime.env)) vi.stubEnv(key, value)
  initializeWorkerLogging()
}

afterEach(async () => {
  try { await closeApplicationLogging() }
  finally {
    vi.unstubAllEnvs()
    try { runtime?.close() }
    finally { if (directory) rmSync(directory, { recursive: true, force: true }) }
    runtime = undefined
    directory = undefined
  }
})

live('routes standalone worker events through the real evlog pipeline with safe explicit context', async () => {
  await useRuntimeLogs()
  appLog({ source:'worker',operation:'worker.fixture',outcome:'failure',error:new Error('PRIVATE181_ERROR /Users/private'), errorCode:'fixture_failure' }, { taskId:'task-181',requestId:'req-181',traceId:'trace-181' })
  await applicationLogs().flush()
  const { rows } = await applicationLogs().list({taskId:'task-181'})
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({requestId:'req-181',traceId:'trace-181',level:'error',outcome:'failure'})
  const detail = await applicationLogs().detail(rows[0]!.id)
  expect(detail?.errorCode).toBe('fixture_failure')
  expect(JSON.stringify(detail)).not.toMatch(/PRIVATE181|\/Users\/|stack|message/)
})

live('preserves generated UUIDs that resemble PII through production evlog without admitting raw fields', async () => {
  vi.stubEnv('NODE_ENV', 'production')
  const requestId = '12345678-1234-4123-8123-123456789012'
  await useRuntimeLogs()
  appLog({ source: 'http', operation: 'maintenance.enterprise_profile.patch', outcome: 'failure', errorCode: 'invalid_request', body: { secret: 'PRIVATE_UUID180' } } as any, { requestId, traceId: '87654321-4321-4321-8321-210987654321' })
  await applicationLogs().flush()
  const rows = (await applicationLogs().list({ requestId })).rows
  expect(rows).toHaveLength(1)
  expect(await applicationLogs().detail(rows[0]!.id)).toMatchObject({ requestId, traceId: '87654321-4321-4321-8321-210987654321', errorCode: 'invalid_request' })
  expect(JSON.stringify(await applicationLogs().detail(rows[0]!.id))).not.toContain('PRIVATE_UUID180')
})

it('projects implicit request events before evlog output while retaining safe production correlation', async () => {
  const { createLogger, initLogger } = await import('evlog')
  const config = (await import('../../../evlog.config')).default
  const events: Record<string, any>[] = []
  initLogger({ enabled: true, silent: true, redact: config.redact, drain: ctx => { events.push(ctx.event) } })
  createLogger({ path: '/api/roster/enterprises?token=PRIVATE_UUID180', method: 'PATCH', status: 400,
    requestId: '12345678-1234-4123-8123-123456789012', traceId: '87654321-4321-4321-8321-210987654321',
    headers: { authorization: 'Bearer PRIVATE_UUID180' }, body: { auditId: 999999, receiptId: 'PRIVATE_UUID180' }, message: 'PRIVATE_UUID180',
  }).emit({ _forceKeep: true })
  expect(events).toHaveLength(1)
  expect(events[0]!.applicationLog).toMatchObject({ source: 'http', operation: 'http.request', statusCode: 400, requestId: '12345678-1234-4123-8123-123456789012', traceId: '87654321-4321-4321-8321-210987654321' })
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE_UUID180|headers|authorization|body|message|auditId|receiptId|path/)
})
