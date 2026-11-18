import { useRosterCorrespondenceReadback } from './useRosterCorrespondenceReadback'
import { ref, watch, type MaybeRefOrGetter, toValue } from 'vue'
import { sourcePublishedNamesUnavailable, correspondenceSourceUrl, type SourceKind, type SourceResponse } from '#sme-roster/lib/roster/correspondence-view'

/** Keeps the last successful source visible while a retry or target request fails. */
export function useRosterRecordSource(kind: MaybeRefOrGetter<SourceKind>, id: MaybeRefOrGetter<number>, active: MaybeRefOrGetter<boolean> = true) {
  const displayed = ref<SourceResponse | null>(null)
  const displayedKey = ref('')
  const loading = ref(false)
  const error = ref(false)
  let serial = 0
  const requestedKey = () => `${toValue(kind)}:${toValue(id)}`
  async function load() {
    if (!toValue(active)) return
    const key = requestedKey()
    const request = ++serial
    loading.value = true
    error.value = false
    try {
      const result = await $fetch<SourceResponse>(correspondenceSourceUrl(toValue(kind), toValue(id)))
      if (request !== serial) return
      if (sourcePublishedNamesUnavailable(result)) throw new Error('Official published names unavailable')
      displayed.value = result
      displayedKey.value = key
    } catch {
      if (request === serial) error.value = true
    } finally {
      if (request === serial) loading.value = false
    }
  }
  useRosterCorrespondenceReadback(async () => { await load(); return !error.value })
  watch([() => toValue(kind), () => toValue(id), () => toValue(active)], ([,, enabled]) => {
    if (enabled) void load()
    else serial++
  }, { immediate: true })
  return { displayed, displayedKey, requestedKey, loading, error, retry: load }
}
