import { onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue'

/** Poll only the mounted page. Aborting a read never sends server cancellation.
 * Retain the source key with the last good snapshot when a new target fails. */
export function useTaskPolling<T>(key: Readonly<Ref<string>>, load: (signal: AbortSignal) => Promise<T>) {
  const data = shallowRef<T | null>(null)
  const sourceKey = ref('')
  const loading = ref(false)
  const failed = ref(false)
  const retryIn = ref(0)
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  let generation = 0
  let failures = 0
  let active = false
  function stop() { generation++; clearTimeout(timer); controller?.abort() }
  async function refresh() {
    stop()
    if (!active || !key.value) return
    const current = generation, requested = key.value
    controller = new AbortController(); loading.value = true
    try {
      const result = await load(controller.signal)
      if (current !== generation) return
      data.value = result; sourceKey.value = requested; failed.value = false; failures = 0
    } catch {
      if (current !== generation) return
      failed.value = true; failures++
    } finally {
      if (current === generation) {
        loading.value = false
        retryIn.value = failures ? Math.min(30000, 2000 * 2 ** Math.min(failures - 1, 4)) : 3000
        timer = setTimeout(() => void refresh(), retryIn.value)
      }
    }
  }
  function hide() { active = false; stop(); loading.value = false }
  function show() { active = true; void refresh() }
  watch(key, () => { failures = 0; failed.value = false; void refresh() })
  onMounted(() => { window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show); show() })
  onBeforeUnmount(() => { hide(); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show) })
  return { data, sourceKey, loading, failed, retryIn, refresh }
}
