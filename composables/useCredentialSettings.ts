import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
export interface CredentialStatus {
  configured: boolean
  source: string
  masked: string
  updatedAt: string | null
  hasSaved: boolean
}
export interface CredentialState { ocrToken: CredentialStatus }
export function useCredentialSettings() {
  const adminToken = ref('')
  const replacement = ref('')
  const state = ref<CredentialState | null>(null)
  const raw = ref('')
  const busy = ref(false)
  const message = ref('')
  const failed = ref(false)
  let generation = 0
  let controller: AbortController | undefined
  const canRead = computed(() => !!state.value?.ocrToken.configured)
  const request = <T>(url: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: object) => $fetch<T>(url, {
    method, body, headers: { authorization: `Bearer ${adminToken.value}` }, cache: 'no-store', signal: controller?.signal,
  })
  function clearMemory() {
    generation++; controller?.abort(); busy.value = false
    state.value = null; raw.value = ''; replacement.value = ''; message.value = ''; failed.value = false
  }
  watch(adminToken, clearMemory, { flush: 'sync' })
  function clearAuthorization() { clearMemory(); adminToken.value = '' }
  onMounted(() => window.addEventListener('pagehide', clearAuthorization))
  onBeforeUnmount(() => { window.removeEventListener('pagehide', clearAuthorization); clearAuthorization() })
  async function perform(action: () => Promise<void>) {
    if (busy.value || !adminToken.value.trim()) return
    const focused = typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null
    busy.value = true; failed.value = false; message.value = ''; controller = new AbortController()
    const current = generation
    try { await action() } catch {
      if (current === generation) { failed.value = true; message.value = '操作失败，请检查管理授权、网络与配置存储后重试。' }
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
      if (current === generation) { state.value = result; raw.value = '' }
    })
  }
  async function save() {
    if (!replacement.value.trim()) { failed.value = true; message.value = '请输入非空 OCR token。'; return }
    const current = generation
    await perform(async () => {
      const result = await request<CredentialState>('/api/settings/credentials', 'PATCH', { ocrToken: replacement.value })
      if (current === generation) { state.value = result; raw.value = ''; replacement.value = ''; message.value = '已保存。新任务将使用当前配置；尚未验证服务可用性。' }
    })
  }
  async function clear() {
    const current = generation
    await perform(async () => {
      const result = await request<CredentialState>('/api/settings/credentials', 'DELETE', { key: 'ocrToken' })
      if (current === generation) { state.value = result; raw.value = ''; message.value = '已清除页面保存值，当前有效来源见上方。' }
    })
  }
  async function reveal(copy = false) {
    if (!canRead.value) return
    if (!copy && raw.value) { raw.value = ''; return }
    const current = generation
    await perform(async () => {
      const result = await request<{ value: string }>('/api/settings/credentials/ocrToken/reveal', 'POST', {})
      if (current !== generation) return
      if (copy) {
        try { await navigator.clipboard.writeText(result.value); if (current === generation) message.value = '已复制完整 OCR token。' }
        catch { if (current === generation) { failed.value = true; message.value = '复制失败，请允许剪贴板访问后重试。' } }
      } else raw.value = result.value
    })
  }
  return { adminToken, replacement, state, raw, busy, failed, message, canRead, load, save, clear, reveal }
}
