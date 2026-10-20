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
  /** Maps the controller `refresh` is about to supersede to its own signal. */
  const reads = new WeakMap<AbortController, AbortController>()
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
  const waiters: Array<{ generation: number, resolve: (value: ReadSettle) => void }> = []
  type ReadSettle = { generation: number, outcome: ReadOutcome, key: string }

  function publish(value: ReadSettle) {
    lastSettled = value
    // Resolve only the waits that ask for this read or a newer one; the rest keep
    // waiting (copy first: a waiter may re-enter and register another wait).
    const ready = waiters.filter(waiter => value.generation > waiter.generation)
    waiters.splice(0, waiters.length, ...waiters.filter(waiter => value.generation <= waiter.generation))
    for (const waiter of ready) waiter.resolve(value)
  }

  /** Resolves once a read that started after `after` has landed. */
  function nextSettle(after: number, signal?: AbortSignal): Promise<ReadSettle> {
    if (lastSettled && lastSettled.generation > after) return Promise.resolve(lastSettled)
    if (signal?.aborted) return Promise.resolve({ generation: after, outcome: 'skipped', key: '' })
    return new Promise((resolve) => {
      const waiter = { generation: after, resolve }
      waiters.push(waiter)
      signal?.addEventListener('abort', () => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        resolve({ generation: after, outcome: 'skipped', key: '' })
      }, { once: true })
    })
  }

  type ReadOutcome = 'ok' | 'failed' | 'skipped'

  /** Bumped by every explicit refresh/hide: a timer armed by an older cycle must
   *  not abort the read that replaced it. The signal aborted here is the one
   *  `refresh` just superseded, never the one a newer trigger already started. */
  function stop() { generation++; pollCycle++; clearTimeout(timer); if (controller) reads.get(controller)?.abort(); controller = undefined }

  /** Resolves with what this read did, so a caller can verify a credential
   *  (authorized) or tell "server said no" from "server was unreachable". */
  function refresh(): Promise<ReadOutcome> {
    stop()
    if (!active || !key.value) return Promise.resolve('skipped')
    const current = generation, requested = key.value
    const running = run(current, requested)
    inflight = { generation: current, promise: running }
    // `void run(...)` callers never await; publishing keeps both paths equal.
    void running.then(outcome => publish({ generation: current, outcome, key: requested }))
    return running
  }

  async function run(current: number, requested: string): Promise<ReadOutcome> {
    const own = new AbortController()
    // A superseded read must not keep its slot, and the newest controller is the
    // one this composable's timers/refresh govern.
    if (controller) reads.set(controller, own)
    reads.set(own, own)
    controller = own
    loading.value = true
    try {
      const result = await load(own.signal)
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
   * Wait for a read that starts from now on (the one a just-changed key triggers;
   * joining an older read would report the previous credential's answer) and
   * report its outcome together with **the snapshot that read stored**.
   *
   * `key` pins the wait to that read's own key: a payload from a different
   * credential/filter is not an answer about this one. Pass a signal to let the
   * caller abandon the wait (leaving the page, clearing authorization).
   */
  async function settle(signal?: AbortSignal): Promise<{ ok: boolean, data: T | null, key: string }> {
    const started = await nextSettle(generation, signal)
    if (signal?.aborted) return { ok: false, data: null, key: '' }
    // Only the read we waited for has that key; a newer one already replaced it.
    return { ok: started.outcome === 'ok' && started.key === key.value, data: data.value, key: started.key }
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
