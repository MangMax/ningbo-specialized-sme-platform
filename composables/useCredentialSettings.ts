import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
export interface CredentialStatus {
  configured: boolean
  source: string
  masked: string
  updatedAt: string | null
  hasSaved: boolean
}
export type CredentialKey = 'ocrToken' | 'miitCookie'
export interface CredentialState { ocrToken: CredentialStatus; miitCookie: CredentialStatus }
const labels = { ocrToken: 'OCR token', miitCookie: '平台 Cookie' }
const empty = () => ({ ocrToken: '', miitCookie: '' })
export function useCredentialSettings() {
  const replacement = ref(empty())
  const state = ref<CredentialState | null>(null)
  const raw = ref(empty())
  const busy = ref(false)
  const message = ref('')
  const failed = ref(false)
  let generation = 0
  let controller: AbortController | undefined
  const canRead = computed(() => ({ ocrToken: !!state.value?.ocrToken.configured, miitCookie: !!state.value?.miitCookie?.configured }))
  const request = <T>(url: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: object) => $fetch<T>(url, {
    method, body, cache: 'no-store', signal: controller?.signal,
  })
  function clearMemory() {
    generation++; controller?.abort(); busy.value = false
    state.value = null; raw.value = empty(); replacement.value = empty(); message.value = ''; failed.value = false
  }
  function restorePage(event: PageTransitionEvent) { if (event.persisted) void load() }
  onMounted(() => {
    window.addEventListener('pagehide', clearMemory)
    window.addEventListener('pageshow', restorePage)
    void load()
  })
  onBeforeUnmount(() => {
    window.removeEventListener('pagehide', clearMemory)
    window.removeEventListener('pageshow', restorePage)
    clearMemory()
  })
  async function perform(action: () => Promise<void>) {
    if (busy.value) return
    const focused = typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null
    busy.value = true; failed.value = false; message.value = ''; controller = new AbortController()
    const current = generation
    try { await action() } catch {
      if (current === generation) { failed.value = true; message.value = '操作失败，请检查网络与配置存储后重试。' }
    } finally {
      if (current === generation) {
        busy.value = false
        await nextTick()
        if (current === generation && focused?.isConnected && (document.activeElement === document.body || (document.activeElement === focused && focused.matches(':disabled')))) {
          const target = focused.matches(':disabled') ? focused.closest('section')?.querySelector<HTMLElement>('input') : focused
          target?.focus()
        }
      }
    }
  }
  async function load() {
    const current = generation
    await perform(async () => {
      const result = await request<CredentialState>('/api/settings/credentials', 'GET')
      if (current === generation) { state.value = result; raw.value = empty() }
    })
  }
  async function save(key: CredentialKey = 'ocrToken') {
    if (!replacement.value[key].trim()) { failed.value = true; message.value = `请输入非空${labels[key]}。`; return }
    const current = generation
    await perform(async () => {
      const result = await request<CredentialState>('/api/settings/credentials', 'PATCH', { [key]: replacement.value[key] })
      if (current === generation) { state.value = result; raw.value[key] = ''; replacement.value[key] = ''; message.value = '已保存。新任务将使用当前配置；尚未验证服务可用性。' }
    })
  }
  async function clear(key: CredentialKey = 'ocrToken') {
    const current = generation
    await perform(async () => {
      const result = await request<CredentialState>('/api/settings/credentials', 'DELETE', { key })
      if (current === generation) { state.value = result; raw.value[key] = ''; message.value = '已清除页面保存值，当前有效来源见上方。' }
    })
  }
  async function reveal(key: CredentialKey = 'ocrToken', copy = false) {
    if (!canRead.value[key]) return
    if (!copy && raw.value[key]) { raw.value[key] = ''; return }
    const current = generation
    await perform(async () => {
      const result = await request<{ value: string }>(`/api/settings/credentials/${key}/reveal`, 'POST', {})
      if (current !== generation) return
      if (copy) {
        try { await navigator.clipboard.writeText(result.value); if (current === generation) message.value = `已复制完整${labels[key]}。` }
        catch { if (current === generation) { failed.value = true; message.value = '复制失败，请允许剪贴板访问后重试。' } }
      } else raw.value[key] = result.value
    })
  }
  return { replacement, state, raw, busy, failed, message, canRead, load, save, clear, reveal }
}
