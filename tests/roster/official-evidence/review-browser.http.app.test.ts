import { spawnCompiledApp } from '../../support/owned-process.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { initializeDb, schema } from '../../../db/client'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'

const dir = mkdtempSync(join(tmpdir(), 'review-108-browser-'))
const dbPath = join(dir, 'synthetic.db')
const db = initializeDb({ create: true,  dbPath })
const contextPath = '/api/roster/evidence-review/browser-context'
const commandPath = '/api/roster/evidence-review/browser-commands'
const externalPath = '/api/roster/decision-lifecycle/commands'
const apiToken = 'synthetic-browser-108-api'
let enabled: Server
let children: ChildProcess[] = []

type Server = { baseUrl: string; stop: () => Promise<void>; output: () => string }
const coordinate = (enterpriseId: number) => ({ enterpriseId, titleCode: 'specialized_sme' as const, direction: 'missing_in_miit' as const })
const scopeQuery = (enterpriseId: number) => new URLSearchParams(Object.entries(coordinate(enterpriseId)).map(([key, value]) => [key, String(value)]))
const decision = { status: 'confirmed_reason', reasonCode: 'other', reasonNote: '浏览器复核保留原业务判断', measureCode: 'keep_history', measureNote: '保留原措施', verificationStatus: 'confirmed' }
const replace = (enterpriseId: number, key: string, expectedCurrentId: number | null) => ({
  ...coordinate(enterpriseId), action: 'replace', expectedCurrentId, idempotencyKey: key,
  basis: '这次证据没有改变原判断，维持并登记复核', effectiveAt: '2026-10-20T00:00:00Z', decision,
})
const maintain = (enterpriseId: number, key: string, expectedCurrentId: number) => ({
  ...coordinate(enterpriseId), action: 'maintain', expectedCurrentId, idempotencyKey: key,
  basis: '证据变化已核对，维持原决定', effectiveAt: '2026-10-20T00:00:00Z',
  reviewedEvidence: { latestRevisionId: 0, projectionReady: true },
})
async function json(response: Response) { return response.json() as Promise<any> }
function browserPost(server: Server, body: unknown, headers: Record<string, string> = {}) {
  return fetch(server.baseUrl + commandPath, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: server.baseUrl,
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}
async function start(env: Record<string, string>): Promise<Server> {
  const cwd = resolve(import.meta.dirname, '../../..')
  const port = await reserveLoopbackPort()
  const child = spawnCompiledApp(port, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NUXT_BUILD_DIR: join(dir, 'build-' + port),
      NUXT_DB_PATH: dbPath,
      NUXT_CURATED_PATH: join(dir, 'curated.json'),
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
    await waitForHttp(baseUrl + '/api/roster/differences', { timeoutMs: 60000, child })
  } catch (error) {
    await server.stop()
    throw new Error(String(error) + output)
  }
  return server
}
function rowCount() {
  return (db.get(sql`select count(*) as n from difference_reason`) as { n: number }).n
}

beforeAll(async () => {
  enabled = await start({ NUXT_API_TOKEN: apiToken, })
}, 120000)
afterAll(async () => {
  if (enabled) await enabled.stop()
  for (const child of children) await stopOwnedChild(child).catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})
afterEach(async () => {
  // Leave the enabled fixture running; only per-test short-lived servers are stopped.
})

describe("ticket browser review capability", () => {
  it.each(['replace', 'maintain'] as const)('replays original browser null-envelope receipts after supersession: %s', async action => {
    const enterprise = db.insert(schema.enterprise).values({ name: '原浏览器回执-' + action, nameNorm: '原浏览器回执-' + action }).returning().get()
    const key = 'original-browser-' + action
    const row = db.insert(schema.differenceReason).values({
      ...coordinate(enterprise.id), lifecycleAction: 'replace', status: 'needs_review',
      measureCode: 'manual_review', verificationStatus: 'pending', actor: sql`'null'`,
      recordedAt: '2026-10-19T00:00:00.000Z',
    }).returning().get()
    const body = action === 'replace' ? replace(enterprise.id, key, null) : maintain(enterprise.id, key, row.id)
    // Frozen schema order from 4020270's internal browser envelope.
    const normalized = {
      ...coordinate(enterprise.id), action, actor: null, ruleVersion: null,
      expectedCurrentId: body.expectedCurrentId, idempotencyKey: key, basis: body.basis,
      effectiveAt: body.effectiveAt,
      ...('decision' in body ? { decision: body.decision } : {}),
      ...('reviewedEvidence' in body ? { reviewedEvidence: body.reviewedEvidence } : {}),
    }
    const hash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
    const receipt = { versionId: row.id, currentId: row.id, previousId: null, action,
      recordedAt: row.recordedAt, ...(action === 'maintain' ? { reviewedRevisionId: 0 } : {}) }
    if (action === 'replace') {
      db.run(sql`update difference_reason set idempotency_key=${key},request_hash=${hash} where id=${row.id}`)
    } else {
      db.insert(schema.evidenceReviewReceipt114).values({ ...coordinate(enterprise.id), idempotencyKey: key, requestHash: hash,
        kind: action, decisionId: row.id, sourceDecisionId: row.id, reviewedRevisionId: 0,
        actor: sql`'null'`, basis: body.basis, ruleVersion: null, effectiveAt: body.effectiveAt,
        response: receipt, recordedAt: row.recordedAt }).run()
    }
    db.insert(schema.differenceReason).values({ ...coordinate(enterprise.id), lifecycleAction: 'replace', status: 'needs_review',
      measureCode: 'manual_review', verificationStatus: 'pending', recordedAt: '2026-10-19T01:00:00.000Z' }).run()
    const before = rowCount()
    const replay = await browserPost(enabled, body)
    expect(replay.status).toBe(200)
    expect(await json(replay)).toEqual(receipt)
    const conflict = await browserPost(enabled, { ...body, basis: 'different request' })
    expect(conflict.status).toBe(409)
    expect(await json(conflict)).toMatchObject({ error: { code: 'idempotency_conflict' } })
    expect(rowCount()).toBe(before)
    const stored = action === 'replace'
      ? db.get(sql`select request_hash as hash from difference_reason where id=${row.id}`)
      : db.get(sql`select request_hash as hash from evidence_review_receipt_114 where idempotency_key=${key}`)
    expect(stored).toEqual({ hash })
  })

  it('reports only the boolean capability with no store and no secret', async () => {
    const response = await fetch(enabled.baseUrl + contextPath)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ writeEnabled: true })
    expect(text).not.toContain(apiToken)
    expect(text).not.toContain('actor')
  })

  it("writes browser maintain and replace with real JSON-null metadata through the single writer", async () => {
    const enterprise = db.insert(schema.enterprise).values({ name: '浏览器复核主体', nameNorm: '浏览器复核主体', usccNorm: 'BROWSER-108-A' }).returning().get()
    const first = await browserPost(enabled, replace(enterprise.id, 'browser-replace-1', null))
    expect(first.status, await first.clone().text()).toBe(200)
    const replaced = await json(first)
    expect(replaced).toMatchObject({ action: 'replace', versionId: expect.any(Number), currentId: expect.any(Number) })

    const rawDecision = db.get(sql`select actor, rule_version as ruleVersion from difference_reason where id=${replaced.versionId}`) as any
    expect(JSON.parse(rawDecision.actor)).toBeNull()
    expect(rawDecision.ruleVersion).toBeNull()
    // Freeze the original browser null-envelope order independently of the writer.
    // External historical compatibility must not invalidate browser receipts.
    const browserEnvelope = {
      ...coordinate(enterprise.id), action: 'replace', actor: null, ruleVersion: null,
      expectedCurrentId: null, idempotencyKey: 'browser-replace-1',
      basis: '这次证据没有改变原判断，维持并登记复核', effectiveAt: '2026-10-20T00:00:00Z', decision,
    }
    const originalHash = createHash('sha256').update(JSON.stringify(browserEnvelope)).digest('hex')
    expect(db.get(sql`select request_hash as hash from difference_reason where id=${replaced.versionId}`)).toEqual({ hash: originalHash })
    const replacementReplay = await browserPost(enabled, replace(enterprise.id, 'browser-replace-1', null))
    expect(replacementReplay.status).toBe(200)
    expect(await json(replacementReplay)).toEqual(replaced)

    const read = await json(await fetch(enabled.baseUrl + '/api/roster/decision-lifecycle/' + replaced.versionId))
    expect(read).toMatchObject({ id: replaced.versionId, actor: null, ruleVersion: null, reasonNote: '浏览器复核保留原业务判断' })

    const maintained = await browserPost(enabled, maintain(enterprise.id, 'browser-maintain-1', replaced.versionId))
    expect(maintained.status, await maintained.clone().text()).toBe(200)
    const receipt = await json(maintained)
    expect(receipt).toMatchObject({ versionId: replaced.versionId, currentId: replaced.versionId, action: 'maintain', reviewedRevisionId: 0 })
    const rawReceipt = db.get(sql`select actor, actor is not null as actorNotNull, json_type(actor) as actorType, rule_version as ruleVersion from evidence_review_receipt_114 where idempotency_key='browser-maintain-1'`) as any
    expect(rawReceipt).toMatchObject({ actor: 'null', actorNotNull: 1, actorType: 'null', ruleVersion: null })

    const list = await json(await fetch(enabled.baseUrl + '/api/roster/evidence-impacts?' + new URLSearchParams({ enterpriseId: String(enterprise.id), state: 'reviewed', view: 'current' })))
    expect(list.rows).toHaveLength(1)
    const detail = await json(await fetch(enabled.baseUrl + '/api/roster/evidence-impacts/' + list.rows[0].id))
    expect(detail.pending).toBe(false)
    expect(detail.reviewedBaseline).toMatchObject({
      reviewedRevisionId: 0,
      actor: null,
      ruleVersion: null,
      basis: '证据变化已核对，维持原决定',
      effectiveAt: '2026-10-20T00:00:00Z',
    })

    const replay = await browserPost(enabled, maintain(enterprise.id, 'browser-maintain-1', replaced.versionId))
    expect(await json(replay)).toEqual(receipt)
    expect((await fetch(enabled.baseUrl + '/api/roster/decision-lifecycle/history?' + scopeQuery(enterprise.id))).status).toBe(200)
    const history = await json(await fetch(enabled.baseUrl + '/api/roster/decision-lifecycle/history?' + scopeQuery(enterprise.id)))
    expect(history.rows[0]).toMatchObject({ id: replaced.versionId, actor: null, ruleVersion: null })
  })

  it('keeps concurrent replace resolution and idempotent replay through the browser route', async () => {
    const enterprise = db.insert(schema.enterprise).values({ name: '浏览器并发主体', nameNorm: '浏览器并发主体', usccNorm: 'BROWSER-108-B' }).returning().get()
    const base = await json(await browserPost(enabled, replace(enterprise.id, 'browser-race-base', null)))
    const a = replace(enterprise.id, 'browser-race-a', base.versionId)
    const b = replace(enterprise.id, 'browser-race-b', base.versionId)
    const raced = await Promise.all([browserPost(enabled, a), browserPost(enabled, b)])
    expect(raced.map(r => r.status).sort()).toEqual([200, 409])
    const failed = raced.find(r => r.status === 409)!
    expect(await json(failed)).toMatchObject({ error: { code: 'stale_version' } })
    const winner = raced.find(r => r.status === 200)!
    const won = await json(winner)
    const winningBody = raced[0]!.status === 200 ? a : b
    expect(await json(await browserPost(enabled, winningBody))).toEqual(won)
    expect((await browserPost(enabled, { ...winningBody, basis: '同一提交标识但不同请求' })).status).toBe(409)
    const raw = db.get(sql`select actor, rule_version as ruleVersion from difference_reason where id=${won.versionId}`) as any
    expect(JSON.parse(raw.actor)).toBeNull()
    expect(raw.ruleVersion).toBeNull()
  })

  it('rejects missing, cross-site, mismatched origins and non-JSON bodies before any write', async () => {
    const enterprise = db.insert(schema.enterprise).values({ name: '浏览器闸门主体', nameNorm: '浏览器闸门主体', usccNorm: 'BROWSER-108-C' }).returning().get()
    const body = replace(enterprise.id, 'browser-gate-1', null)
    const before = rowCount()
    const noOrigin = await fetch(enabled.baseUrl + commandPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(noOrigin.status).toBe(403)
    expect(await json(noOrigin)).toMatchObject({ error: { code: 'origin_required' } })
    const withApiToken = await fetch(enabled.baseUrl + commandPath, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiToken}` }, body: JSON.stringify(body) })
    expect(withApiToken.status).toBe(403)
    expect(await json(withApiToken)).toMatchObject({ error: { code: 'origin_required' } })
    const cross = await browserPost(enabled, body, { 'sec-fetch-site': 'cross-site' })
    expect(cross.status).toBe(403)
    expect(await json(cross)).toMatchObject({ error: { code: 'cross_site_request' } })
    const sameSite = await browserPost(enabled, body, { 'sec-fetch-site': 'same-site' })
    expect(sameSite.status).toBe(403)
    const wrong = await browserPost(enabled, body, { origin: 'http://127.0.0.1:1' })
    expect(wrong.status).toBe(403)
    expect(await json(wrong)).toMatchObject({ error: { code: 'origin_mismatch' } })
    const trailing = await browserPost(enabled, body, { origin: enabled.baseUrl + '/' })
    expect(trailing.status).toBe(403)
    expect(await json(trailing)).toMatchObject({ error: { code: 'origin_mismatch' } })
    const badContent = await browserPost(enabled, body, { 'content-type': 'text/plain' })
    expect(badContent.status).toBe(415)
    expect(await json(badContent)).toMatchObject({ error: { code: 'unsupported_media_type' } })
    expect(rowCount()).toBe(before)
  })

  it('rejects actor, ruleVersion, withdraw and unknown fields with a strict schema', async () => {
    const enterprise = db.insert(schema.enterprise).values({ name: '浏览器字段主体', nameNorm: '浏览器字段主体', usccNorm: 'BROWSER-108-D' }).returning().get()
    const body = replace(enterprise.id, 'browser-fields-base', null)
    const before = rowCount()
    for (const spoof of [
      { ...body, actor: { type: 'agent', id: 'forged' } },
      { ...body, ruleVersion: 'forged-version' },
      { ...body, action: 'withdraw' },
      { ...body, extra: true },
      { ...body, decision: { ...body.decision, unknown: true } },
    ]) {
      const response = await browserPost(enabled, spoof)
      expect(response.status, JSON.stringify(spoof)).toBe(400)
      expect(await json(response)).toMatchObject({ error: { code: 'invalid_request' } })
    }
    expect(rowCount()).toBe(before)
  })

  it('ignores spoofed forwarded host headers but still requires an exact Origin', async () => {
    const enterprise = db.insert(schema.enterprise).values({ name: '浏览器转发头主体', nameNorm: '浏览器转发头主体', usccNorm: 'BROWSER-108-E' }).returning().get()
    const first = await json(await browserPost(enabled, replace(enterprise.id, 'browser-forward-base', null)))
    const response = await browserPost(enabled, maintain(enterprise.id, 'browser-forward-maintain', first.versionId), { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' })
    expect(response.status, (await response.clone().text()) + '\n' + enabled.output().slice(-3000)).toBe(200)
  })

  it('keeps the external HTTP/MCP identity contract unchanged', async () => {
    const enterprise = db.insert(schema.enterprise).values({ name: '外部契约主体', nameNorm: '外部契约主体', usccNorm: 'BROWSER-108-F' }).returning().get()
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

  it('enables same-origin review without a configured API token while external commands remain protected', async () => {
    const server = await start({ NUXT_API_TOKEN: '' })
    try {
      expect(await json(await fetch(server.baseUrl + contextPath))).toEqual({ writeEnabled: true })
      expect((await browserPost(server, {})).status).toBe(400)
      expect((await fetch(server.baseUrl + externalPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401)
    } finally { await server.stop() }
  }, 120000)

  it('does not print the configured token in the enabled server output', () => {
    expect(enabled.output()).not.toContain(apiToken)
  })
})
