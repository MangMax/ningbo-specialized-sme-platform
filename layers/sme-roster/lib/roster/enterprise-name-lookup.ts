/**
 * 复核队列的企业名称补全。
 *
 * #114 的 `ImpactRow` 只有 `enterpriseId`；这里只调用**现有只读**的
 * `GET /api/roster/enterprises/:id/profile`（轻量资料，不加载记录/事件/平台原文），
 * 不扫全库、不改接口。
 *
 * 约束：
 *  - 每页最多解析 25 个去重后的企业 ID；
 *  - 并发有界（默认 4）；
 *  - 结果只在调用方仍是当前页时应用，旧页的异步结果不得污染新页；
 *  - 失败只记录“名称未读取”，不猜测、不替换归并主体。
 */

export const ENTERPRISE_NAME_PAGE_LIMIT = 25
export const ENTERPRISE_NAME_CONCURRENCY = 4
export const ENTERPRISE_NAME_CACHE_LIMIT = 400

export interface EnterpriseNameLookupOptions {
  fetchName: (id: number, signal?: AbortSignal) => Promise<string | null>
  /** Bounded in-memory cache shared by queue pages. */
  cache?: Map<number, string>
  concurrency?: number
  signal?: AbortSignal
  /** The caller's page generation; false means the result is stale. */
  isCurrent?: () => boolean
  maxIds?: number
}

export interface EnterpriseNameLookupResult {
  names: Map<number, string>
  failed: Set<number>
  aborted: boolean
}

function boundedCacheSet(cache: Map<number, string>, id: number, name: string): void {
  cache.set(id, name)
  while (cache.size > ENTERPRISE_NAME_CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

export async function lookupEnterpriseNames(
  ids: readonly number[],
  options: EnterpriseNameLookupOptions,
): Promise<EnterpriseNameLookupResult> {
  const unique = [...new Set(ids.filter(id => Number.isSafeInteger(id) && id > 0))]
    .slice(0, options.maxIds ?? ENTERPRISE_NAME_PAGE_LIMIT)
  const names = new Map<number, string>()
  const failed = new Set<number>()
  const pending: number[] = []

  for (const id of unique) {
    const cached = options.cache?.get(id)
    if (cached) names.set(id, cached)
    else pending.push(id)
  }

  const isCurrent = () => !options.signal?.aborted && (options.isCurrent?.() ?? true)
  if (!pending.length) return { names, failed, aborted: false }

  const concurrency = Math.max(1, Math.min(options.concurrency ?? ENTERPRISE_NAME_CONCURRENCY, 8, pending.length))
  let cursor = 0
  let aborted = false

  async function worker(): Promise<void> {
    while (true) {
      if (!isCurrent()) { aborted = true; return }
      const index = cursor++
      if (index >= pending.length) return
      const id = pending[index]!
      try {
        const name = await options.fetchName(id, options.signal)
        // A stale page must not write into the new page's maps or cache.
        if (!isCurrent()) { aborted = true; return }
        if (typeof name === 'string' && name.trim()) {
          const value = name.trim()
          names.set(id, value)
          if (options.cache) boundedCacheSet(options.cache, id, value)
        } else {
          failed.add(id)
        }
      } catch {
        if (!isCurrent()) { aborted = true; return }
        failed.add(id)
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return { names, failed, aborted }
}
