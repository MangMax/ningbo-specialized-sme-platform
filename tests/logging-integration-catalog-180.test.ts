import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { LOG_DEFAULTS, LOG_INTEGRATIONS, LOG_SUPPORTED_INTEGRATIONS, type LogOrigin } from '../lib/logging/contract'
import { createLogService, type LogService } from '../lib/logging/service'
import { safeLogEvent } from '../lib/logging/privacy'
import { detailProfile } from '../lib/logging/detail-profile'

const added = ['drizzle', 'tus-client', 'embedpdf', 'pinia-colada', 'vue-router'] as const
const services: LogService[] = [], directories: string[] = []
const base = { retentionDays: 7, maxBytes: LOG_DEFAULTS.maxBytes }
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
it('exposes all five real collectors as configurable and projects only their safe attribution', () => {
  expect(LOG_SUPPORTED_INTEGRATIONS).toHaveLength(11)
  for (const integration of added) {
    expect(LOG_INTEGRATIONS.find(item => item.key === integration)).toMatchObject({ state: 'supported', configurable: true })
    const origin = { runtime: integration === 'drizzle' ? 'node' : 'browser', integration, capture: 'hook', secret: 'PRIVATE_NONCE' }
    const event = safeLogEvent({ source: integration === 'drizzle' ? 'system' : 'client', operation: 'fixture.native', outcome: 'started', origin: origin as LogOrigin })
    expect(event.origin).toEqual({ runtime: origin.runtime, integration, capture: 'hook' })
    expect(JSON.stringify(event)).not.toContain('PRIVATE_NONCE')
  }
  expect(LOG_INTEGRATIONS.filter(item => item.category === 'technical' && (item.runtimes as readonly string[]).includes('node')).map(item => item.key)).toEqual(['nuxt-nitro', 'mcp-toolkit', 'tus', 'drizzle'])
  expect(LOG_INTEGRATIONS.filter(item => item.category === 'technical' && (item.runtimes as readonly string[]).includes('browser')).map(item => item.key)).toEqual(['browser', 'vue', 'tus-client', 'embedpdf', 'pinia-colada', 'vue-router'])
  expect(LOG_INTEGRATIONS.filter(item => item.category === 'business')).toEqual([expect.objectContaining({ key: 'application', runtimes: ['node', 'browser'] })])
})
it('explains native query attempts and library severity without claiming execution results', () => {
  const query = safeLogEvent({ source: 'system', operation: 'db.query.select', outcome: 'started', level: 'debug', origin: { runtime: 'node', integration: 'drizzle', capture: 'hook' } })
  expect(detailProfile(query).find(section => section.showTarget)?.note).toContain('不代表执行成功或失败')
  const library = safeLogEvent({ source: 'client', operation: 'client.embedpdf.log_error', outcome: 'unknown', level: 'error', origin: { runtime: 'browser', integration: 'embedpdf', capture: 'hook', execution: 'page' } })
  const profile = detailProfile(library)
  expect(profile.find(section => section.showTarget)?.note).toContain('不据此判断文档')
  expect(library.outcome).toBe('unknown')
})
it('upgrades a saved six-integration policy without resetting choices history or revision', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'collector-upgrade-')); directories.push(directory)
  const first = createLogService({ directory }); services.push(first)
  const oldId = first.emit({ source: 'task', operation: 'history.native', outcome: 'success' })!
  await first.flush()
  await first.setPolicy({ ...base, collection: { integrations: { application: { enabled: false, minLevel: 'error' } }, sources: { client: { enabled: false, minLevel: 'warn' } } } })
  const before = await first.policy()
  await first.close()
  // This is the isolated diagnostic store, never a business database.
  const db = new Database(join(directory, 'events.db'))
  const collection = JSON.parse(JSON.stringify(before.collection))
  for (const key of added) delete collection.integrations[key]
  db.prepare('UPDATE log_collection SET collection=? WHERE id=1').run(JSON.stringify(collection)); db.close()
  const next = createLogService({ directory }); services.push(next)
  const policy = await next.policy()
  expect(policy.revision).toBe(before.revision)
  expect(policy.collection.sources.client).toEqual({ enabled: false, minLevel: 'warn' })
  expect(policy.collection.integrations.application).toEqual({ enabled: false, minLevel: 'error' })
  for (const key of added) expect((policy.collection.integrations as Record<string, unknown>)[key]).toEqual({ enabled: true, minLevel: 'debug' })
  expect(await next.detail(oldId)).toMatchObject({ operation: 'history.native' })
  await next.setPolicy({ ...base, retentionDays: 6 })
  const updated = await next.policy()
  expect(updated.collection).toEqual(policy.collection)
  expect(updated.revision).toBe(before.revision + 1)
  await next.close()
  const reopened = createLogService({ directory }); services.push(reopened)
  expect((await reopened.policy()).collection).toEqual(policy.collection)
})
it('fails closed on malformed stored rules instead of treating corruption as an upgrade', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'collector-corrupt-')); directories.push(directory)
  const service = createLogService({ directory }); services.push(service)
  const before = await service.policy()
  const db = new Database(join(directory, 'events.db'))
  const original = (db.prepare('SELECT collection FROM log_collection WHERE id=1').get() as { collection: string }).collection
  for (const corrupt of [
    { sources: JSON.parse(JSON.stringify(before.collection.sources)), integrations: null },
    { sources: JSON.parse(JSON.stringify(before.collection.sources)), integrations: { application: { enabled: 'yes', minLevel: 'debug' } } },
    { sources: {}, integrations: JSON.parse(JSON.stringify(before.collection.integrations)) },
  ]) {
    db.prepare('UPDATE log_collection SET collection=? WHERE id=1').run(JSON.stringify(corrupt))
    expect(service.emit({ source: 'system', operation: 'corrupt.native', outcome: 'started' })).toBeTypeOf('string')
    await expect(service.flush()).resolves.toBeUndefined()
    expect(service.status().unavailable).toBe(true)
    await expect(service.policy()).rejects.toThrow('storage_unavailable')
  }
  db.prepare('UPDATE log_collection SET collection=? WHERE id=1').run(original)
  expect((await service.list({ operation: 'corrupt.native' })).rows).toEqual([])
  expect(service.status().dropped).toBe(3)
  db.close()
})
