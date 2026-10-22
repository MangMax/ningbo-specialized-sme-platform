import { onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue'

export const logBrowserHeaders = Object.freeze({ 'x-log-browser': '1' })
export function logErrorCode(error: unknown): string {
  const code = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
  return code && Object.hasOwn(logErrors, code) ? code : 'logging_unavailable'
}
const logErrors: Record<string, string> = {
  log_access_denied: '当前未开放日志页面访问。请联系维护者。',
  invalid_log_input: '筛选或策略值无效，请核对范围和标识。',
  log_not_found: '日志不存在或已过期、清理。',
  policy_capacity_pending:
    '容量收缩尚未完成，原策略仍生效。部分清理可能已完成；请核对当前策略后再次提交，或先清理已确认的范围。',
  logging_unavailable: '日志服务暂不可用，请重试。',
  logging_busy: '日志服务繁忙，请稍后重试。'
}
export const logErrorMessage = (code: string) => logErrors[code] ?? logErrors.logging_unavailable!

/** Mounted, explicit reads only. Old requests cannot replace a newer target,
 * even when the transport ignores AbortSignal. Keep provenance with retained data. */
export function useLogRead<T>(
  key: Readonly<Ref<string>>,
  load: (target: string, signal: AbortSignal) => Promise<T>
) {
  const data = shallowRef<T | null>(null),
    sourceKey = ref(''),
    loading = ref(false),
    error = ref('')
  let active = false,
    generation = 0,
    controller: AbortController | undefined
  async function refresh() {
    const own = ++generation,
      target = key.value
    controller?.abort()
    controller = new AbortController()
    error.value = ''
    loading.value = false
    if (!active || !target) return
    loading.value = true
    try {
      const result = await load(target, controller.signal)
      if (active && own === generation && target === key.value) {
        data.value = result
        sourceKey.value = target
      }
    } catch (cause) {
      if (active && own === generation && target === key.value) error.value = logErrorCode(cause)
    } finally {
      if (active && own === generation && target === key.value) loading.value = false
    }
  }
  watch(key, () => {
    void refresh()
  })
  onMounted(() => {
    active = true
    void refresh()
  })
  onBeforeUnmount(() => {
    active = false
    generation++
    controller?.abort()
  })
  return { data, sourceKey, loading, error, refresh }
}
