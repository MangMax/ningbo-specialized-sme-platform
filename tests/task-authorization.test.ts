// The page-level authorisation composable on its own: the bounded verdict, the
// ticket that abandons a superseded check, and the rule that a verdict only counts
// when it answers *this* candidate. tests/task-center-ui.test.ts drives the same
// code through the real Input, form and buttons.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTHORIZATION_CHECK_TIMEOUT_MS, useAdminAuthorization, type CredentialAnswer } from '../composables/useAdminAuthorization'

const read = (candidate: string, authorized: boolean) => async (): Promise<{ ok: boolean, answer: CredentialAnswer | null }> => ({ ok: true, answer: { credential: candidate, authorized } })
/** A read the server accepted and never answers. */
const never = () => new Promise<{ ok: boolean, answer: CredentialAnswer | null }>(() => {})

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('管理操作授权（有界校验）', () => {
  it('服务端不应答：八秒后如实说“没拿到答案”，不停在验证中，也不把密钥判成错误', async () => {
    const auth = useAdminAuthorization()
    const pending = auth.verify('hanging-key', never, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(auth.phase.value).toBe('checking')
    expect(auth.checking.value).toBe(true)

    // One second before the bound it is still honestly "checking"...
    await vi.advanceTimersByTimeAsync(AUTHORIZATION_CHECK_TIMEOUT_MS - 1000)
    expect(auth.phase.value).toBe('checking')
    // ...and right after it, the verdict is "no answer", with the draft kept.
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toBe(false)
    expect(auth.phase.value).toBe('unreachable')
    expect(auth.message.value).toMatch(/未在 8 秒内回应/)
    expect(auth.message.value).not.toMatch(/未通过校验|请输入/)
    expect(auth.draft.value).toBe('')
    expect(auth.verified.value).toBe('')
    // The key stays only in the field (the person can submit again); it is not
    // treated as a proven credential.
    expect(auth.checking.value).toBe(false)
  })

  it('服务端说本次密钥未授权：就地拒绝并清掉凭据，但保留草稿', async () => {
    const auth = useAdminAuthorization()
    auth.draft.value = 'wrong-key'
    expect(await auth.verify('wrong-key', read('wrong-key', false), new AbortController().signal)).toBe(false)
    expect(auth.phase.value).toBe('rejected')
    expect(auth.credential.value).toBe('')
    expect(auth.verified.value).toBe('')
    expect(auth.draft.value).toBe('wrong-key')
  })

  it('别的密钥的答案不能被当成这次的结果（不拿“当前”凭据给旧读取贴标签）', async () => {
    const auth = useAdminAuthorization()
    // The read answers about an older key than the one this attempt submitted.
    expect(await auth.verify('new-key', read('old-key', true), new AbortController().signal)).toBe(false)
    expect(auth.verified.value).toBe('')
    expect(auth.phase.value).toBe('unreachable')

    // The same read answering about the submitted key does prove it.
    expect(await auth.verify('new-key', read('new-key', true), new AbortController().signal)).toBe(true)
    expect(auth.verified.value).toBe('new-key')
    expect(auth.draft.value).toBe('')
  })

  it('清除授权会作废在途的校验：晚到的“已授权”不改任何状态', async () => {
    const auth = useAdminAuthorization()
    let release!: () => void
    const held = new Promise<{ ok: boolean, answer: CredentialAnswer | null }>(resolve => { release = () => resolve({ ok: true, answer: { credential: 'right-key', authorized: true } }) })
    const pending = auth.verify('right-key', () => held, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(auth.phase.value).toBe('checking')

    auth.clear()
    release()
    expect(await pending).toBe(false)
    expect(auth.verified.value).toBe('')
    expect(auth.phase.value).toBe('idle')
    expect(auth.credential.value).toBe('')
  })

  it('离页放弃校验（clearChecking）只作废这一次，不清掉已确认的授权', async () => {
    const auth = useAdminAuthorization()
    expect(await auth.verify('right-key', read('right-key', true), new AbortController().signal)).toBe(true)
    const pending = auth.verify('second-key', never, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(0)
    auth.clearChecking()
    await vi.advanceTimersByTimeAsync(AUTHORIZATION_CHECK_TIMEOUT_MS)
    expect(await pending).toBe(false)
    expect(auth.verified.value).toBe('right-key')
  })
})
