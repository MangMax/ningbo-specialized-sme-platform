// @vitest-environment jsdom
import { effectScope } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { useRosterInitialDifferenceDecision } from '../../../layers/sme-roster/app/composables/useRosterInitialDifferenceDecision'

const coordinate = { enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit' }
const current = (id: number | null) => ({ ...coordinate, versionId: id, current: id ? { ...coordinate, id, status: 'confirmed_reason', reasonCode: 'other', measureCode: 'keep_history' } : null })
const valid = (c: ReturnType<typeof useRosterInitialDifferenceDecision>) => {
  c.basis.value = '核对指定公布材料与平台原行'
  Object.assign(c.draft.value, { status: 'confirmed_reason', reasonCode: 'other', measureCode: 'keep_history' })
}
const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => scopes.splice(0).forEach(s => s.stop()))
function setup(post = vi.fn().mockResolvedValue({ versionId: 9 }), patch: Record<string, unknown> = {}) {
  let head = current(null)
  const api = { context: vi.fn().mockResolvedValue({ writeEnabled: true }), current: vi.fn(async () => head), post, ...patch }
  const scope = effectScope(); scopes.push(scope)
  const c = scope.run(() => useRosterInitialDifferenceDecision(coordinate, api as any))!
  return { c, api, setHead: (id: number | null) => { head = current(id) } }
}
it('requires explicit conclusion reason measure and basis before the first exact-scope command', async () => {
  const { c, api, setHead } = setup()
  await c.load()
  expect(c.draft.value.status).toBe('')
  expect(c.canSave.value).toBe(false)
  c.basis.value = '依据'; expect(c.canSave.value).toBe(false)
  c.draft.value.status = 'confirmed_reason'; c.draft.value.reasonCode = 'other'
  expect(c.canSave.value).toBe(false)
  c.draft.value.measureCode = 'keep_history'; expect(c.canSave.value).toBe(true)
  expect(c.dirty.value).toBe(true)
  setHead(9); await c.save()
  expect(c.dirty.value).toBe(false)
  expect(api.post).toHaveBeenCalledTimes(1)
  const body = api.post.mock.calls[0]![0]
  expect(body).toMatchObject({ ...coordinate, expectedCurrentId: null, action: 'replace', basis: '依据' })
  expect(body).not.toHaveProperty('reviewedEvidence'); expect(body).not.toHaveProperty('actor'); expect(body).not.toHaveProperty('ruleVersion')
  expect(c.phase.value).toBe('saved'); expect(c.head.value?.versionId).toBe(9)
})
it.each([{ name: 'disabled', value: { writeEnabled: false } }, { name: 'unknown', value: {} }])('fails closed for deployment capability $name', async ({ value }) => {
  const { c, api } = setup(undefined, { context: vi.fn().mockResolvedValue(value) }); await c.load(); valid(c)
  await c.save(); expect(api.post).not.toHaveBeenCalled(); expect(c.canSave.value).toBe(false)
})
it('requires explicit correction when a current head already exists', async () => {
  const { c, api, setHead } = setup(); setHead(8); await c.load(); valid(c)
  await c.save(); expect(api.post).not.toHaveBeenCalled()
  c.begin(); setHead(9); await c.save()
  expect(api.post.mock.calls[0]![0].expectedCurrentId).toBe(8)
})
it('retains the draft on stale head and requires reload plus explicit correction', async () => {
  const post = vi.fn().mockRejectedValueOnce({ status: 409, data: { error: { code: 'stale_version' } } }).mockResolvedValue({ versionId: 10 })
  const { c, setHead } = setup(post); await c.load(); valid(c); await c.save()
  expect(c.phase.value).toBe('conflict'); expect(c.basis.value).toContain('核对指定'); expect(c.canSave.value).toBe(false)
  setHead(9); await c.load(); expect(c.canSave.value).toBe(false)
  c.begin(); setHead(10); await c.save(); expect(post.mock.calls[1]![0].expectedCurrentId).toBe(9)
  expect(post.mock.calls[1]![0].idempotencyKey).not.toBe(post.mock.calls[0]![0].idempotencyKey)
})
it('freezes an unknown request and retries its complete body with the same key', async () => {
  const post = vi.fn().mockRejectedValueOnce(new Error('lost response')).mockResolvedValue({ versionId: 9 })
  const { c, api, setHead } = setup(post); await c.load(); valid(c); await c.save()
  expect(c.phase.value).toBe('unknown'); expect(c.locked.value).toBe(true)
  c.basis.value = '程序化改值不能改变未知请求'; setHead(9)
  await c.load(); expect(api.current).toHaveBeenCalledTimes(1)
  await c.save(); expect(post.mock.calls[1]![0]).toEqual(post.mock.calls[0]![0]); expect(c.phase.value).toBe('saved')
})
it('retries only reads after commit when current readback fails', async () => {
  const { c, api, setHead } = setup(); await c.load(); valid(c)
  api.current.mockRejectedValueOnce(new Error('readback failed')); await c.save()
  expect(c.phase.value).toBe('readback'); expect(c.locked.value).toBe(true)
  await c.save(); expect(api.post).toHaveBeenCalledTimes(1)
  setHead(9); await c.load(); expect(c.phase.value).toBe('saved'); expect(api.post).toHaveBeenCalledTimes(1)
})
it('rejects mismatched scope and invalid optional evidence IDs without writing', async () => {
  const { c, api } = setup(undefined, { current: vi.fn().mockResolvedValue({ ...current(null), enterpriseId: 8 }) })
  await c.load(); valid(c); await c.save(); expect(api.post).not.toHaveBeenCalled()
  const other = setup(); await other.c.load(); valid(other.c)
  other.c.draft.value.evidenceRelationId = '0'; expect(other.c.canSave.value).toBe(false)
  other.c.draft.value.evidenceRelationId = '9007199254740992'; expect(other.c.canSave.value).toBe(false)
  other.c.draft.value.evidenceRelationId = ''; other.c.draft.value.reasonCode = 'pending_review'; expect(other.c.canSave.value).toBe(false)
  other.c.draft.value.measureCode = 'follow_review'; expect(other.c.canSave.value).toBe(true)
})
it('requires explicit no-difference and none measure without carrying a hidden reason', async () => {
  const { c, api, setHead } = setup(); await c.load(); c.basis.value = '人工明确确认无差异'
  c.draft.value.status = 'confirmed_no_diff'; c.draft.value.reasonCode = 'other'
  expect(c.canSave.value).toBe(false)
  c.draft.value.measureCode = 'none'; expect(c.canSave.value).toBe(true)
  setHead(9); await c.save(); expect(api.post.mock.calls[0]![0].decision).toMatchObject({ reasonCode: null, status: 'confirmed_no_diff', measureCode: 'none' })
})
it('preserves the withdrawn head coordinate and fails closed for an unavailable current field', async () => {
  const withdrawn = { ...coordinate, versionId: 8, current: null }
  const { c, api } = setup(undefined, { current: vi.fn().mockResolvedValue(withdrawn) }); await c.load(); valid(c); await c.save()
  expect(api.post.mock.calls[0]![0].expectedCurrentId).toBe(8)
  const missing = setup(undefined, { current: vi.fn().mockResolvedValue({ ...coordinate, versionId: null }) }); await missing.c.load(); valid(missing.c); await missing.c.save()
  expect(missing.c.phase.value).toBe('error'); expect(missing.api.post).not.toHaveBeenCalled()
})
it('keeps an unavailable capability honestly read-only and can recover by rechecking', async () => {
  const context = vi.fn().mockRejectedValueOnce(new Error('capability unavailable')).mockResolvedValue({ writeEnabled: true })
  const { c, api } = setup(undefined, { context }); await c.load(); valid(c)
  expect(c.writeState.value).toBe('unavailable'); await c.save(); expect(api.post).not.toHaveBeenCalled()
  await c.load(); expect(c.writeState.value).toBe('ready'); expect(c.canSave.value).toBe(true)
})
