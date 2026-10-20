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
 * 凭据是否有效。所以“验证密钥”只能靠一次带该候选密钥的只读读取来完成，而且要
 * 判定的是**候选密钥自己那次请求**的答案。
 *
 * 边界只有这几条：
 *  - 每次提交自带一个**全新的** AbortController：上一次被作废不会连累这一次；
 *  - 读取方拿到的 signal 就是这次读取自己的 signal，超时就中止它；
 *  - 答案只认**发起时捕获**的候选密钥，不认“此刻”的凭据；
 *  - 凭据只有被证明之后才发布；失败只保留草稿，让人改一个字符就能重试；
 *  - `clear()` 作废在途的校验、中止它的读取、清掉内存里的凭据。
 */
export function useAdminAuthorization() {
  /** 输入框草稿。失败时不清空，让人直接改一个字符就能重试。 */
  const draft = ref('')
  /** 已确认有效的凭据；只有它会被用来发管理请求，也是授权徽标的依据。 */
  const credential = shallowRef('')
  /** 凭据版本：凭据变化时用它让列表重读一次。 */
  const version = ref(0)
  const phase = ref<'idle' | 'checking' | 'rejected' | 'unreachable'>('idle')
  const message = ref('')
  /** 每次验证/清除都会推进；晚到的回应据此判断自己是否已经过时。 */
  let ticket = 0
  /** 这次验证自己的读取；超时与清除都中止它。 */
  let controller: AbortController | null = null

  const checking = computed(() => phase.value === 'checking')

  /** 凭据只在真的变了的时候才动版本号：版本号一动，列表就会重读一次。 */
  function publishCredential(next: string) {
    if (credential.value === next) return
    credential.value = next
    version.value++
  }

  /**
   * 用候选密钥读一次并判定。
   *
   * `awaitRead` 收到的是**这次读取自己的 signal**：它必须用候选密钥发这次请求，
   * 并在回答里回报**同一个**候选密钥 —— 不能回报“此刻”的凭据，那会把上一把
   * 密钥（或已清除的凭据）的答案算到别人头上。
   */
  async function verify(
    candidate: string,
    awaitRead: (signal: AbortSignal) => Promise<{ ok: boolean, answer: CredentialAnswer | null }>,
    timeoutMs = AUTHORIZATION_CHECK_TIMEOUT_MS,
  ) {
    // The new attempt owns the field from this moment: old verdicts are gone.
    const current = ++ticket
    // 上一次验证的读取到此为止；它不能连累这一次。
    controller?.abort('superseded')
    const own = new AbortController()
    controller = own
    if (!candidate) {
      phase.value = 'rejected'; message.value = MESSAGES.missing
      return false
    }
    phase.value = 'checking'; message.value = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const bounded = new Promise<{ state: 'timeout' }>(resolve => {
      timer = setTimeout(() => resolve({ state: 'timeout' }), timeoutMs)
    })
    // A read that never lands must not keep the verdict pending; it also must not
    // surface as an unhandled rejection once the timeout has already won the race.
    const read = Promise.resolve()
      .then(() => awaitRead(own.signal))
      .then(result => ({ state: 'settled' as const, ...result }))
      .catch(() => ({ state: 'settled' as const, ok: false, answer: null }))
    const outcome = await Promise.race([read, bounded])
    clearTimeout(timer)
    const timedOut = 'state' in outcome && outcome.state === 'timeout'
    // 超时就是这次读取没等到答案：中止它，别让它继续挂在外面。
    if (timedOut) own.abort('timeout')
    if (current !== ticket) return false
    const { ok, answer } = timedOut ? { ok: false, answer: null } : outcome
    // Proving the key needs three things: the read worked, it carried this key,
    // and the server said that key is authorized.
    if (ok && answer?.credential === candidate && answer.authorized === true) {
      publishCredential(candidate)
      draft.value = ''
      phase.value = 'idle'; message.value = ''
      return true
    }
    publishCredential('')
    if (answer && answer.credential === candidate && !answer.authorized) {
      // 服务端明确说这把密钥未授权：就地说明，草稿留着让人改。
      phase.value = 'rejected'; message.value = MESSAGES.rejected
      return false
    }
    // 拿不到答案（超时 / 网络失败 / 答案不是这把密钥的）：如实说没拿到。
    phase.value = 'unreachable'; message.value = timedOut ? MESSAGES.timeout : MESSAGES.unreachable
    return false
  }

  /** 某次读取的答案是否出自当前已确认的凭据。 */
  const isAuthorized = (answer: CredentialAnswer | null | undefined) => !!answer
    && !!credential.value
    && answer.credential === credential.value
    && answer.authorized === true

  /** 清除授权：作废在途的校验、中止它的读取、清掉内存里的凭据。 */
  function clear() {
    ticket++
    controller?.abort('authorization cleared')
    controller = null
    draft.value = ''; phase.value = 'idle'; message.value = ''
    publishCredential('')
  }

  return { draft, credential, version, phase, message, verify, isAuthorized, clear, checking }
}
