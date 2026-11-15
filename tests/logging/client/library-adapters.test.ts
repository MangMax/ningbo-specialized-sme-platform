import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Upload } from 'tus-js-client'
import { createApp } from 'vue'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { PiniaColada, useQueryCache, useMutationCache, useMutation } from '@pinia/colada'
import { createMemoryHistory, createRouter, isNavigationFailure, NavigationFailureType } from 'vue-router'
import { PluginRegistry } from '@embedpdf/core'
import { serializeLogger, type PdfEngine } from '@embedpdf/models'
import { withTusLogging } from '../../../lib/client-logging/tus'
import { installColadaLogging } from '../../../lib/client-logging/colada'
import { installRouterLogging } from '../../../lib/client-logging/router'
import { createEmbedPdfLogger } from '../../../lib/client-logging/embedpdf'
import type { ClientLibrarySignal } from '../../../lib/client-logging/library-contract'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function coladaFixture(report: (signal: ClientLibrarySignal) => void = vi.fn(), page: () => 'roster' | 'logs' | 'settings' = () => 'roster') {
  const app = createApp({}), pinia = createPinia()
  app.use(pinia); app.use(PiniaColada); setActivePinia(pinia)
  const queries = useQueryCache(pinia), mutations = useMutationCache(pinia)
  const dispose = installColadaLogging(queries, mutations, report, page)
  cleanups.push(() => { dispose(); disposePinia(pinia) })
  return { app, queries, mutations, report, dispose }
}

it('observes real tus lifecycle once across chunks and preserves terminal response callbacks', async () => {
  let offset = 0, patches = 0
  const server = createServer((req, res) => {
    res.setHeader('Tus-Resumable', '1.0.0')
    if (req.method === 'POST') { res.writeHead(201, { Location: '/upload/PRIVATE180' }); res.end(); return }
    if (req.method === 'PATCH') {
      patches++; req.on('data', chunk => { offset += chunk.length })
      req.on('end', () => { res.writeHead(204, { 'Upload-Offset': String(offset) }); res.end() }); return
    }
    res.writeHead(404); res.end()
  }).listen(0, '127.0.0.1')
  await once(server, 'listening'); cleanups.push(() => new Promise<void>(r => server.close(() => r())))
  const address = server.address() as { port: number }
  const signals: string[] = [], done = deferred<void>(), success = vi.fn(() => done.resolve())
  const before = vi.fn(), progress = vi.fn()
  const options = withTusLogging({ endpoint: `http://127.0.0.1:${address.port}/upload`, chunkSize: 2,
    retryDelays: null, onBeforeRequest: before, onProgress: progress,
    onSuccess: success, onError: done.reject,
  }, signal => signals.push(signal))
  const upload = new Upload(Buffer.from('PRIVATE180'), options)
  upload.start(); await done.promise
  expect(signals).toEqual(['tus_upload_started', 'tus_upload_ready', 'tus_upload_success'])
  expect(patches).toBe(5); expect(before).toHaveBeenCalledTimes(6)
  expect(success.mock.calls[0]).toEqual([{ lastResponse: expect.objectContaining({}) }])
  expect(progress).toHaveBeenCalled()
  expect(upload.url).toContain('/upload/PRIVATE180')
  expect(JSON.stringify(signals)).not.toContain('PRIVATE180')
})

