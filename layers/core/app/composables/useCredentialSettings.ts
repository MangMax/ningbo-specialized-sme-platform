import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import { registeredCredentials, type CredentialKey } from '@/lib/app-modules'
export interface CredentialStatus {
  configured: boolean
  source: string
  masked: string
  updatedAt: string | null
  hasSaved: boolean
}
export type CredentialOperation = 'load' | 'save' | 'clear' | 'reveal' | 'copy'
type CredentialState = Record<CredentialKey, CredentialStatus>
const empty = () => Object.fromEntries(Array.from(registeredCredentials.keys(), key => [key, ''])) as Record<CredentialKey, string>
const label = (key: CredentialKey) => registeredCredentials.get(key)?.name ?? key
export function useCredentialSettings() {
  const replacement = ref(empty())
  const state = ref<CredentialState | null>(null)
  const raw = ref(empty())
  const pending = ref<{ type: CredentialOperation; key?: CredentialKey } | null>(null)
  const busy = computed(() => pending.value !== null)
  const message = ref('')
  const failed = ref(false)
  let generation = 0
  let controller: AbortController | undefined
  const request = <T>(url: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: object) => $fetch<T>(url, {
    method, body, cache: 'no-store', signal: controller?.signal,
  })
  function clearMemory() {
    generation++; controller?.abort(); pending.value = null
    state.value = null; raw.value = empty(); replacement.value = empty(); message.value = ''; failed.value = false
  }
  function resetPresentation() {
    raw.value = empty()
    message.value = ''
    failed.value = false
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
  async function perform(operation: NonNullable<typeof pending.value>, action: () => Promise<void>) {
    if (busy.value) return
    const focused = typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null
    pending.value = operation; failed.value = false; message.value = ''; controller = new AbortController()
    const current = generation
    try { await action() } catch {
      if (current === generation) {
        if (operation.type === 'copy') toast.error('复制失败，请检查网络后重试。')
        else { failed.value = true; message.value = '操作失败，请检查网络与配置存储后重试。' }
      }
    } finally {
      if (current === generation) {
        pending.value = null
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
    await perform({ type: 'load' }, async () => {
      const result = await request<CredentialState>('/api/settings/credentials', 'GET')
      if (current === generation) { state.value = result; raw.value = empty() }
    })
  }
  async function save(key: CredentialKey) {
    if (!replacement.value[key].trim()) { failed.value = true; message.value = `请输入非空${label(key)}。`; return }
    const current = generation
    await perform({ type: 'save', key }, async () => {
      const result = await request<CredentialState>('/api/settings/credentials', 'PATCH', { [key]: replacement.value[key] })
      if (current === generation) { state.value = result; raw.value[key] = ''; replacement.value[key] = ''; message.value = '已保存，无需重启；新任务将使用当前配置。' }
    })
  }
  async function clear(key: CredentialKey) {
    const current = generation
    await perform({ type: 'clear', key }, async () => {
      const result = await request<CredentialState>('/api/settings/credentials', 'DELETE', { key })
      if (current === generation) { state.value = result; raw.value[key] = ''; message.value = '已清除页面保存值。' }
    })
  }
  async function reveal(key: CredentialKey, copy = false) {
    if (!state.value?.[key]?.configured) return
    if (!copy && raw.value[key]) { raw.value[key] = ''; return }
    const current = generation
    await perform({ type: copy ? 'copy' : 'reveal', key }, async () => {
      const result = await request<{ value: string }>(`/api/settings/credentials/${key}/reveal`, 'POST', {})
      if (current !== generation) return
      if (copy) {
        try { await navigator.clipboard.writeText(result.value); if (current === generation) toast.success(`已复制完整${label(key)}。`) }
        catch { if (current === generation) toast.error('复制失败，请允许剪贴板访问后重试。') }
      } else raw.value[key] = result.value
    })
  }
  return { replacement, state, raw, busy, pending, failed, message, resetPresentation, load, save, clear, reveal }
}
