import { afterEach, expect, it, vi } from 'vitest'
import { Writable } from 'node:stream'
import { boundedLogOutput } from '../lib/logging/output'

afterEach(() => vi.useRealTimers())
it('stops after backpressure across rate windows and resumes only after drain', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1000)
  let complete!: () => void
  const sink = new Writable({ highWaterMark: 1, write(_data, _encoding, cb) { complete = cb } })
  const output = boundedLogOutput(sink, 16)
  expect(output.write('safe\n')).toBe(true)
  for (let i = 0; i < 1000; i++) { vi.setSystemTime(2000 + i * 1000); expect(output.write('safe\n')).toBe(false) }
  expect(sink.writableLength).toBe(5)
  complete()
  sink.emit('drain')
  expect(output.write('next\n')).toBe(true)
  output.close(); complete()
})
it('bounds one line, catches faults and cleans listeners on terminal close', async () => {
  const sink = new Writable({ write(_data, _encoding, cb) { cb() } })
  const before = sink.listenerCount('error')
  const output = boundedLogOutput(sink, 8)
  expect(output.write('x'.repeat(9))).toBe(false)
  expect(sink.writableLength).toBe(0)
  expect(output.write('ok')).toBe(true)
  sink.emit('error', new Error('private'))
  expect(output.write('safe')).toBe(false)
  output.close()
  await new Promise(resolve => setImmediate(resolve))
  expect(sink.listenerCount('drain')).toBe(0)
  expect(sink.listenerCount('error')).toBe(before)
})

it('absorbs a pending write fault after close and releases its remaining fault listeners', async () => {
  let complete!: (error?: Error) => void
  const sink = new Writable({ highWaterMark: 1, write(_data, _encoding, cb) { complete = cb } })
  const output = boundedLogOutput(sink, 16)
  expect(output.write('safe')).toBe(true)
  output.close()
  expect(sink.listenerCount('drain')).toBe(0)
  complete(new Error('EPIPE fixture'))
  await new Promise(resolve => setImmediate(resolve))
  expect(sink.listenerCount('error')).toBe(0)
  expect(sink.listenerCount('close')).toBe(0)
  expect(output.write('safe')).toBe(false)
})
it('isolates synchronous write faults and enforces the per-second ceiling', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1000)
  const sink = new Writable({ write(_data, _encoding, cb) { cb() } })
  const output = boundedLogOutput(sink, 16)
  for (let i = 0; i < 10; i++) expect(output.write('safe')).toBe(true)
  expect(output.write('safe')).toBe(false)
  vi.setSystemTime(2000)
  sink.write = () => { throw new Error('write fixture') }
  expect(() => output.write('safe')).not.toThrow()
  expect(output.write('safe')).toBe(false)
  output.close()
  await new Promise(resolve => setImmediate(resolve))
  expect(sink.listenerCount('error')).toBe(0)
})
