import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applicationLogs, closeApplicationLogging, initializeWorkerLogging } from '../../../layers/core/lib/logging'
import { clientPage } from '../../../layers/core/lib/client-logging/contract'
import { createClientErrorTransport } from '../../../layers/core/lib/client-logging/transport'
import { createClientLogIntake } from '../../../layers/core/server/utils/client-log-intake'

import { defineAppModule } from '../../../layers/core/lib/core/module-registry'
import { appManifests } from '../../../lib/installed-manifests'
import { installAppModules } from '../../../lib/app-modules'

const manifests = [...appManifests, defineAppModule({
  id: 'enterprise-services',
  name: '企业服务',
  clientPages: [{ page: 'service-desk', paths: ['/enterprise-services'] }],
})]

const dirs: string[] = []
const oldDir = process.env.NUXT_LOG_DIR
beforeEach(() => {
  installAppModules(manifests)
  const dir = mkdtempSync(join(tmpdir(), "client189-")); dirs.push(dir); process.env.NUXT_LOG_DIR = dir
  initializeWorkerLogging()
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await closeApplicationLogging()
  if (oldDir === undefined) delete process.env.NUXT_LOG_DIR
  else process.env.NUXT_LOG_DIR = oldDir
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
it.each([
  ['/', 'core', 'roster'],
  ['/roster', 'sme-roster', 'other'],
  ['/enterprises/1', 'sme-roster', 'roster'],
  ['/comparison', 'sme-roster', 'other'],
  ['/platform-declarations', 'sme-roster', 'other'],
  ['/files', 'core', 'files'],
  ['/preview', 'core', 'other'],
  ['/ocr', 'core', 'other'],
  ['/enterprise-services/PRIVATE189', 'enterprise-services', 'service-desk'],
  ['/enterprise-services-other', null, 'other'],
] as const)('attributes browser reports on %s to %s through transport and intake', async (path, module, page) => {
  const intake = createClientLogIntake()
  const requests: string[] = []
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = String(init.body)
    requests.push(body)
    const result = intake.accept(JSON.parse(body), 'browser', { requestId: 'client-intake' })
    return { ok: result.status === 202 }
  })
  const transport = createClientErrorTransport()
  try {
    transport.report('script_error', clientPage(path))
    transport.reportLibrary('router_navigation_error', clientPage(path))
    await transport.flush()
    expect(transport.status().sent).toBe(2)
    expect(requests.join('')).not.toContain('PRIVATE189')
    await applicationLogs().flush()
    const { rows } = await applicationLogs().list({ source: 'client' })
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row).toMatchObject({ source: 'client', module, requestId: 'client-intake' })
    expect(rows.find(row => row.origin?.integration === 'vue-router')).toMatchObject({
      operation: 'client.router.navigation_error', outcome: 'failure', level: 'error',
    })
    expect(rows.find(row => row.origin?.integration === 'browser')).toMatchObject({
      operation: `client.${page}.script_error`, outcome: 'failure', level: 'error',
    })
  } finally {
    transport.dispose()
  }
})
it('stores only classified client claims with server intake correlation through evlog', async () => {
  const intake = createClientLogIntake()
  const result = intake.accept([{ event: { kind: 'script_error', page: clientPage('/platform-declarations'), level: 'error',
    origin: {runtime:'node',integration:'tus',capture:'framework'}, source: 'worker', module: 'core', operation: 'import.commit', id: 'forged-id', timestamp: '2000-01-01',
    requestId: 'claimed-request', taskId: 'claimed-task', fileId: 189, resourceId: 'claimed-resource',
    message: 'PRIVATE189 input /Users/private?token=secret', stack: 'PRIVATE189',
  } }], 'connection-one', { requestId: 'server-request', traceId: 'server-trace' })
  expect(result).toEqual({ status: 202, accepted: 1, duplicates: 0 })
  await applicationLogs().flush()
  const listed = await applicationLogs().list({ source: 'client' })
  expect(listed.rows).toHaveLength(1)
  const detail = await applicationLogs().detail(listed.rows[0]!.id)
  expect(detail).toMatchObject({ source: 'client', module: 'sme-roster', operation: 'client.other.script_error', outcome: 'failure', level: 'error', requestId: 'server-request', traceId: 'server-trace' })
  expect(detail?.id).not.toBe('forged-id')
  expect(detail?.origin).toEqual({runtime:'browser',integration:'browser',capture:'hook',execution:'page'})
  expect(JSON.stringify(detail)).not.toMatch(/PRIVATE189|claimed|forged|2000-01-01|taskId|fileId|resourceId|message|stack/)
})

it('rejects invalid envelopes and levels atomically without logging', async () => {
  const intake = createClientLogIntake()
  for (const input of [null, {}, [], Array(9).fill({ event: { kind: 'script_error', page: 'roster', level: 'error' } }),
    [{ event: { kind: 'raw-input', page: 'roster', level: 'error' } }],
    [{ event: { kind: 'script_error', page: '/files?token=secret', level: 'error' } }],
    [{ event: { kind: 'script_error', page: 'roster', level: 'debug' } }]]) {
    expect(intake.accept(input, 'peer', {})).toEqual({ status: 400, accepted: 0, duplicates: 0 })
  }
  await applicationLogs().flush()
  expect((await applicationLogs().list({ source: 'client' })).rows).toEqual([])
})
it('deduplicates reports and caps connection budgets before resetting the window', () => {
  let now = 1000
  const intake = createClientLogIntake(() => now)
  const body = [{ event: { kind: 'vue_error', page: 'tasks', level: 'error' } }]
  expect(intake.accept(body, 'peer', {}).accepted).toBe(1)
  expect(intake.accept(body, 'peer', {})).toEqual({ status: 202, accepted: 0, duplicates: 1 })
  for (let i = 0; i < 28; i++) expect(intake.accept(body, 'peer', {}).status).toBe(202)
  expect(intake.accept(body, 'peer', {}).status).toBe(429)
  now += 60000
  expect(intake.accept(body, 'peer', {}).accepted).toBe(1)
})
it('caps all peers globally and bounds peer tracking without trusting forwarded addresses', () => {
  const intake = createClientLogIntake()
  const body = [{ event: { kind: 'script_error', page: 'other', level: 'error' } }]
  for (let i = 0; i < 120; i++) expect(intake.accept(body, `connection-${i}`, {}).status).toBe(202)
  expect(intake.accept(body, 'another-connection', {}).status).toBe(429)
})

it('retains only a bounded untrusted related request reference beside trusted intake IDs after restart', async () => {
  const intake = createClientLogIntake()
  intake.accept([{ event: { kind: 'interaction_failure', page: 'tasks', level: 'error', relatedRequestId: 'original-response-180', requestId: 'forged', traceId: 'forged', taskId: 'forged' } }], 'related-peer', { requestId: 'intake-180', traceId: 'intake-trace-180' })
  await applicationLogs().flush()
  const row = (await applicationLogs().list({ source: 'client' })).rows[0]!
  const id = row.id
  await closeApplicationLogging()
  expect(await applicationLogs().detail(id)).toMatchObject({ untrustedRelatedRequestId: 'original-response-180', requestId: 'intake-180', traceId: 'intake-trace-180' })
  expect(JSON.stringify(await applicationLogs().detail(id))).not.toContain('forged')
})
