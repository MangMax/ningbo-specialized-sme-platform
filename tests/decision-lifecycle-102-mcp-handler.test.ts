import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { initializeDb } from '../db/client'
import { decisionCommand102 } from '../server/utils/decision-lifecycle-102'

// Only the framework registration shell is replaced; the exported tool handler,
// parser, error mapping, output redaction and SQLite remain real.
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (definition: unknown) => definition }))
vi.mock('@db', () => ({ useDb: () => db }))
const dir = mkdtempSync(join(tmpdir(), 'decision-102-handler-'))
const db = initializeDb({ create: true,  dbPath: join(dir, 'synthetic.db') })
let handler: (typeof import('../server/mcp/tools/save_difference_decision'))['default']['handler']
beforeAll(async () => {
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: '', mcpToken: '' }))
  handler = (await import('../server/mcp/tools/save_difference_decision')).default.handler
})
afterAll(() => { vi.unstubAllGlobals(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })

it.each([
  { case: 'maintain-without-reviewed-evidence', action: 'maintain', includeDecision: false },
  { case: 'replace-without-decision', action: 'replace', includeDecision: false },
  { case: 'withdraw-with-decision', action: 'withdraw', includeDecision: true },
])('maps shape-valid semantic tool errors to invalid_request: $case', async ({ case: key, action, includeDecision }) => {
  const input = {
    enterpriseId: 1, titleCode: 'specialized_sme', direction: 'missing_in_miit', action,
    expectedCurrentId: null, idempotencyKey: key, actor: { type: 'agent', id: 'synthetic-agent' },
    basis: 'synthetic basis', ruleVersion: 'synthetic-rule', effectiveAt: '2026-10-19T00:00:00Z',
    ...(includeDecision ? { decision: { status: 'needs_review', measureCode: 'manual_review', verificationStatus: 'pending' } } : {}),
  }
  const shapeParsed = z.object(decisionCommand102.shape).parse(input)
  const result = await handler({ ...shapeParsed, decision: shapeParsed.decision, reviewedEvidence: shapeParsed.reviewedEvidence }, {} as never) as { isError: boolean; content: Array<{ text: string }> }
  expect(result.isError).toBe(true)
  expect(JSON.parse(result.content[0]!.text)).toEqual({ error: { code: 'invalid_request', message: 'Invalid decision request; see decision-lifecycle contract' } })
  expect(db.get(sql`select count(*) as n from difference_reason`)).toEqual({ n: 0 })
  expect(db.get(sql`select count(*) as n from evidence_review_receipt_114`)).toEqual({ n: 0 })
})
