import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createError } from 'h3'
const f = vi.hoisted(() => ({ db: vi.fn(), page: vi.fn(), execute: vi.fn(), log: vi.fn(), failure: vi.fn(), guard: vi.fn() }))
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))
vi.mock('@db', () => ({ useDb: f.db }))
vi.mock('../../../layers/sme-roster/server/utils/import-execution', () => ({ importExecutor: { execute: f.execute } }))
vi.mock('../../../layers/sme-roster/server/utils/roster-import-page-validation', () => ({ validateRosterImportPageCounts: f.page }))
vi.mock('../../../layers/core/lib/logging', () => ({ appLog: f.log }))
vi.mock('../../../layers/sme-roster/server/utils/roster-import-logging', () => ({ logImportFailure: f.failure }))
vi.mock('../../../layers/core/server/utils/mcp-guard', () => ({ writeGuard: f.guard }))
import preflight from '../../../server/mcp/tools/preflight_roster_batch'
import commit from '../../../server/mcp/tools/save_roster_batch'
import { rosterImportMcpContext } from '../../../layers/sme-roster/server/utils/roster-import-mcp-context'
import { ImportReceiptError } from '../../../layers/sme-roster/server/utils/import-receipts'
const input = { idempotencyKey: 'fixture-180', sourceKind: 'platform_export', sourceIdentity: 'fixture180', payload: { exportSnapshot: {} } }
beforeEach(() => { vi.clearAllMocks(); f.db.mockReturnValue('db'); f.page.mockResolvedValue([]); f.execute.mockResolvedValue({ status: 'preflight' }); vi.stubGlobal('createError', createError); vi.stubGlobal('useRuntimeConfig', () => ({ filesDir: '/fixture' })) })
afterEach(() => vi.unstubAllGlobals())
const tools = [['preflight', preflight], ['commit', commit]] as const
it('retains distinct tool schemas and the commit-only enabled guard', () => {
  expect(preflight.name).toBe('preflight_roster_batch'); expect(commit.name).toBe('save_roster_batch')
  expect((preflight as any).enabled).toBeUndefined(); expect(commit.enabled).toBe(f.guard)
  expect(preflight.annotations?.readOnlyHint).toBe(true); expect(commit.annotations?.readOnlyHint).toBe(false)
  expect(Object.keys(preflight.inputSchema!)).toEqual(['idempotencyKey', 'sourceKind', 'sourceIdentity', 'sourceSha256', 'payload'])
  expect(Object.keys(commit.inputSchema!)).toEqual(Object.keys(preflight.inputSchema!))
})
for (const [action, tool] of tools) {
  it(`${action} validates before lazy database acquisition and retains captured context`, async () => {
    const context = { requestId: 'mcp-180', traceId: 'trace-180' }
    await rosterImportMcpContext.run(context, () => tool.handler(input as never, {} as never))
    expect(f.execute).toHaveBeenCalledExactlyOnceWith('db', action, { ...input, sourceSha256: null }, [], context, { filesDir: '/fixture' })
    expect(f.page.mock.invocationCallOrder[0]).toBeLessThan(f.db.mock.invocationCallOrder[0]!)
    expect(f.failure).not.toHaveBeenCalled()
  })
  it(`${action} rejects invalid requests without acquiring the database`, async () => {
    await expect(tool.handler({ ...input, idempotencyKey: '' } as never, {} as never)).rejects.toMatchObject({ statusCode: 400 })
    expect(f.db).not.toHaveBeenCalled(); expect(f.page).not.toHaveBeenCalled()
    expect(f.log).toHaveBeenCalledWith(expect.objectContaining({ operation: `import.submission.${action}`, outcome: 'denied' }), {})
  })
  it(`${action} retains native page-validation faults and logs one submission failure before any database access`, async () => {
    const error = createError({ statusCode: 503, message: 'fixture-fault' }); f.page.mockRejectedValueOnce(error)
    await expect(tool.handler(input as never, {} as never)).rejects.toBe(error)
    expect(f.db).not.toHaveBeenCalled()
    expect(f.failure).toHaveBeenCalledExactlyOnceWith(`import.submission.${action}`, error, {})
  })
  it(`${action} preserves structured receipt errors and executor failures`, async () => {
    const error = new ImportReceiptError(409, 'fixture_conflict', 'fixture message'); f.execute.mockRejectedValueOnce(error)
    expect(await tool.handler(input as never, {} as never)).toEqual({ isError: true, structuredContent: { error: { code: 'fixture_conflict', message: 'fixture message' } } })
    expect(f.failure).toHaveBeenCalledExactlyOnceWith(`import.submission.${action}`, error, {})
  })
}
