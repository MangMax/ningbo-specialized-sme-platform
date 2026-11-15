import { afterEach, expect, it, vi } from 'vitest'
import { clientErrorReport } from '../../../lib/client-logging/contract'
import { clientLibraryReport, CLIENT_LIBRARY_SIGNALS } from '../../../lib/client-logging/library-contract'
import { clientLogReport, clientReportKey } from '../../../lib/client-logging/report'
import { createClientErrorTransport } from '../../../lib/client-logging/transport'
const transports: ReturnType<typeof createClientErrorTransport>[] = []
afterEach(() => { for (const item of transports.splice(0)) item.dispose(); vi.unstubAllGlobals() })
function transport(options = {}) { const item = createClientErrorTransport(options); transports.push(item); return item }

it('projects only fixed library signals and rejects arbitrary discriminators, pages and prototype keys', () => {
  const hostile = { get message() { throw Error('must not inspect') } }
  expect(clientLogReport({ kind: 'library_signal', signal: 'tus_upload_success', page: 'files', level: 'fatal', source: 'worker',
    origin: hostile, error: hostile, args: hostile, queryKey: hostile, url: '/PRIVATE180', operation: 'forged', payload: hostile,
  })).toEqual({ kind: 'library_signal', signal: 'tus_upload_success', page: 'files' })
  for (const signal of ['PRIVATE180', '__proto__', 'constructor', 'toString', {}, null, 42])
    expect(clientLibraryReport({ kind: 'library_signal', signal, page: 'files' })).toBeNull()
  for (const page of ['/files?token=PRIVATE180', 'FILES', {}, null])
    expect(clientLibraryReport({ kind: 'library_signal', signal: 'tus_upload_success', page })).toBeNull()
  for (const value of [null, [], {}, 'PRIVATE180']) expect(clientLogReport(value)).toBeNull()
  expect(clientErrorReport({ kind: 'library_signal', signal: 'tus_upload_success', page: 'files', level: 'error' })).toBeNull()
  expect(clientLogReport({ kind: 'interaction_failure', page: 'tasks', level: 'error', interaction: 'task_retry', relatedRequestId: 'response-180' }))
    .toEqual({ kind: 'interaction_failure', page: 'tasks', level: 'error', interaction: 'task_retry', relatedRequestId: 'response-180' })
})

it('keeps lifecycle and legacy dedup separate through the existing evlog HTTP envelope', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetch)
  let now = 1000
  const item = transport({ now: () => now })
  item.reportLibrary('tus_upload_started', 'files'); item.reportLibrary('tus_upload_success', 'files')
  item.reportLibrary('tus_upload_failure', 'files'); item.reportLibrary('tus_upload_failure', 'files')
  item.report('script_error', 'files'); item.report('script_error', 'files')
  item.reportLibrary('PRIVATE180' as any, 'files'); item.reportLibrary('pdf_log_error', '/PRIVATE180' as any)
  await item.flush()
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual([
    { event: { kind: 'library_signal', signal: 'tus_upload_started', page: 'files' } },
    { event: { kind: 'library_signal', signal: 'tus_upload_success', page: 'files' } },
    { event: { kind: 'library_signal', signal: 'tus_upload_failure', page: 'files' } },
    { event: { kind: 'script_error', page: 'files', level: 'error' } },
  ])
  now += 9999; item.reportLibrary('tus_upload_failure', 'files')
  expect(item.status()).toMatchObject({ sent: 4, queued: 0, suppressed: 3, dropped: 2 })
  now++; item.reportLibrary('tus_upload_failure', 'files'); await item.flush()
  expect(item.status()).toMatchObject({ sent: 5, suppressed: 3 })
  expect(clientReportKey({ kind: 'library_signal', signal: 'pdf_log_debug', page: 'files' })).not.toBe(clientReportKey({ kind: 'library_signal', signal: 'pdf_log_error', page: 'files' }))
})

it('shares queue, batch, retry and expiry ceilings between library and existing error reports', async () => {
  let now = 0, online = false
  const fetch = vi.fn().mockRejectedValue(Error('PRIVATE180')); vi.stubGlobal('fetch', fetch)
  const item = transport({ now: () => now, online: () => online })
  for (const page of ['files', 'roster'] as const)
    for (const signal of Object.keys(CLIENT_LIBRARY_SIGNALS)) item.reportLibrary(signal as keyof typeof CLIENT_LIBRARY_SIGNALS, page)
  item.report('vue_error', 'other')
  expect(item.status()).toMatchObject({ queued: 32, dropped: 11 })
  online = true; await item.flush()
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toHaveLength(8)
  expect(item.status()).toMatchObject({ queued: 32, failures: 1 })
  for (let i = 0; i < 11; i++) await item.flush()
  expect(item.status()).toMatchObject({ queued: 0, failures: 12, dropped: 43 })
  expect(fetch).toHaveBeenCalledTimes(12) // 4 batches, at most 3 attempts/event.
  now = 10000; online = false; item.reportLibrary('pdf_log_info', 'logs')
  now += 300000; online = true; await item.flush()
  expect(item.status()).toMatchObject({ queued: 0, dropped: 44, sent: 0 })
  item.dispose(); item.reportLibrary('pdf_log_error', 'files'); await item.flush()
  expect(fetch).toHaveBeenCalledTimes(12)
})
