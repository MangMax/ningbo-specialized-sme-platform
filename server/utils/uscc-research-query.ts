/**
 * RL-06 两个读侧端点的**入参解析**（清单筛选 + 公开来源 claim）。
 *
 * 与 `roster-read-query.ts` 同一取舍：取值的合法性**不静默放过** —— 不在字典里的 `title`
 * 一律报错，否则筛选会悄悄失效（使用者只看到空结果而不知道为什么）。
 * 差别是这里**不 import h3**：解析结果是 `{ok}` 结果对象，由路由翻成 400，
 * 于是同一份解析能在裸 node 的测试里直接跑（见 `tests/uscc-research.test.ts`）。
 */
import type { UsccChecklistFilter, UsccResearchClaim } from '../../lib/roster/uscc-research'
import { TITLE_ORDER } from '../../lib/labels'
import { MAX_PAGE_SIZE } from '../../lib/query'

export type UsccQueryParse =
  | {
      ok: true
      /** 清单分页筛选。 */
      filter: UsccChecklistFilter
      /** 计划筛选（计划不分页）。 */
      planFilter: Omit<UsccChecklistFilter, 'page' | 'pageSize'>
      /** 公开来源查证结果（GET 恒为空数组）。 */
      claims: UsccResearchClaim[]
    }
  | { ok: false; message: string }

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === 'string' && item.trim())
    return typeof first === 'string' ? first.trim() : undefined
  }
  return undefined
}

/** `a,b` 或重复参数 → 去重后的数组。与总表筛选的 `parseCsvQuery` 同一读法。 */
function csv(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const items = raw
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter(Boolean)
  return items.length ? [...new Set(items)] : undefined
}

function intParam(value: unknown, fallback: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(Math.floor(n), max)
}

/** GET 的 query → 清单筛选（无 claims）。 */
export function parseUsccChecklistQuery(query: Record<string, unknown>): UsccQueryParse {
  const title = csv(query.title)
  if (title && title.some((code) => !TITLE_ORDER.includes(code))) {
    return { ok: false, message: `Unknown title; expected ${TITLE_ORDER.join(', ')}` }
  }
  const planFilter: Omit<UsccChecklistFilter, 'page' | 'pageSize'> = {
    ...(str(query.q) ? { q: str(query.q) } : {}),
    ...(title ? { title } : {}),
    ...(str(query.district) ? { district: str(query.district) } : {}),
  }
  return {
    ok: true,
    planFilter,
    claims: [],
    filter: {
      ...planFilter,
      page: intParam(query.page, 1, Number.MAX_SAFE_INTEGER),
      pageSize: intParam(query.pageSize, 50, MAX_PAGE_SIZE),
    },
  }
}

/**
 * POST 的 body → 同一套筛选 + `claims`（公开来源查证结果）。
 *
 * `claims` 只做**形状**检查（是否是数组、每项是否有 `uscc`）：语义判定（格式/校验位、
 * 三要素、地区、是否被占用）**只在 `planUsccResearch` 一处**做，免得两边规则漂移。
 */
export function parseUsccResearchBody(body: unknown): UsccQueryParse {
  if (body != null && (typeof body !== 'object' || Array.isArray(body))) {
    return { ok: false, message: '请求体必须是 JSON 对象' }
  }
  const record = (body ?? {}) as Record<string, unknown>
  const base = parseUsccChecklistQuery(record)
  if (!base.ok) return base
  const raw = record.claims
  if (raw == null) return base
  if (!Array.isArray(raw)) return { ok: false, message: 'claims 必须是数组' }
  const claims: UsccResearchClaim[] = []
  for (const [index, item] of raw.entries()) {
    if (item == null || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, message: `claims[${index}] 必须是对象` }
    }
    const claim = item as Record<string, unknown>
    if (typeof claim.uscc !== 'string' && typeof claim.uscc !== 'number') {
      return { ok: false, message: `claims[${index}].uscc 必填` }
    }
    if (claim.enterpriseId == null && !str(claim.enterpriseName)) {
      return { ok: false, message: `claims[${index}] 需要 enterpriseId 或 enterpriseName` }
    }
    const source = (claim.source ?? {}) as Record<string, unknown>
    claims.push({
      ...(typeof claim.enterpriseId === 'number' ? { enterpriseId: Math.trunc(claim.enterpriseId) } : {}),
      ...(str(claim.enterpriseName) ? { enterpriseName: str(claim.enterpriseName) } : {}),
      uscc: String(claim.uscc),
      source: {
        url: typeof source.url === 'string' ? source.url : '',
        checkedOn: typeof source.checkedOn === 'string' ? source.checkedOn : '',
        basis: typeof source.basis === 'string' ? source.basis : '',
        name: typeof source.name === 'string' ? source.name : '',
        region: typeof source.region === 'string' ? source.region : null,
      },
      note: typeof claim.note === 'string' ? claim.note : null,
    })
  }
  return { ...base, claims }
}
