import { prepareRuntimeLogs } from '../fixtures/runtime'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appLog, applicationLogs, requestLogContext } from '../../../layers/core/lib/logging'
import { projectEvlog, safeLogEvent } from '../../../layers/core/lib/logging/privacy'
import { safeHttpMethod, safeHttpRoute } from '../../../layers/core/lib/logging/http'

/**
 * #180 runtime-log usability. Uses the real evlog -> allowlist -> PostgreSQL drain;
 * no test-only projection. The business side is untouched.
 */
const directory = mkdtempSync(join(tmpdir(), 'log-usability-180-'))
let runtime: Awaited<ReturnType<typeof prepareRuntimeLogs>>
const PRIVATE = 'PRIVATE180_DO_NOT_PERSIST'

beforeAll(async () => { runtime = await prepareRuntimeLogs(directory) })
afterAll(async () => {
  await runtime?.close()
  rmSync(directory, { recursive: true, force: true })
})

const representative = [
  { source: 'http', operation: 'http.request', outcome: 'success', httpMethod: 'GET', httpRoute: '/api/roster/enterprises/:id', statusCode: 200, durationMs: 12 },
  { source: 'mcp', operation: 'mcp.tool.list_enterprises', outcome: 'success', httpMethod: 'POST', httpRoute: '/mcp', durationMs: 7 },
  { source: 'task', operation: 'task.finished', outcome: 'failure', taskId: 'task-180', counts: { done: 2, total: 3, failed: 1 }, errorCode: 'job_failed', durationMs: 400 },
  { source: 'worker', operation: 'enterprise_read.finished', outcome: 'failure', resourceType: 'enterprise', resourceId: 42, taskId: 'task-180', errorCode: 'worker_failed' },
  { source: 'platform', operation: 'platform.query_list.query.title_1', outcome: 'partial', batchId: 'batch-180', page: 2, counts: { done: 1, total: 2, failed: 1 } },
  { source: 'file', operation: 'file.render', outcome: 'partial', fileId: 180, page: 3, counts: { done: 2, total: 3, failed: 1 }, errorCode: 'pdf_render_failed' },
  { source: 'ocr', operation: 'ocr.page', outcome: 'failure', fileId: 180, page: 2, errorCode: 'ocr_page_failed', counts: { done: 1, total: 2, failed: 1 } },
  { source: 'import', operation: 'import.commit', outcome: 'failure', batchId: 'batch-180', receiptId: 'receipt-180', counts: { done: 1, failed: 1 }, errorCode: 'import_conflict' },
  { source: 'export', operation: 'export.current.publish', outcome: 'success', taskId: 'export-180', resourceType: 'export_artifact', resourceId: 'artifact-180', counts: { done: 1, total: 1 } },
  { source: 'client', operation: 'client.logs.network', outcome: 'failure', errorCode: 'network', level: 'error' },
  { source: 'system', operation: 'logging.clear', outcome: 'success', counts: { done: 1 } },
] as const

it('keeps counts, failure codes and HTTP transport facts in list and detail for all eleven sources', async () => {
  for (const entry of representative) {
    appLog({ ...entry }, { requestId: `req-180-${entry.source}` })
  }
  await applicationLogs().flush()

  for (const entry of representative) {
    const listed = await applicationLogs().list({ requestId: `req-180-${entry.source}`, limit: 1 })
    expect(listed.rows, entry.source).toHaveLength(1)
    const summary = listed.rows[0]!
    expect(summary, entry.source).toMatchObject({
      source: entry.source,
      operation: entry.operation,
      outcome: entry.outcome,
    })
    if ('counts' in entry) expect(summary.counts, entry.source).toEqual(entry.counts)
    if ('errorCode' in entry) expect(summary.errorCode, entry.source).toBe(entry.errorCode)
    if ('httpMethod' in entry) expect(summary.httpMethod, entry.source).toBe(entry.httpMethod)
    if ('httpRoute' in entry) expect(summary.httpRoute, entry.source).toBe(entry.httpRoute)
    if ('fileId' in entry) expect(summary.fileId).toBe(entry.fileId)
    if ('page' in entry) expect(summary.page).toBe(entry.page)
    if ('batchId' in entry) expect(summary.batchId).toBe(entry.batchId)
    if ('taskId' in entry) expect(summary.taskId).toBe(entry.taskId)
    if ('resourceId' in entry) expect(summary.resourceId).toBe(entry.resourceId)

    const detail = await applicationLogs().detail(summary.id)
    expect(detail, entry.source).toMatchObject({ id: summary.id, source: entry.source, operation: entry.operation })
    if ('counts' in entry) expect(detail?.counts, entry.source).toEqual(entry.counts)
    if ('errorCode' in entry) expect(detail?.errorCode, entry.source).toBe(entry.errorCode)
    if ('httpMethod' in entry) expect(detail?.httpMethod, entry.source).toBe(entry.httpMethod)
    if ('httpRoute' in entry) expect(detail?.httpRoute, entry.source).toBe(entry.httpRoute)
  }

  // Single-event references stay detail-only; the list keeps only bounded outcome facts.
  const imported = (await applicationLogs().list({ requestId: 'req-180-import' })).rows[0]!
  expect(imported).not.toHaveProperty('receiptId')
  expect(imported).not.toHaveProperty('auditId')
  expect((await applicationLogs().detail(imported.id))?.receiptId).toBe('receipt-180')
})

