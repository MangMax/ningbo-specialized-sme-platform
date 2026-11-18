import { onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue'
import type { PlatformFilterOptions, PlatformFilterOptionsQuery } from '../../lib/platform/filter-options'

export function useRosterPlatformFilterOptions(source: PlatformFilterOptionsQuery['source'], view: Ref<'records' | 'isolated'>) {
  const options = shallowRef<PlatformFilterOptions>({ titles: [], declareKinds: [], years: [], statuses: [], batches: [], districts: [], validityDates: [] })
  const loading = ref(false)
  const error = ref(false)
  let generation = 0
  let controller: AbortController | undefined
  async function reload() {
    const request = ++generation
    controller?.abort()
    controller = new AbortController()
    loading.value = true
    error.value = false
    try {
      const value = await $fetch<PlatformFilterOptions>('/api/platform/filter-options', { query: { source, view: view.value }, signal: controller.signal, retry: 0 })
      if (request === generation) options.value = value
    } catch {
      if (request === generation) error.value = true
    } finally {
      if (request === generation) loading.value = false
    }
  }
  watch(view, () => { void reload() }, { immediate: true })
  onBeforeUnmount(() => { ++generation; controller?.abort() })
  return { options, loading, error, reload }
}
