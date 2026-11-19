import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applicationLogs, closeApplicationLogging, initializeWorkerLogging } from '../../../layers/core/lib/logging'
import { initializeDb } from '../../../db/client'
import { maintainStoredFile } from '../../../layers/core/server/utils/file-maintenance'
import { handleStoredFilePatchRequest } from '../../../layers/core/server/utils/stored-file-patch-http'

/**
 * #180 follow-up: the three known file-maintenance failure sites carry the
 * attempted target id. Result/errorCode are unchanged; invalid ids are not
 * fabricated. Upload-before-id and worker process events stay out of scope.
 */
const dir = mkdtempSync(join(tmpdir(), 'file-log-180-'))
const db = initializeDb({ create: true,  dbPath: join(dir, 'fixture.db') })
const previous = process.env.NUXT_LOG_DIR

beforeAll(() => {
  process.env.NUXT_LOG_DIR = join(dir, 'logs')
  initializeWorkerLogging()
})
afterAll(async () => {
  await closeApplicationLogging()
  db.$client.close()
  if (previous === undefined) delete process.env.NUXT_LOG_DIR
  else process.env.NUXT_LOG_DIR = previous
  rmSync(dir, { recursive: true, force: true })
})

async function events(requestId: string) {
  for (let i = 0; i < 50; i++) {
    await applicationLogs().flush()
    const rows = (await applicationLogs().list({ requestId, limit: 10 })).rows
    if (rows.length) return rows
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return (await applicationLogs().list({ requestId, limit: 10 })).rows
}

it('records the attempted file id on a failed PATCH without changing result or errorCode', async () => {
  const context = { requestId: 'file-180-patch' }
  const result = handleStoredFilePatchRequest('PATCH', 424242, {}, db, context)
  expect(result.status).toBe(404)
  const rows = await events(context.requestId)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    source: 'file',
    operation: 'file.maintenance.update',
    outcome: 'denied',
    errorCode: 'file_maintenance_failed',
    fileId: 424242,
  })
  const detail = await applicationLogs().detail(rows[0]!.id)
  expect(detail).toMatchObject({ fileId: 424242, outcome: 'denied', errorCode: 'file_maintenance_failed' })
})

it('records a valid attempted target on maintainStoredFile failure and omits an invalid one', async () => {
  const valid = { requestId: 'file-180-maintain-valid' }
  await expect(maintainStoredFile(db, dir, 424242, 'update', {}, {}, valid)).rejects.toMatchObject({ statusCode: 404 })
  expect((await events(valid.requestId))[0]).toMatchObject({
    operation: 'file.maintenance.update',
    outcome: 'denied',
    errorCode: 'file_maintenance_failed',
    fileId: 424242,
  })

  const invalid = { requestId: 'file-180-maintain-invalid' }
  await expect(maintainStoredFile(db, dir, 0, 'update', {}, {}, invalid)).rejects.toBeTruthy()
  const invalidRow = (await events(invalid.requestId))[0]!
  expect(invalidRow).toMatchObject({
    operation: 'file.maintenance.update',
    outcome: 'denied',
    errorCode: 'file_maintenance_failed',
  })
  expect(invalidRow).not.toHaveProperty('fileId')
})

it('does not emit a file target for an invalid request id rejected before the maintenance boundary', async () => {
  const context = { requestId: 'file-180-invalid-request' }
  expect(handleStoredFilePatchRequest('PATCH', 'alice', {}, db, context).status).toBe(400)
  await new Promise(resolve => setTimeout(resolve, 20))
  await applicationLogs().flush()
  expect((await applicationLogs().list({ requestId: context.requestId })).rows).toHaveLength(0)
})