it('rejects concrete or hostile path values as routes and never derives a template from the path', () => {
  for (const route of ['/api/files/123', '/api/files/PRIVATE180', '/api/files/alice', '/api/files/bob-smith', '/api/private-secret', '/api/files/a@b.example', '/api/files/20261013', '/api/files/:id?token=1', '/api/files/:id/../x', 'https://untrusted.invalid/api/files/:id', '/api/settings/credentials/synthetic-path-value/reveal']) {
    expect(safeHttpRoute(route), route).toBeUndefined()
  }
  for (const route of ['/api/files/:id', '/api/files/**:path', '/api/roster/decision-lifecycle/commands', '/api/roster/exports/current/specialized-sme', '/api/settings/credentials/:key/reveal', '/mcp']) {
    expect(safeHttpRoute(route), route).toBe(route)
  }
  expect(safeHttpMethod('patch')).toBe('PATCH')
  expect(safeHttpMethod('PURGE')).toBeUndefined()
  expect(safeHttpMethod(PRIVATE)).toBeUndefined()

  const implicit = projectEvlog({
    path: `/api/files/123?token=${PRIVATE}`,
    method: 'PATCH',
    status: 200,
    httpRoute: '/api/files/PRIVATE180',
    headers: { authorization: `Bearer ${PRIVATE}`, cookie: PRIVATE },
    body: { note: PRIVATE },
  })
  const safe = safeLogEvent(implicit)
  expect(safe).toMatchObject({ source: 'http', operation: 'http.request', httpMethod: 'PATCH' })
  expect(safe.httpRoute).toBeUndefined()
  expect(JSON.stringify(safe)).not.toMatch(new RegExp(PRIVATE))
  expect(JSON.stringify(safe)).not.toContain('authorization')
  expect(JSON.stringify(safe)).not.toContain('cookie')
  expect(JSON.stringify(safe)).not.toContain('body')

  const injectedApplicationLog = safeLogEvent(projectEvlog({
    applicationLog: { source: 'http', operation: 'http.request', outcome: 'success', httpMethod: 'GET', httpRoute: '/api/files/alice', statusCode: 200 },
    path: '/api/files/alice',
    method: 'GET',
    status: 200,
  }) as any)
  expect(injectedApplicationLog.httpRoute).toBeUndefined()

  const matched = safeLogEvent(projectEvlog({ path: '/api/files/123', method: 'get', status: 200, httpRoute: '/api/files/:id' }))
  expect(matched).toMatchObject({ httpMethod: 'GET', httpRoute: '/api/files/:id' })
  expect(JSON.stringify(matched)).not.toContain('/api/files/123')

  for (const path of ['/api/files/zhangsan', '/api/files/zhangsan@example.com', '/api/files/abcdefghijklmnop']) {
    const derived = safeLogEvent(projectEvlog({ path, method: 'GET', status: 200 }))
    expect(derived.httpRoute, path).toBeUndefined()
    expect(JSON.stringify(derived)).not.toContain(path)
  }

  const unknown = safeLogEvent(projectEvlog({ path: `/api/unknown/${PRIVATE}`, method: 'GET', status: 404 }))
  expect(unknown).toMatchObject({ httpMethod: 'GET', outcome: 'denied', statusCode: 404 })
  expect(unknown).not.toHaveProperty('httpRoute')
  expect(JSON.stringify(unknown)).not.toContain(PRIVATE)
})

it('carries framework transport facts into request-scoped semantic events only for HTTP/MCP', async () => {
  const context = requestLogContext({
    context: {
      applicationLogContext: { requestId: 'req-180-semantic' },
      matchedRoute: { path: '/api/roster/enterprises/:id/aliases/:aliasId' },
    },
    method: 'patch',
  })
  appLog({ source: 'http', operation: 'maintenance.alias.patch', outcome: 'success' }, context)
  appLog({ source: 'task', operation: 'task.queued', outcome: 'started', taskId: 'task-180-semantic' }, context)
  await applicationLogs().flush()
  const http = (await applicationLogs().list({ requestId: 'req-180-semantic' })).rows.find(row => row.source === 'http')!
  expect(http).toMatchObject({ operation: 'maintenance.alias.patch', httpMethod: 'PATCH', httpRoute: '/api/roster/enterprises/:id/aliases/:aliasId' })
  const task = (await applicationLogs().list({ taskId: 'task-180-semantic' })).rows[0]!
  expect(task).not.toHaveProperty('httpMethod')
  expect(task).not.toHaveProperty('httpRoute')
})

