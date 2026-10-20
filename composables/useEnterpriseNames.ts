import { onScopeDispose, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { lookupEnterpriseNames } from '~~/lib/roster/enterprise-name-lookup'

interface NameSourceRow {
  enterpriseId: number
  /** 归并历史项只保留原坐标，绝不解析为幸存者名称。 */
  lineage?: string
}

/**
 * 模块级缓存只在浏览器中生效，键是企业 ID；容量由 lookup 层限制。
 * 测试可通过 `resetEnterpriseNameCache()` 清空。
 */
const clientNameCache = new Map<number, string>()

export function resetEnterpriseNameCache(): void {
  clientNameCache.clear()
}

export function useEnterpriseNames(rows: MaybeRefOrGetter<readonly NameSourceRow[]>) {
  const names = shallowRef<Record<number, string>>({})
  const unavailable = shallowRef<number[]>([])
  const loading = shallowRef(false)
  const revision = shallowRef(0)

  let generation = 0
  let controller: AbortController | null = null

  watch(
    () => `${revision.value}|${toValue(rows).map(row => `${row.enterpriseId}:${row.lineage ?? ''}`).join(',')}`,
    async () => {
      // SSR 不逐行读取资料；客户端挂载后补全，首屏仍以 ID 作为可读坐标。
      if (typeof window === 'undefined') return
      const source = toValue(rows).filter(row => row.lineage !== 'merged')
      const ids = [...new Set(source.map(row => row.enterpriseId))]
      generation += 1
      const current = generation
      controller?.abort()
      controller = new AbortController()

      const seeded: Record<number, string> = {}
      for (const id of ids) {
        const cached = clientNameCache.get(id)
        if (cached) seeded[id] = cached
      }
      names.value = seeded
      unavailable.value = []
      loading.value = ids.length > 0

      const result = await lookupEnterpriseNames(ids, {
        cache: clientNameCache,
        signal: controller.signal,
        isCurrent: () => current === generation,
        fetchName: async (id, signal) => {
          const payload = await $fetch<{ profile?: { enterpriseId?: number; name?: string } }>(
            `/api/roster/enterprises/${id}/profile`,
            { signal },
          )
          const profile = payload?.profile
          // The response must describe the exact ID we asked for; never borrow a neighbour.
          return profile && profile.enterpriseId === id && typeof profile.name === 'string'
            ? profile.name
            : null
        },
      })

      if (current !== generation) return
      loading.value = false
      if (result.aborted) return
      names.value = { ...seeded, ...Object.fromEntries(result.names) }
      unavailable.value = [...result.failed]
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    generation += 1
    controller?.abort()
  })

  function nameFor(id: number): string | null {
    return names.value[id] ?? null
  }

  function unavailableFor(id: number): boolean {
    return unavailable.value.includes(id)
  }

  /** Explicit retry for a failed profile read; does not refetch the queue itself. */
  function retry(): void {
    revision.value += 1
  }

  return { names, unavailable, loading, nameFor, unavailableFor, retry }
}
