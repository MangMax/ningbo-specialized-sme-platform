import { onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue'

/** Poll only the mounted page. Aborting a read never sends server cancellation.
 * Retain the source key with the last good snapshot when a new target fails.
 *
 * Polling replaces `data` with a new snapshot but never touches focus. Views that
 * reveal content on mount must scroll/focus only when their own key changes,
 * because a poll lands every few seconds while a person may be reading. */
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
  /** Bumped by every explicit refresh/hide: a timer armed by an older cycle must
   *  not abort the read that replaced it. */
  let pollCycle = 0

  /** Aborts the read in flight and forgets it. The signal aborted here is the one
   *  this composable started, never one a newer trigger already owns. */
  function stop() { generation++; pollCycle++; clearTimeout(timer); controller?.abort(); controller = undefined }

  /** Reads again for the current key. Resolves when that read has landed. */
  function refresh(): Promise<void> {
    stop()
    if (!active || !key.value) return Promise.resolve()
    return run(generation, key.value)
  }

  async function run(current: number, requested: string) {
    const own = new AbortController()
    controller = own
    loading.value = true
    try {
      const result = await load(own.signal)
      if (current !== generation) return
      // `shallowRef` compares by identity: wrap each answer so a refresh whose
      // payload is an equal-by-reference object still marks state as changed.
      data.value = { ...result }; sourceKey.value = requested; failed.value = false; failures = 0
    } catch {
      if (current !== generation) return
      failed.value = true; failures++
    } finally {
      if (current === generation) {
        loading.value = false
        retryIn.value = failures ? Math.min(30000, 2000 * 2 ** Math.min(failures - 1, 4)) : 3000
        const armed = pollCycle
        timer = setTimeout(() => { if (armed === pollCycle) void refresh() }, retryIn.value)
      }
    }
  }

  function hide() { active = false; stop(); loading.value = false }
  function show() { active = true; void refresh() }
  watch(key, () => { failures = 0; failed.value = false; void refresh() })
  // `show()` performs the first read, so a key that is already complete when the
  // component mounts (deep link, first render) still loads.
  onMounted(() => { window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show); show() })
  onBeforeUnmount(() => { hide(); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show) })
  return { data, sourceKey, loading, failed, retryIn, refresh }
}
