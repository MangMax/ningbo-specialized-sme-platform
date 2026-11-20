import { onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue'

type TaskSignal = 'ready' | 'changed' | 'error'
const subscribers = new Set<(event: TaskSignal) => void>()
let stream: EventSource | undefined
let ready = false

function subscribe(listener: (event: TaskSignal) => void) {
  subscribers.add(listener)
  if (!stream && subscribers.size === 1 && typeof EventSource === 'function') {
    try {
      const connection = new EventSource('/api/task-center/events')
      stream = connection
      for (const event of ['ready', 'changed', 'error'] as const) {
        connection.addEventListener(event, () => {
          if (stream !== connection) return
          if (event !== 'ready' && !ready) return
          if (event === 'ready') ready = true
          if (event === 'error') ready = false
          for (const subscriber of subscribers) subscriber(event)
        })
      }
    } catch {
      // REST also serves installations without task notifications.
    }
  }
  return () => {
    subscribers.delete(listener)
    if (subscribers.size === 0) {
      const connection = stream
      stream = undefined
      ready = false
      connection?.close()
    }
  }
}

/** Reads task snapshots from REST. The stream only invalidates them. */
export function useTaskSnapshot<T>(
  key: Readonly<Ref<string>>,
  load: (signal: AbortSignal) => Promise<T>,
  nextExpiry?: (result: T) => number,
) {
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
  let unsubscribe: (() => void) | undefined
  let invalidated = false
  let expiry = Infinity

  function stop() {
    generation++
    clearTimeout(timer)
    controller?.abort()
    controller = undefined
    invalidated = false
    expiry = Infinity
  }

  function schedule() {
    clearTimeout(timer)
    const delay = failed.value || !ready && !invalidated
      ? retryIn.value
      : invalidated ? 250 : expiry - Date.now()
    if (Number.isFinite(delay)) {
      timer = setTimeout(() => { void refresh() }, Math.max(0, Math.min(delay, 2_147_483_647)))
    }
  }

  function notify(event: TaskSignal) {
    if (event === 'error') {
      if (!loading.value && !failed.value && !invalidated) schedule()
      return
    }
    if (invalidated) return
    invalidated = true
    if (!loading.value && !failed.value) schedule()
  }

  /** Explicit refresh and key changes replace the current request. */
  function refresh(): Promise<void> {
    stop()
    if (!active || !key.value) {
      unsubscribe?.()
      unsubscribe = undefined
      loading.value = false
      return Promise.resolve()
    }
    unsubscribe ??= subscribe(notify)
    return run(generation, key.value)
  }

  async function run(current: number, requested: string) {
    const own = new AbortController()
    const started = Date.now()
    controller = own
    loading.value = true
    try {
      const result = await load(own.signal)
      if (current !== generation) return
      data.value = { ...result }
      sourceKey.value = requested
      failed.value = false
      failures = 0
      const deadline = nextExpiry?.(result) ?? Infinity
      // A deadline crossed during the read still needs a new snapshot.
      if (deadline > started) expiry = deadline
    } catch {
      if (current !== generation) return
      failed.value = true
      failures++
    } finally {
      if (current === generation) {
        controller = undefined
        loading.value = false
        retryIn.value = failures ? Math.min(30000, 2000 * 2 ** Math.min(failures - 1, 4)) : 3000
        schedule()
      }
    }
  }

  function hide() { active = false; void refresh() }
  function show() { active = true; void refresh() }
  watch(key, () => { failures = 0; failed.value = false; void refresh() })
  onMounted(() => { window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show); show() })
  onBeforeUnmount(() => { hide(); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show) })
  return { data, sourceKey, loading, failed, retryIn, refresh }
}
