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
  /** The read carrying the latest generation, so a later caller can await the
   *  same answer instead of superseding it. */
  let inflight: { generation: number, promise: Promise<ReadOutcome> } | null = null
  /** Data listeners are notified after Vue flushed, never synchronously, so a
   *  handler that is itself running inside the render queue cannot deadlock. */
  let lastSettled: ReadSettle | null = null
  const waiters: Array<(value: ReadSettle) => void> = []
  type ReadSettle = { generation: number, outcome: ReadOutcome }

  function publish(value: ReadSettle) {
    lastSettled = value
    // Copy: a waiter may re-enter and register another wait.
    for (const resolve of waiters.splice(0)) resolve(value)
  }

  function nextSettle(after: number): Promise<ReadSettle> {
    if (lastSettled && lastSettled.generation > after) return Promise.resolve(lastSettled)
    return new Promise(resolve => waiters.push(resolve))
  }

  type ReadOutcome = 'ok' | 'failed' | 'skipped'

  function stop() { generation++; pollCycle++; clearTimeout(timer); controller?.abort() }

  /** Resolves with what this read did, so a caller can verify a credential
   *  (authorized) or tell "server said no" from "server was unreachable". */
  function refresh(): Promise<ReadOutcome> {
    stop()
    if (!active || !key.value) return Promise.resolve('skipped')
    const current = generation, requested = key.value
    const running = run(current, requested)
    inflight = { generation: current, promise: running }
    // `void run(...)` callers never await; publishing keeps both paths equal.
    void running.then(outcome => publish({ generation: current, outcome }))
    return running
  }

  async function run(current: number, requested: string): Promise<ReadOutcome> {
    controller = new AbortController()
    loading.value = true
    try {
      const result = await load(controller.signal)
      if (current !== generation) return 'skipped'
      // `shallowRef` compares by identity: wrap each answer so a refresh whose
      // payload is an equal-by-reference object still marks state as changed.
      data.value = { ...result }; sourceKey.value = requested; failed.value = false; failures = 0
      return 'ok'
    } catch {
      if (current !== generation) return 'skipped'
      failed.value = true; failures++
      return 'failed'
    } finally {
      if (current === generation) {
        loading.value = false
        retryIn.value = failures ? Math.min(30000, 2000 * 2 ** Math.min(failures - 1, 4)) : 3000
        const armed = pollCycle
        timer = setTimeout(() => { if (armed === pollCycle) void refresh() }, retryIn.value)
      }
    }
  }

  /**
   * Wait for the read of the current generation and report its outcome with the
   * snapshot it stored. Used where a caller must know what a specific credential
   * read answered (authorization verification).
   */
  async function settle(): Promise<{ ok: boolean, data: T | null }> {
    // Wait for the *next* read that starts at or after this point, i.e. the one a
    // just-changed key triggers; joining an older read would report the previous
    // credential's answer.
    const started = await nextSettle(generation)
    return { ok: started.outcome === 'ok', data: data.value }
  }

  function hide() { active = false; stop(); loading.value = false }
  function show() { active = true; void refresh() }
  watch(key, () => { failures = 0; failed.value = false; inflight = null; void refresh() })
  // `show()` performs the first read, so a key that is already complete when the
  // component mounts (deep link, first render) still loads.
  onMounted(() => { window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show); show() })
  onBeforeUnmount(() => { hide(); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show) })
  return { data, sourceKey, loading, failed, retryIn, refresh, settle }
}
