import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from 'vue'
import { createPinia, disposePinia } from 'pinia'
import { PiniaColada, useQueryCache, useMutationCache } from '@pinia/colada'
// Uses the actual integrated catalog, without a test-only extension.
import { applicationLogs, closeApplicationLogging, initializeWorkerLogging, LOG_DEFAULTS } from '../lib/logging'
import { createClientLogIntake } from '../server/utils/client-log-intake'
import { createClientErrorTransport } from '../lib/client-logging/transport'
import { installColadaLogging } from '../lib/client-logging/colada'

const dirs: string[] = [], previous = process.env.NUXT_LOG_DIR
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'client-library180-')); dirs.push(dir); process.env.NUXT_LOG_DIR = dir
  initializeWorkerLogging()
})
afterEach(async () => {
  await closeApplicationLogging(); vi.unstubAllGlobals()
  if (previous === undefined) delete process.env.NUXT_LOG_DIR
  else process.env.NUXT_LOG_DIR = previous
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const envelope = (signal: string, extra = {}) => ({ event: { kind: 'library_signal', signal, page: 'files', ...extra } })
const expected = [
  ['tus_upload_started', 'tus-client', 'client.tus.upload_started', 'started', 'debug'],
  ['tus_upload_ready', 'tus-client', 'client.tus.upload_ready', 'started', 'info'],
  ['tus_upload_success', 'tus-client', 'client.tus.upload_success', 'success', 'info'],
  ['tus_upload_failure', 'tus-client', 'client.tus.upload_failure', 'failure', 'error'],
  ['pdf_log_debug', 'embedpdf', 'client.embedpdf.log_debug', 'unknown', 'debug'],
  ['pdf_log_info', 'embedpdf', 'client.embedpdf.log_info', 'unknown', 'info'],
  ['pdf_log_warn', 'embedpdf', 'client.embedpdf.log_warn', 'unknown', 'warn'],
  ['pdf_log_error', 'embedpdf', 'client.embedpdf.log_error', 'unknown', 'error'],
  ['pdf_startup_failure', 'embedpdf', 'client.embedpdf.startup_failure', 'failure', 'error'],
  ['pdf_document_ready', 'embedpdf', 'client.embedpdf.document_ready', 'success', 'info'],
  ['pdf_document_failure', 'embedpdf', 'client.embedpdf.document_failure', 'failure', 'error'],
  ['colada_query_success', 'pinia-colada', 'client.colada.query_success', 'success', 'info'],
  ['colada_query_failure', 'pinia-colada', 'client.colada.query_failure', 'failure', 'error'],
  ['colada_mutation_success', 'pinia-colada', 'client.colada.mutation_success', 'success', 'info'],
  ['colada_mutation_failure', 'pinia-colada', 'client.colada.mutation_failure', 'failure', 'error'],
  ['router_navigation_success', 'vue-router', 'client.router.navigation_success', 'success', 'info'],
  ['router_navigation_aborted', 'vue-router', 'client.router.navigation_aborted', 'cancelled', 'warn'],
  ['router_navigation_cancelled', 'vue-router', 'client.router.navigation_cancelled', 'cancelled', 'debug'],
  ['router_navigation_duplicated', 'vue-router', 'client.router.navigation_duplicated', 'skipped', 'debug'],
  ['router_navigation_failure', 'vue-router', 'client.router.navigation_failure', 'failure', 'warn'],
  ['router_navigation_error', 'vue-router', 'client.router.navigation_error', 'failure', 'error'],
] as const

it('persists every fixed server mapping and discards adversarial library claims through evlog and restart', async () => {
  const intake = createClientLogIntake()
  const malicious = { level: 'fatal', source: 'worker', operation: 'forged', outcome: 'success',
    origin: { runtime: 'node', integration: 'drizzle', capture: 'framework', execution: 'worker', extra: 'PRIVATE180' },
    id: 'forged', requestId: 'forged', traceId: 'forged', relatedRequestId: 'forged', taskId: 'forged', fileId: 180,
    message: 'PRIVATE180', stack: 'PRIVATE180', queryKey: 'PRIVATE180', url: '/PRIVATE180', filename: 'PRIVATE180', args: ['PRIVATE180'],
  }
  for (let i = 0; i < expected.length; i += 8) {
    const batch = expected.slice(i, i + 8).map(([signal]) => envelope(signal, malicious))
    expect(intake.accept(batch, 'native-peer', { requestId: 'intake180', traceId: 'intake-trace180', taskId: 'must-not-inherit' }))
      .toEqual({ status: 202, accepted: batch.length, duplicates: 0 })
  }
  expect(intake.accept([envelope('tus_upload_success'), envelope('tus_upload_failure')], 'native-peer', {}))
    .toEqual({ status: 202, accepted: 0, duplicates: 2 })
  await applicationLogs().flush()
  const rows = (await applicationLogs().list({ source: 'client', limit: 100 })).rows
  expect(rows).toHaveLength(21)
  await closeApplicationLogging()
  for (const [, integration, operation, outcome, level] of expected) {
    const row = rows.find(row => row.operation === operation)!
    const detail = await applicationLogs().detail(row.id)
    expect(detail).toMatchObject({ source: 'client', operation, outcome, level, requestId: 'intake180', traceId: 'intake-trace180',
      origin: { runtime: 'browser', integration, capture: 'hook', execution: 'page' } })
    expect(JSON.stringify(detail)).not.toMatch(/PRIVATE180|forged|must-not-inherit|queryKey|filename|message|stack|args|relatedRequestId/)
    expect(detail).not.toHaveProperty('taskId'); expect(detail).not.toHaveProperty('fileId')
  }
})

it('rejects mixed invalid library batches atomically and shares legacy dedup and rate ceilings', async () => {
  const intake = createClientLogIntake()
  for (const bad of [envelope('constructor'), envelope('pdf_log_error', { page: '/PRIVATE180' }), { event: { kind: 'library_signal', signal: 'PRIVATE180', page: 'files' } }])
    expect(intake.accept([envelope('pdf_log_error'), bad], 'malicious', {}).status).toBe(400)
  await applicationLogs().flush()
  expect((await applicationLogs().list({ source: 'client' })).rows).toEqual([])
  const mixed = [envelope('tus_upload_success'), envelope('tus_upload_failure'), { event: { kind: 'script_error', page: 'files', level: 'error' } }]
  expect(intake.accept(mixed, 'mixed', {})).toEqual({ status: 202, accepted: 3, duplicates: 0 })
  expect(intake.accept(mixed, 'mixed', {})).toEqual({ status: 202, accepted: 0, duplicates: 3 })
  for (let i = 0; i < 28; i++) expect(intake.accept(mixed, 'mixed', {}).status).toBe(202)
  expect(intake.accept(mixed, 'mixed', {}).status).toBe(429)
  const global = createClientLogIntake()
  for (let i = 0; i < 120; i++) expect(global.accept([envelope('pdf_log_debug')], `peer-${i}`, {}).status).toBe(202)
  expect(global.accept(mixed, 'overflow', {}).status).toBe(429)
})

it('filters persisted client library events by both source and integration with the stricter level', async () => {
  const service = applicationLogs(), intake = createClientLogIntake()
  const base = { retentionDays: 7, maxBytes: LOG_DEFAULTS.maxBytes }
  const pairs = [
    ['tus-client', 'tus_upload_success', 'tus_upload_failure', 'client.tus.upload_failure'],
    ['embedpdf', 'pdf_document_ready', 'pdf_document_failure', 'client.embedpdf.document_failure'],
    ['pinia-colada', 'colada_query_success', 'colada_query_failure', 'client.colada.query_failure'],
    ['vue-router', 'router_navigation_success', 'router_navigation_error', 'client.router.navigation_error'],
  ] as const
  let peer = 0
  for (const [integration, success, failure, failureOperation] of pairs) {
    const submit = () => intake.accept([envelope(success), envelope(failure)], `policy-${peer++}`, {})
    const before = (await service.list({ source: 'client', limit: 100 })).rows.length
    await service.setPolicy({ ...base, collection: { sources: { client: { enabled: false, minLevel: 'debug' } }, integrations: { [integration]: { enabled: true, minLevel: 'debug' } } } })
    expect(submit().accepted).toBe(2); await service.flush()
    expect((await service.list({ source: 'client', limit: 100 })).rows).toHaveLength(before)
    await service.setPolicy({ ...base, collection: { sources: { client: { enabled: true, minLevel: 'debug' } }, integrations: { [integration]: { enabled: false, minLevel: 'debug' } } } })
    submit(); await service.flush(); expect((await service.list({ source: 'client', limit: 100 })).rows).toHaveLength(before)
    for (const [sourceLevel, integrationLevel] of [['error', 'debug'], ['debug', 'error']] as const) {
      await service.setPolicy({ ...base, collection: { sources: { client: { enabled: true, minLevel: sourceLevel } }, integrations: { [integration]: { enabled: true, minLevel: integrationLevel } } } })
      submit(); await service.flush()
    }
    const added = (await service.list({ source: 'client', limit: 100 })).rows.filter(row => row.origin?.integration === integration as string)
    expect(added).toHaveLength(2)
    expect(added.every(row => row.level === 'error' && row.operation === failureOperation)).toBe(true)
    expect((await service.list({ source: 'client', limit: 100 })).rows).toHaveLength(before + 2)
  }
})

it('carries real native Colada settlements through bounded HTTP transport and persisted intake', async () => {
  const intake = createClientLogIntake()
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const result = intake.accept(JSON.parse(init.body), 'transport-peer', { requestId: 'server-transport180' })
    return { ok: result.status === 202 }
  }))
  const transport = createClientErrorTransport()
  const app = createApp({}), pinia = createPinia()
  app.use(pinia); app.use(PiniaColada)
  const queries = useQueryCache(pinia)
  const dispose = installColadaLogging(queries, useMutationCache(pinia), signal => transport.reportLibrary(signal, 'roster'), () => 'roster')
  try {
    const entry = queries.ensure({ key: ['PRIVATE180'], query: async () => 'PRIVATE180', gcTime: false })
    await queries.fetch(entry)
    const error = Error('PRIVATE180')
    await expect(queries.fetch(entry, { ...entry.options!, query: async () => { throw error } })).rejects.toBe(error)
    await transport.flush(); await applicationLogs().flush()
    expect(transport.status()).toMatchObject({ sent: 2, queued: 0, failures: 0 })
    const rows = (await applicationLogs().list({ source: 'client' })).rows
    expect(rows.map(row => [row.operation, row.outcome]).sort()).toEqual([['client.colada.query_failure', 'failure'], ['client.colada.query_success', 'success']])
    expect(rows.every(row => row.origin?.integration === 'pinia-colada' as string && row.requestId === 'server-transport180')).toBe(true)
  } finally { dispose(); disposePinia(pinia); transport.dispose() }
})
