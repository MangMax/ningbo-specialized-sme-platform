import { computed, ref, shallowRef } from 'vue'

/** What a read told us about the credential it carried. */
export type CredentialAnswer = { credential: string, authorized: boolean }

/**
 * 页面内的管理操作授权（只在本页内存，离页即清）。
 *
 * 服务端的只读 GET 永远 200，只在响应体 `authorized` 字段里说明**本次请求**的
 * 凭据是否有效。所以“验证密钥”只能靠一次带该候选密钥的只读读取来完成，并且要
 * 判定的是**候选密钥自己那次请求**的答案，而不是上一把已提交密钥的结果。
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

  /**
   * 用候选密钥读一次并判定。
   *
   * 改变凭据会改变读取键，轮询随即用新凭据开始一次读取 —— 这里**只等那一次**。
   * 不要再调 refresh()：那只会在它之前插队并中止它。
   * 也不要 await nextTick()：提交处理器本身在渲染队列里，等渲染可能等不到。
   */
  async function verify(
    candidate: string,
    awaitRead: () => Promise<{ ok: boolean, answer: CredentialAnswer | null }>,
  ) {
    if (!candidate) {
      phase.value = 'rejected'; message.value = '请输入管理员提供的 API 管理密钥。'
      return false
    }
    phase.value = 'checking'; message.value = ''
    credential.value = candidate
    version.value++
    const { ok, answer } = await awaitRead()
    // Proving the key needs three things: the read worked, it carried this key,
    // and the server said that key is authorized.
    if (ok && answer?.credential === candidate && answer.authorized === true) {
      verified.value = candidate
      draft.value = ''
      phase.value = 'idle'; message.value = ''
      return true
    }
    // 就地失败：草稿是唯一记录输入的地方，保留它；凭据则清掉。
    credential.value = ''
    verified.value = ''
    version.value++
    if (!ok) { phase.value = 'unreachable'; message.value = '暂时无法连接服务端校验授权，密钥已保留；请稍后重试或再次点“应用授权”。' }
    else { phase.value = 'rejected'; message.value = '密钥未通过校验（服务端未授权）。请向管理员核对后重试；输入框已保留，可直接修正。' }
    return false
  }

  /** 某次读取的答案是否出自当前已确认的凭据。 */
  const isAuthorized = (answer: CredentialAnswer | null | undefined) => !!answer
    && !!verified.value
    && answer.credential === verified.value
    && answer.authorized === true

  function clear() {
    draft.value = ''; credential.value = ''; verified.value = ''; phase.value = 'idle'; message.value = ''
    version.value++
  }

  return { draft, credential, verified, version, phase, message, verify, isAuthorized, clear, checking: computed(() => phase.value === 'checking') }
}
