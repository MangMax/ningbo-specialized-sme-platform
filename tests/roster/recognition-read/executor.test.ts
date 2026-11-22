import { EventEmitter, getEventListeners } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { createEnterpriseReadExecutor } from '../../../layers/sme-roster/server/utils/enterprise-read'
import { enterpriseJsonChunks } from '../../../layers/sme-roster/lib/roster/enterprise-read-json'
import type { EnterpriseReadRequest } from '../../../layers/sme-roster/lib/roster/enterprise-read-worker'

class Transport extends EventEmitter {
  sent: EnterpriseReadRequest[] = []
  postMessage(input: EnterpriseReadRequest) { this.sent.push(input) }
  ref() {}
  unref() {}
  terminate = vi.fn(async () => {})
  ready() { this.emit('message', { type: 'ready', heap: 1 }) }
  chunk(payload: unknown, id = this.sent.at(-1)!.id) { this.emit('message', { type: 'chunk', id, payload }) }
  end(bytes = 2, id = this.sent.at(-1)!.id) {
    this.emit('message', { type: 'result', id, metrics: { bytes, heap: 1, rss: 1 } })
  }
}

const filter = { titleCode: 'little_giant' as const }
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function setup(workers: Transport[] = [new Transport()], maxPending?: number) {
  const available = [...workers]
  const executor = createEnterpriseReadExecutor({
    createWorker() {
      const worker = available.shift()
      if (!worker) throw new Error('Synthetic worker unavailable')
      return worker
    },
    maxPending,
  })
  cleanup.push(() => executor.close())
  return { worker: workers[0]!, executor }
}

it('aborts queued reads, frees admission and preserves the order of remaining callers', async () => {
  const { worker, executor } = setup(undefined, 2)
  const cancelled = new AbortController()
  const first = executor.currentQualifiedJson(filter)
  worker.ready()
  const abandoned = executor.currentQualifiedJson({ ...filter, page: 2 }, cancelled.signal)
  const rejection = expect(abandoned).rejects.toMatchObject({ name: 'AbortError', statusCode: 499 })
  const next = executor.currentQualifiedJson({ ...filter, page: 3 })
  await expect(executor.currentQualifiedJson(filter)).rejects.toMatchObject({ code: 'enterprise_read_busy', statusCode: 503 })
  cancelled.abort()
  await rejection
  expect(getEventListeners(cancelled.signal, 'abort')).toHaveLength(0)
  const last = executor.currentQualifiedJson({ ...filter, page: 4 })
  for (const result of [first, next, last]) {
    worker.chunk(Buffer.from('{}'))
    worker.end()
    await expect(result).resolves.toEqual({ body: Buffer.from('{}') })
  }
  expect(worker.sent.map(request => request.filter.page)).toEqual([undefined, 3, 4])
  expect(worker.terminate).not.toHaveBeenCalled()
})

it('discards partial bytes when an active read is aborted and completes the queued read on a replacement worker', async () => {
  const replacement = new Transport()
  const { worker, executor } = setup([new Transport(), replacement])
  const cancelled = new AbortController()
  const active = executor.currentQualifiedJson(filter, cancelled.signal)
  const rejection = expect(active).rejects.toMatchObject({ name: 'AbortError', statusCode: 499 })
  worker.ready()
  worker.chunk(Buffer.from('incomplete'))
  const next = executor.currentQualifiedJson({ ...filter, page: 2 })
  cancelled.abort()
  await rejection
  await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledTimes(1))
  replacement.ready()
  worker.end(10)
  replacement.chunk(Buffer.from('{}'))
  replacement.end()
  await expect(next).resolves.toEqual({ body: Buffer.from('{}') })
  expect(getEventListeners(cancelled.signal, 'abort')).toHaveLength(0)
})

it('counts active job metadata toward the exact 64 KiB cap', async () => {
  const { worker, executor } = setup()
  const max = 65536 - Buffer.byteLength(JSON.stringify({ ...filter, q: '' }))
  const admitted = executor.currentQualifiedJson({ ...filter, q: 'x'.repeat(max) })
  worker.ready()
  await expect(executor.currentQualifiedJson(filter)).rejects.toMatchObject({ code: 'enterprise_read_busy', statusCode: 503 })
  worker.chunk(Buffer.from('{}'))
  worker.end()
  await admitted
  await expect(executor.currentQualifiedJson({ ...filter, q: 'x'.repeat(max + 1) }))
    .rejects.toMatchObject({ code: 'enterprise_read_busy', statusCode: 503 })
})

it.each([
  ['failure', 'read_failed'],
  ['exit', 'worker_exited'],
  ['error', 'worker_failed'],
  ['decode', 'worker_decode_failed'],
  ['truncated', 'worker_decode_failed'],
  ['send', 'worker_send_failed'],
])('reports a %s fault without returning incomplete results', async (fault, code) => {
  const { worker, executor } = setup()
  const ready = executor.start()
  worker.ready()
  await ready
  if (fault === 'send') worker.postMessage = () => { throw new Error('Synthetic send failure') }
  const result = executor.currentQualifiedJson(filter)
  const rejection = expect(result).rejects.toMatchObject({ code, statusCode: 503 })
  if (fault !== 'send') {
    worker.chunk(Buffer.from('partial'))
    if (fault === 'failure') worker.emit('message', { type: 'failure', id: worker.sent[0]!.id, code })
    else if (fault === 'decode') worker.chunk('invalid')
    else if (fault === 'truncated') worker.end(65536)
    else worker.emit(fault, new Error('Synthetic process fault'))
  }
  await rejection
})

it('rejects pending and future reads after close and releases cancellation listeners', async () => {
  const { worker, executor } = setup()
  const cancelled = new AbortController()
  const active = executor.currentQualifiedJson(filter, cancelled.signal)
  worker.ready()
  const queued = executor.currentQualifiedJson(filter, cancelled.signal)
  const rejections = [active, queued].map(result => expect(result).rejects.toMatchObject({ code: 'executor_closed', statusCode: 503 }))
  await executor.close()
  await Promise.all(rejections)
  expect(getEventListeners(cancelled.signal, 'abort')).toHaveLength(0)
  await expect(executor.currentQualifiedJson(filter)).rejects.toMatchObject({ code: 'executor_closed', statusCode: 503 })
})

it('preserves raw strings including escapes, lone surrogates and pairs spanning byte and character boundaries', async () => {
  const { worker, executor } = setup()
  const value = { text: 'a'.repeat(16382) + '😀\uD800\n\\\"\uDC00' + '合成😀'.repeat(20000) }
  const result = executor.currentQualifiedJson(filter)
  worker.ready()
  const chunks = [...enterpriseJsonChunks(value)]
  expect(chunks.length).toBeGreaterThan(1)
  for (const chunk of chunks) {
    expect(chunk.byteLength).toBeLessThanOrEqual(65536)
    worker.chunk(chunk)
  }
  worker.end(Buffer.byteLength(JSON.stringify(value)))
  expect((await result).body).toEqual(Buffer.from(JSON.stringify(value)))
})
