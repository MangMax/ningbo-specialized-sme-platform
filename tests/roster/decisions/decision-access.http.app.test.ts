import { spawnCompiledApp } from '../../support/owned-process.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'

const dir = mkdtempSync(join(tmpdir(), 'review-108-browser-'))
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
let pool: pg.Pool
let db: NodePgDatabase
async function seedEnterprise(name: string, usccNorm?: string) {
  const [row] = await db.insert(enterprise).values({ name, nameNorm: name, usccNorm }).returning()
  return row!
}
const contextPath = '/api/roster/browser-context'
const externalPath = '/api/roster/decision-lifecycle/commands'
const apiToken = 'synthetic-browser-108-api'
let enabled: Server
let children: ChildProcess[] = []

type Server = { baseUrl: string; stop: () => Promise<void>; output: () => string }
const coordinate = (enterpriseId: number) => ({ enterpriseId, titleCode: 'specialized_sme' as const, direction: 'missing_in_miit' as const })
const decision = { status: 'confirmed_reason', reasonCode: 'other', reasonNote: '浏览器复核保留原业务判断', measureCode: 'keep_history', measureNote: '保留原措施', verificationStatus: 'confirmed' }
const replace = (enterpriseId: number, key: string, expectedCurrentId: number | null) => ({
  ...coordinate(enterpriseId), action: 'replace', expectedCurrentId, idempotencyKey: key,
  basis: '这次证据没有改变原判断，维持并登记复核', effectiveAt: '2026-10-20T00:00:00Z', decision,
})
async function json(response: Response) { return response.json() as Promise<any> }
async function start(env: Record<string, string>): Promise<Server> {
  const cwd = resolve(import.meta.dirname, '../../..')
  const port = await reserveLoopbackPort()
  const child = spawnCompiledApp(port, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NUXT_BUILD_DIR: join(dir, 'build-' + port),
      ...postgres!.env,
      NUXT_DB_READONLY: '0',
      NUXT_FILES_DIR: join(dir, 'files'),
      NUXT_INCOMING_DIR: join(dir, 'incoming'),
      NUXT_MCP_TOKEN: 'synthetic-browser-108-mcp',
      ...env,
    },
  })
  children.push(child)
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => { output = (output + data).slice(-8000) })
  const baseUrl = `http://127.0.0.1:${port}`
  const server: Server = { baseUrl, stop: () => stopOwnedChild(child), output: () => output }
  try {
    await waitForHttp(baseUrl + '/api/health', { timeoutMs: 60000, child })
  } catch (error) {
    await server.stop()
    throw new Error(String(error) + output)
  }
  return server
}
beforeAll(async () => {
  postgres = await postgresRuntimeFixture({ dir })
  pool = new pg.Pool({ connectionString: postgres.url, options: '-c search_path=business,public' })
  db = drizzle({ client: pool })
  enabled = await start({ NUXT_API_TOKEN: apiToken, })
}, 120000)
afterAll(async () => {
  try {
    if (enabled) await enabled.stop()
  } finally {
    for (const child of children) await stopOwnedChild(child).catch(() => {})
    try { await pool?.end() }
    finally { postgres?.close(); rmSync(dir, { recursive: true, force: true }) }
  }
})

describe('decision access', () => {
  it('reports only the boolean capability with no store and no secret', async () => {
    const response = await fetch(enabled.baseUrl + contextPath)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ writeEnabled: true })
    expect(text).not.toContain(apiToken)
    expect(text).not.toContain('actor')
  })

  it('keeps the external HTTP/MCP identity contract unchanged', async () => {
    const enterprise = await seedEnterprise('外部契约主体', 'BROWSER-108-F')
    const input = { ...replace(enterprise.id, 'external-identity-1', null), actor: { type: 'agent', id: 'synthetic-agent' }, ruleVersion: 'manual-rule-1' }
    const external = await fetch(enabled.baseUrl + externalPath, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiToken}` }, body: JSON.stringify(input) })
    expect(external.status).toBe(200)
    const versionId = (await json(external)).versionId
    expect(await json(await fetch(enabled.baseUrl + '/api/roster/decision-lifecycle/' + versionId))).toMatchObject({ actor: { type: 'agent', id: 'synthetic-agent' }, ruleVersion: 'manual-rule-1' })

    const { actor: _actor, ...missingActor } = input
    const noActor = await fetch(enabled.baseUrl + externalPath, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiToken}` }, body: JSON.stringify(missingActor) })
    expect(noActor.status).toBe(400)
    const { ruleVersion: _rule, ...missingRule } = input
    const noRule = await fetch(enabled.baseUrl + externalPath, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiToken}` }, body: JSON.stringify(missingRule) })
    expect(noRule.status).toBe(400)
    const mcpToken = await fetch(enabled.baseUrl + externalPath, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-browser-108-mcp' }, body: JSON.stringify({ ...input, idempotencyKey: 'external-mcp-token-108' }) })
    expect(mcpToken.status).toBe(401)
    const noToken = await fetch(enabled.baseUrl + externalPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, idempotencyKey: 'external-no-token-108' }) })
    expect(noToken.status).toBe(401)
  })

  it('reports browser write capability without an API token and rejects unauthenticated decision commands', async () => {
    const server = await start({ NUXT_API_TOKEN: '' })
    try {
      expect(await json(await fetch(server.baseUrl + contextPath))).toEqual({ writeEnabled: true })
      expect((await fetch(server.baseUrl + externalPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401)
    } finally { await server.stop() }
  }, 120000)

  it('does not print the configured token in the enabled server output', () => {
    expect(enabled.output()).not.toContain(apiToken)
  })
})
