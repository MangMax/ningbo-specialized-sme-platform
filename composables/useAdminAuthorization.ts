import { computed, ref, shallowRef } from 'vue'

/** What a read told us about the credential it carried. */
export type CredentialAnswer = { credential: string, authorized: boolean }

/** 一次“验证”从提交到落定最多等多久；超过就是“没拿到答案”，不是“密码错了”。 */
export const AUTHORIZATION_CHECK_TIMEOUT_MS = 8000

const MESSAGES = {
  missing: '请输入管理员提供的 API 管理密钥。',
  rejected: '密钥未通过校验（服务端未授权）。请向管理员核对后重试；输入框已保留，可直接修正。',
  unreachable: '暂时无法连接服务端校验授权，密钥已保留；请稍后重试或再次点“应用授权”。',
  timeout: '服务端未在 8 秒内回应校验，密钥已保留；请稍后再次点“应用授权”。',
} as const

/**
 * 页面内的管理操作授权（只在本页内存，离页即清）。
 *
 * 服务端的只读 GET 永远 200，只在响应体 `authorized` 字段里说明**本次请求**的
 * 凭据是否有效。所以“验证密钥”只能靠一次带该候选密钥的只读读取来完成，并且要
 * 判定的是**候选密钥自己那次请求**的答案，而不是上一把已提交密钥的结果。
 *
 * 这里只认**发起时捕获**的候选密钥：读取载荷里带着它出发时的凭据，缓存里也是
 * 那份载荷。绝不拿“落定时刻的 credential”去给一次旧读取贴标签 —— 那会把上一把
 * 密钥（或已清除的凭据）的答案算到别人头上。
 *
 * 一次验证**有界**：超时按“未拿到答案”收尾，不留永远悬挂的“正在验证”。
 * “重新验证 / 清除”会作废在途的那次验证，它的晚回应不再改动任何状态。
 */
export function useAdminAuthorization() {
  /** 输入框草稿。失败时不清空，让人直接改一个字符就能重试。 */
  const draft = ref('')
  /** 已提交、随请求发出的凭据。 */
  const credential = ref('')
  /** 已确认有效的凭据；授权徽标只认它。 */
  const verified = shallowRef('')
  /** 计入轮询键：凭据变化就用新凭据重读一次。 */
  const version = ref(0)
  const phase = ref<'idle' | 'checking' | 'rejected' | 'unreachable'>('idle')
  const message = ref('')
  /** 每次验证/清除都会推进；晚到的回应据此判断自己是否已经过时。 */
  let ticket = 0

  const checking = computed(() => phase.value === 'checking')

  function fail(kind: 'rejected' | 'unreachable', text: string) {
    // 就地失败：草稿是唯一记录输入的地方，保留它；凭据则清掉，徽标不冒充授权。
    credential.value = ''
    verified.value = ''
    version.value++
    phase.value = kind; message.value = text
  }

  /**
   * 用候选密钥读一次并判定。
   *
   * 改变凭据会改变读取键，轮询随即用新凭据开始一次读取 —— 这里**只等那一次**。
   * 不要再调 refresh()：那只会在它之前插队并中止它。
   * 也不要 await nextTick()：提交处理器本身在渲染队列里，等渲染可能等不到。
   */
  /** The read proves the credential it is given; it may not read "the current" one. */
  async function verify(
    candidate: string,
    awaitRead: (signal: AbortSignal) => Promise<{ ok: boolean, answer: CredentialAnswer | null }>,
    signal: AbortSignal,
    timeoutMs = AUTHORIZATION_CHECK_TIMEOUT_MS,
  ) {
    // The new attempt owns the field from this moment: old verdicts are gone.
    const current = ++ticket
    if (!candidate) {
      phase.value = 'rejected'; message.value = MESSAGES.missing
      return false
    }
    phase.value = 'checking'; message.value = ''
    credential.value = candidate
    version.value++
    let timer: ReturnType<typeof setTimeout> | undefined
    const bounded = new Promise<{ state: 'timeout' }>(resolve => {
      timer = setTimeout(() => resolve({ state: 'timeout' }), timeoutMs)
    })
    // A read that never lands must not keep the verdict pending; it also must not
    // surface as an unhandled rejection once the timeout has already won the race.
    const read = Promise.resolve()
      .then(() => awaitRead(signal))
      .then(result => ({ state: 'settled' as const, ...result }))
      .catch(() => ({ state: 'settled' as const, ok: false, answer: null }))
    const outcome = await Promise.race([read, bounded])
    clearTimeout(timer)
    const { ok, answer, timedOut } = 'state' in outcome && outcome.state === 'timeout'
      ? { ok: false, answer: null, timedOut: true as const }
      : { ok: outcome.ok, answer: outcome.answer, timedOut: false as const }
    if (current !== ticket) return false
    // Proving the key needs three things: the read worked, it carried this key,
    // and the server said that key is authorized.
    if (ok && answer?.credential === candidate && answer.authorized === true) {
      verified.value = candidate
      draft.value = ''
      phase.value = 'idle'; message.value = ''
      return true
    }
    if (answer && answer.credential === candidate && !answer.authorized) fail('rejected', MESSAGES.rejected)
    else fail('unreachable', timedOut ? MESSAGES.timeout : MESSAGES.unreachable)
    return false
  }

  /** 某次读取的答案是否出自当前已确认的凭据。 */
  const isAuthorized = (answer: CredentialAnswer | null | undefined) => !!answer
    && !!verified.value
    && answer.credential === verified.value
    && answer.authorized === true

  /** 放弃正在进行的验证（离页），不改草稿与已确认凭据 —— 那条路走 `clear()`。 */
  function clearChecking() { ticket++ }

  /** 清除授权，也作废在途的验证：它晚到的答案不会再让人“已授权”。 */
  function clear() {
    ticket++
    draft.value = ''; credential.value = ''; verified.value = ''; phase.value = 'idle'; message.value = ''
    version.value++
  }

  return { draft, credential, verified, version, phase, message, verify, isAuthorized, clear, clearChecking, checking }
}
