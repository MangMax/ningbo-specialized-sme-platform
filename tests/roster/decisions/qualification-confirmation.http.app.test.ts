import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { nativeAppAdapter } from '../../support/native-app'
import { readDevelopmentDiscovery } from '../current-export/fixtures/specialized-export'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { schema as s } from '../../../db/client'
const dir = mkdtempSync(join(tmpdir(), 'qualification-confirmation-'))
const token = 'synthetic-qualification'
const app = nativeAppAdapter({ dir, token, launch: ({ cwd, port }) => ({ args: [join(cwd, '.output/server/index.mjs')], env: { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), NUXT_MCP_TOKEN: token } }) })
const client = new Client({ name: 'synthetic-qualification', version: '1' })
let tools: Awaited<ReturnType<Client['listTools']>>
let discovery: any
beforeAll(async () => {
 discovery = await readDevelopmentDiscovery()
 await app.start()
 await client.connect(new StreamableHTTPClientTransport(new URL(app.url('/mcp')), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
 // Inspect the running isolated service contract before the first business write.
 tools = await client.listTools()
}, 90000)
afterAll(async () => { await client.close(); await app.close(); rmSync(dir, { recursive: true, force: true }) })
it('discovers and confirms source-bound qualification across real HTTP and MCP with public readback', async () => {
 for (const name of ['preflight_qualification_decision', 'commit_qualification_decision']) {
  const tool = tools.tools.find(t => t.name === name)
  expect(tool).toBeDefined()
  expect(tool!.inputSchema.additionalProperties).toBe(false)
 }
 expect(JSON.stringify(discovery)).toContain('/api/roster/decision-lifecycle/qualification-preflight')
 expect(JSON.stringify(discovery)).toContain('/api/roster/decision-lifecycle/qualification-commit')
 const enterprise = app.db.insert(s.enterprise).values({ name: '合成迁入验收', nameNorm: '合成迁入验收', usccNorm: '91330211255994457P' }).returning().get()
 const source = submitNativePlatformQuery(app.db, { interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-11-16T00:00:00Z', status: 'success', rawResponse: '{}', relations: [{ sequenceNo: 1, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm!, nameRaw: enterprise.name, verificationStatus: 'confirmed', matchBasis: 'uscc' }] })
 const qualification = { titleCode: 'specialized_sme', validFrom: '2025-07-22T00:00:00Z', validUntil: '2028-07-22T00:00:00Z', basis: '合成独立资格来源', publicationCheck: { status: 'not_found', scope: '合成公布范围' } }
 const command = { enterpriseId: enterprise.id, titleCode: 'specialized_sme', direction: 'extra_in_miit', action: 'replace', expectedCurrentId: null, idempotencyKey: 'app-confirm', actor: { type: 'agent', id: 'synthetic' }, basis: '合成核实', ruleVersion: 'manual', effectiveAt: '2026-11-16T00:00:00Z', decision: { status: 'confirmed_reason', reasonCode: 'moved_in', measureCode: 'record_moved_in', verificationStatus: 'confirmed', evidenceQueryId: source.queryId, evidenceRelationId: source.relationIds[0], movedIn: { city: '南通' }, currentQualification: qualification } }
 const preflight = await app.request('/api/roster/decision-lifecycle/qualification-preflight', { method: 'POST', body: JSON.stringify(command) })
 expect(preflight.status).toBe(200)
 const plan = await preflight.json()
 expect(plan.qualification).toEqual(qualification)
 const envelope = { command, planHash: plan.planHash }
 const decode = (result: any) => result.structuredContent ?? JSON.parse(result.content.find((c: any) => c.text).text)
 const saved = decode(await client.callTool({ name: 'commit_qualification_decision', arguments: envelope }))
 expect(saved.versionId).toBeGreaterThan(0)
 const replay = await app.request('/api/roster/decision-lifecycle/qualification-commit', { method: 'POST', body: JSON.stringify(envelope) })
 expect(replay.status).toBe(200)
 expect(await replay.json()).toEqual(saved)
 const current = await app.request('/api/roster/decision-lifecycle/current?' + new URLSearchParams({ enterpriseId: String(enterprise.id), titleCode: 'specialized_sme', direction: 'extra_in_miit' }))
 expect(current.status).toBe(200)
 expect((await current.json()).current).toMatchObject({ currentQualification: qualification, movedInCity: '南通' })
})
