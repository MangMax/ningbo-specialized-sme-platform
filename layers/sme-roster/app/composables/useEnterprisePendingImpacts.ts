import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { useQuery } from '@pinia/colada'
import type { CursorPage, ImpactRow } from '#sme-roster/lib/roster/evidence-review-ui'

export const enterprisePendingImpactParams = (enterpriseId: number) => ({
  enterpriseId,
  view: 'current' as const,
  state: 'pending' as const,
  limit: 25,
})

/**
 * 企业详情首屏的待复核摘要与「企业全部复核记录」共用同一个 Colada 缓存键。
 *
 * 两个消费者命中同一条缓存，就必须写入同一种形状：页面预取的结果也要带
 * `request` / `pageNumber`，否则展开清单时会读到缺少 `request` 的原始分页，
 * 在 `request.state` 处抛异常。查询函数只保留一份，避免两边再次漂移。
 */
export function useEnterprisePendingImpacts(enterpriseId: MaybeRefOrGetter<number | string>) {
  const pendingParams = computed(() => enterprisePendingImpactParams(Number(toValue(enterpriseId))))
  const query = useQuery({
    key: () => ['evidence-impacts', pendingParams.value],
    query: async ({ entry }) => {
      const request = entry.key[1] as Record<string, string | number>
      const page = await $fetch<CursorPage<ImpactRow>>('/api/roster/evidence-impacts', { query: request })
      return { ...page, request, pageNumber: 1 }
    },
    placeholderData: previous => previous,
  })
  return { ...query, pendingParams }
}