it('keeps native tus retries and reports only the terminal failure even when telemetry throws', async () => {
  let attempts = 0
  const server = createServer((_req, res) => { attempts++; res.writeHead(503); res.end('PRIVATE180') }).listen(0, '127.0.0.1')
  await once(server, 'listening'); cleanups.push(() => new Promise<void>(r => server.close(() => r())))
  const done = deferred<Error>(), signals: string[] = []
  const upload = new Upload(Buffer.from('private'), withTusLogging({ endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/upload`,
    retryDelays: [0], onError: done.resolve,
  }, signal => { signals.push(signal); throw Error('diagnostic sink failed') }))
  upload.start(); const error = await done.promise
  expect(attempts).toBe(2)
  expect(signals).toEqual(['tus_upload_started', 'tus_upload_failure'])
  expect(error).toBeInstanceOf(Error)
  expect(error.message).toContain('503')
})

it('preserves tus callback arguments, rejection and default throw while ignoring an intentional abort', async () => {
  const error = Error('PRIVATE180'), report = vi.fn(), context = {}
  const rejected = Promise.reject(error); rejected.catch(() => {})
  const original = vi.fn(function (this: unknown, arg: unknown) { expect(this).toBe(context); expect(arg).toBe(error); return rejected })
  const options = withTusLogging({ onBeforeRequest: original as any, onError: original as any }, report, () => false)
  expect(options.onBeforeRequest!.call(context, error as any)).toBe(rejected)
  expect(options.onError!.call(context, error)).toBe(rejected)
  expect(report.mock.calls.flat()).toEqual(['tus_upload_started'])
  expect(() => withTusLogging({}, report).onError!(error)).toThrow(error)
  await expect(rejected).rejects.toBe(error)
})

it('reports real Colada query and mutation settlements without inspecting keys, values or errors', async () => {
  const report = vi.fn(), { app, queries } = coladaFixture(report)
  const pending = deferred<string>()
  const entry = queries.ensure({ key: ['PRIVATE180'], query: () => pending.promise, gcTime: false })
  const fetching = queries.fetch(entry)
  expect(report).not.toHaveBeenCalled()
  pending.resolve('PRIVATE180'); expect((await fetching).data).toBe('PRIVATE180')
  const error = { message: 'PRIVATE180', get stack() { throw Error('must never inspect') } }
  await expect(queries.fetch(entry, { ...entry.options!, query: () => Promise.reject(error) })).rejects.toBe(error)
  const mutation = app.runWithContext(() => useMutation({ mutation: async (fail: boolean) => { if (fail) throw error; return 'PRIVATE180' }, gcTime: false }))
  expect(await mutation.mutateAsync(false)).toBe('PRIVATE180')
  await expect(mutation.mutateAsync(true)).rejects.toBe(error)
  expect(report.mock.calls).toEqual([['colada_query_success'], ['colada_query_failure'], ['colada_mutation_success'], ['colada_mutation_failure']])
})

it('does not invent Colada success for cancelled or superseded queries or report after disposal', async () => {
  const report = vi.fn(), { queries, dispose } = coladaFixture(report)
  const first = deferred<string>(), next = deferred<string>()
  const entry = queries.ensure({ key: ['PRIVATE180'], query: () => first.promise, gcTime: false })
  const stale = queries.fetch(entry)
  const current = queries.fetch(entry, { ...entry.options!, query: () => next.promise })
  next.resolve('current'); await current
  first.resolve('stale'); await stale
  expect(report.mock.calls).toEqual([['colada_query_success']])
  report.mockClear()
  const cancelled = deferred<string>()
  const inflight = queries.fetch(entry, { ...entry.options!, query: () => cancelled.promise })
  queries.cancel(entry); cancelled.resolve('cancelled'); await inflight
  expect(report).not.toHaveBeenCalled()
  const late = deferred<string>(), finishing = queries.fetch(entry, { ...entry.options!, query: () => late.promise })
  dispose(); late.resolve('late'); await finishing
  await queries.fetch(entry, { ...entry.options!, query: async () => 'new' })
  expect(report).not.toHaveBeenCalled()
})

it.each(['logs', 'settings'] as const)('excludes Colada work on %s and keeps results and failures when diagnostics break', async page => {
  const report = vi.fn(), hidden = coladaFixture(report, () => page)
  const entry = hidden.queries.ensure({ key: ['PRIVATE180'], query: async () => 42, gcTime: false })
  expect((await hidden.queries.fetch(entry)).data).toBe(42)
  const mutation = hidden.app.runWithContext(() => useMutation({ mutation: async () => 43, gcTime: false }))
  expect(await mutation.mutateAsync()).toBe(43); expect(report).not.toHaveBeenCalled()
  const broken = coladaFixture(() => { throw Error('sink failure') })
  const good = broken.queries.ensure({ key: ['safe'], query: async () => 44, gcTime: false })
  expect((await broken.queries.fetch(good)).data).toBe(44)
  const error = Error('PRIVATE180')
  await expect(broken.queries.fetch(good, { ...good.options!, query: async () => { throw error } })).rejects.toBe(error)
  const brokenPage = coladaFixture(report, () => { throw error })
  const ignored = brokenPage.queries.ensure({ key: ['safe'], query: async () => 45, gcTime: false })
  expect((await brokenPage.queries.fetch(ignored)).data).toBe(45)
  expect(report).not.toHaveBeenCalled()
})

function routerFixture(report = vi.fn()) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: {} }] })
  const dispose = installRouterLogging(router, report)
  cleanups.push(dispose)
  return { router, report, dispose }
}
it('observes native router success, duplicate, abort, cancellation and error without routes or errors', async () => {
  const { router, report } = routerFixture()
  await router.push('/PRIVATE180?token=PRIVATE180')
  expect(isNavigationFailure(await router.push('/PRIVATE180?token=PRIVATE180'), NavigationFailureType.duplicated)).toBe(true)
  const stop = router.beforeEach(() => false)
  expect(isNavigationFailure(await router.push('/blocked'), NavigationFailureType.aborted)).toBe(true); stop()
  const gate = deferred<void>()
  const remove = router.beforeEach(to => to.path === '/slow' ? gate.promise : undefined)
  const slow = router.push('/slow'); await Promise.resolve(); await Promise.resolve()
  await router.push('/fast'); gate.resolve();
  expect(isNavigationFailure(await slow, NavigationFailureType.cancelled)).toBe(true); remove()
  const error = Error('PRIVATE180')
  router.beforeEach(() => { throw error })
  await expect(router.push('/broken')).rejects.toBe(error)
  expect(report.mock.calls).toEqual([['router_navigation_success'], ['router_navigation_duplicated'], ['router_navigation_aborted'],
    ['router_navigation_success'], ['router_navigation_cancelled'], ['router_navigation_error']])
})

it('unregisters router hooks and preserves navigation results when reporting fails', async () => {
  const { router, dispose } = routerFixture(vi.fn(() => { throw Error('sink failed') }))
  expect(await router.push('/ok')).toBeUndefined()
  const report = vi.fn(), stop = installRouterLogging(router, report)
  stop(); dispose(); await router.push('/PRIVATE180')
  const error = Error('PRIVATE180'); const silence = router.onError(() => {})
  router.beforeEach(() => { throw error })
  await expect(router.push('/broken')).rejects.toBe(error); silence()
  expect(report).not.toHaveBeenCalled()
})

it('supplies the native EmbedPDF registry Logger API with safe levels and no worker console fallback', async () => {
  const report = vi.fn(), logger = createEmbedPdfLogger(report)
  const registry = new PluginRegistry({} as PdfEngine, { logger })
  expect(registry.getLogger()).toBe(logger)
  const hostile = { get message() { throw Error('must never inspect') }, toString() { throw Error('must never coerce') } }
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    expect(logger.isEnabled(level)).toBe(true)
    registry.getLogger()[level]('PRIVATE180', '/PRIVATE180?token=secret', hostile)
  }
  logger.perf('PRIVATE180', 'PRIVATE180', 'PRIVATE180', 'Begin', hostile)
  expect(report.mock.calls).toEqual([['pdf_log_debug'], ['pdf_log_info'], ['pdf_log_warn'], ['pdf_log_error']])
  expect(serializeLogger(logger)).toEqual({ type: 'noop' })
  const broken = createEmbedPdfLogger(() => { throw Error('sink failed') })
  expect(() => broken.error('PRIVATE180', 'PRIVATE180', hostile)).not.toThrow()
  await registry.destroy()
})
