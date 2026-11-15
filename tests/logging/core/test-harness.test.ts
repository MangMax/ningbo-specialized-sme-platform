import { createLogger, initLogger, isEnabled, type WideEvent } from 'evlog'
import { afterEach, expect, it, vi } from 'vitest'
import { appLog } from '../../../lib/logging'

afterEach(() => vi.restoreAllMocks())

it('keeps default unit diagnostics enabled and builds context without terminal output', () => {
  const terminal = vi.spyOn(console, 'log').mockImplementation(() => {})
  expect(isEnabled()).toBe(true)
  const logger = createLogger({ testHarness: 'built' })
  expect(logger.getContext()).toMatchObject({ testHarness: 'built' })
  expect(logger.emit({ _forceKeep: true })).toMatchObject({ testHarness: 'built' })
  expect(terminal).not.toHaveBeenCalled()
  // Ordinary console diagnostics still work; only evlog's unowned unit sink is quiet.
  console.log('unit console remains observable')
  expect(terminal).toHaveBeenCalledOnce()
})

it('allows a logging test to install its own real evlog drain and retain application metadata', () => {
  const events: WideEvent[] = []
  initLogger({ enabled: true, silent: true, drain: ctx => { events.push(ctx.event) } })
  appLog({ source: 'system', operation: 'test.harness', outcome: 'success', level: 'debug', counts: { total: 1 } }, { requestId: 'harness-request' })
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ applicationLog: {
    source: 'system', operation: 'test.harness', outcome: 'success', level: 'debug',
    requestId: 'harness-request', counts: { total: 1 },
  } })
})