it('isolates malformed transport input without changing the stored outcome or availability', async () => {
  expect(() => appLog({
    source: 'http', operation: 'http.fault_fixture', outcome: 'success',
    httpMethod: PRIVATE as string, httpRoute: `/api/files/${PRIVATE}` as string,
  })).not.toThrow()
  await applicationLogs().flush()
  const row = (await applicationLogs().list({ operation: 'http.fault_fixture', limit: 10 })).rows[0]
  expect(row).toBeTruthy()
  expect(row).not.toHaveProperty('httpMethod')
  expect(row).not.toHaveProperty('httpRoute')
  expect(JSON.stringify(row)).not.toContain(PRIVATE)
  expect(applicationLogs().status().unavailable).toBe(false)
})

it('drops non-template applicationLog routes from stdout and SQLite while keeping real templates', async () => {
  const rejected = ['/api/files/alice', '/api/files/bob-smith', '/api/private-secret']
  // The service's stdout fallback is bounded at 10 lines/second; earlier tests used the window.
  await new Promise(resolve => setTimeout(resolve, 1100))
  const writes: string[] = []
  const output = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any, callback?: any) => {
    writes.push(String(chunk))
    callback?.()
    return true
  })
  try {
    for (const [index, route] of rejected.entries()) {
      appLog({ source: 'http', operation: 'http.private_fixture', outcome: 'failure', level: 'error', httpRoute: route, counts: { failed: index + 1 } }, { requestId: `req-180-private-${index}` })
    }
    appLog({ source: 'http', operation: 'http.known_fixture', outcome: 'success', httpRoute: '/api/files/:id' }, { requestId: 'req-180-known' })
    // evlog drains asynchronously; wait until the real pipeline stored the event before restoring the spy.
    for (let i = 0; i < 100; i++) {
      if ((await applicationLogs().list({ operation: 'http.known_fixture', limit: 1 })).rows.length) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await applicationLogs().flush()
    // SQLite completion and the Worker's forwarded stdout are separate
    // observations. Keep the spy installed until the output being asserted
    // actually reaches this process; do not infer pipe delivery from storage.
    await vi.waitFor(() => expect(writes.join('')).toContain('/api/files/:id'), { timeout: 1000, interval: 10 })
  } finally {
    output.mockRestore()
  }
  const privateRows = (await applicationLogs().list({ operation: 'http.private_fixture', limit: 10 })).rows
  expect(privateRows).toHaveLength(rejected.length)
  for (const [index, route] of rejected.entries()) {
    const row = privateRows.find(candidate => candidate.requestId === `req-180-private-${index}`)!
    expect(row, route).toMatchObject({ outcome: 'failure', counts: { failed: index + 1 } })
    expect(row).not.toHaveProperty('httpRoute')
  }
  const known = (await applicationLogs().list({ operation: 'http.known_fixture', limit: 1 })).rows[0]!
  expect(known.httpRoute).toBe('/api/files/:id')
  const db = runtime.psql(['-c', 'SELECT row_to_json(event) FROM runtime_logs.log_events AS event'])
  const printed = writes.join('')
  for (const route of rejected) {
    expect(printed, route).not.toContain(route)
    expect(db, route).not.toContain(route)
  }
  expect(printed).toContain('/api/files/:id')
  expect(db).toContain('/api/files/:id')
})

it('still lists and reads rows written before the new fields and list counts existed', async () => {
  const legacyDirectory = mkdtempSync(join(tmpdir(), 'log-usability-legacy-'))
  const { createLogService } = await import('../../../layers/core/lib/logging/sqlite-service')
  const service = createLogService({ directory: legacyDirectory })
  try {
    service.emit({ source: 'worker', operation: 'legacy.fixture', outcome: 'failure', errorCode: 'old_code', counts: { done: 1 }, taskId: 'task-legacy' })
    await service.flush()
  } finally {
    await service.close()
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(join(legacyDirectory, 'events.db'))
  try {
    const row = db.prepare('SELECT id, summary, detail FROM log_events LIMIT 1').get() as { id: string; summary: string; detail: string }
    const summary = JSON.parse(row.summary)
    const detail = JSON.parse(row.detail)
    for (const key of ['counts', 'errorCode', 'httpMethod', 'httpRoute']) { delete summary[key]; delete detail[key] }
    db.prepare('UPDATE log_events SET summary=?, detail=? WHERE id=?').run(JSON.stringify(summary), JSON.stringify(detail), row.id)
  } finally {
    db.close()
  }
  const reopened = createLogService({ directory: legacyDirectory })
  try {
    const listed = await reopened.list({ taskId: 'task-legacy' })
    expect(listed.rows).toHaveLength(1)
    expect(listed.rows[0]).toMatchObject({ source: 'worker', operation: 'legacy.fixture', outcome: 'failure', taskId: 'task-legacy' })
    expect(listed.rows[0]).not.toHaveProperty('counts')
    expect(listed.rows[0]).not.toHaveProperty('errorCode')
    expect(listed.rows[0]).not.toHaveProperty('httpMethod')
    expect(listed.rows[0]).not.toHaveProperty('httpRoute')
    const detail = await reopened.detail(listed.rows[0]!.id)
    expect(detail).toMatchObject({ id: listed.rows[0]!.id, operation: 'legacy.fixture' })
    expect(detail).not.toHaveProperty('httpMethod')
  } finally {
    await reopened.close()
    rmSync(legacyDirectory, { recursive: true, force: true })
  }
}, 15000)
