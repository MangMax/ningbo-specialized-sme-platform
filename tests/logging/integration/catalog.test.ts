import { expect, it } from 'vitest'
import { LOG_INTEGRATIONS, LOG_SUPPORTED_INTEGRATIONS, type LogOrigin } from '../../../layers/core/lib/logging/contract'
import { detailProfile } from '../../../layers/core/lib/logging/detail-profile'
import { safeLogEvent } from '../../../layers/core/lib/logging/privacy'
const added = ['drizzle', 'tus-client', 'embedpdf', 'pinia-colada', 'vue-router'] as const

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
