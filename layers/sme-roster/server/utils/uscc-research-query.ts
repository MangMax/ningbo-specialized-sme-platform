import { normalizeUsccVerdicts, type UsccVerdictFile } from './uscc-verdicts'
/**
 * RL-06 两个读侧端点的**入参解析**（清单筛选 + 公开来源 claim）。
 *
 * 与 `roster-read-query.ts` 同一取舍：取值的合法性**不静默放过** —— 不在字典里的 `title`
 * 一律报错，否则筛选会悄悄失效（使用者只看到空结果而不知道为什么）。
 * 差别是这里**不 import h3**：解析结果是 `{ok}` 结果对象，由路由翻成 400，
 * 于是同一份解析能在裸 node 的测试里直接跑（见 `tests/uscc-research.test.ts`）。
 */
import type { UsccChecklistFilter, UsccPlatformClaim, UsccResearchClaim } from '../../lib/roster/uscc-research'
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
      /** 平台证据认领（GET 恒为空数组）。 */
      platformClaims: UsccPlatformClaim[]
      /** 只处理这些企业（按 id）；不传则「给了认领就只判认领里的企业」。 */
      enterpriseIds?: number[]
      /**
       * **批次判断代理的判定文件原文**（`{ file, value }` 依次成对）。
       *
       * 为什么把原文整份收下来、而不是让调用方自己算成认领：与 RL-14 的脚本同一个取舍 ——
       * 「哪些条目能被采纳」是**服务端**的判定（`normalizeUsccVerdicts`），脚本只搬运文件。
       * 于是判定规则只有一处，脚本里不可能漂。
       */
      verdictFiles: Array<{ file: string; value: Record<string, unknown> }>
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
    platformClaims: [],
    verdictFiles: [],
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
  // ⚠️ 这里**不能早退**：`claims` 缺席只是「这一轮没有公开来源结果」，后面还有
  // `verdictFiles` / `platformClaims` 要解析。原来写成 `if (raw == null) return base`
  // 会让「只交判定文件」的那一轮**静默丢掉整份文件**（判定文件里 100 多条全被忽略，
  // 而接口照样 200）。缺席就是空数组，往下走。
  const raw = record.claims
  if (raw != null && !Array.isArray(raw)) return { ok: false, message: 'claims 必须是数组' }
  const claims: UsccResearchClaim[] = []
  for (const [index, item] of (Array.isArray(raw) ? raw : []).entries()) {
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

  const rawIds = record.enterpriseIds
  if (rawIds != null && (!Array.isArray(rawIds) || rawIds.some((id) => typeof id !== 'number' || !Number.isInteger(id)))) {
    return { ok: false, message: 'enterpriseIds 必须是整数数组' }
  }
  const enterpriseIds = Array.isArray(rawIds) ? (rawIds as number[]) : undefined

  const verdictFiles: Array<{ file: string; value: Record<string, unknown> }> = []
  const rawFiles = record.verdictFiles
  if (rawFiles != null) {
    if (!Array.isArray(rawFiles)) return { ok: false, message: 'verdictFiles 必须是数组' }
    for (const [index, entry] of rawFiles.entries()) {
      if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
        return { ok: false, message: `verdictFiles[${index}] 必须是对象` }
      }
      const row = entry as Record<string, unknown>
      const file = str(row.file)
      const value = row.value
      if (!file) return { ok: false, message: `verdictFiles[${index}].file 必填` }
      if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, message: `verdictFiles[${index}].value 必须是对象` }
      }
      verdictFiles.push({ file, value: value as Record<string, unknown> })
    }
  }

  const rawPlatform = record.platformClaims
  if (rawPlatform == null) return { ...base, claims, platformClaims: [], verdictFiles, enterpriseIds }
  if (!Array.isArray(rawPlatform)) return { ok: false, message: 'platformClaims 必须是数组' }
  const platformClaims: UsccPlatformClaim[] = []
  for (const [index, item] of rawPlatform.entries()) {
    if (item == null || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, message: `platformClaims[${index}] 必须是对象` }
    }
    const claim = item as Record<string, unknown>
    if (typeof claim.uscc !== 'string' && typeof claim.uscc !== 'number') {
      return { ok: false, message: `platformClaims[${index}].uscc 必填` }
    }
    if (claim.enterpriseId == null && !str(claim.enterpriseName)) {
      return { ok: false, message: `platformClaims[${index}] 需要 enterpriseId 或 enterpriseName` }
    }
    const rawEvidence = claim.evidence
    if (rawEvidence != null && !Array.isArray(rawEvidence)) {
      return { ok: false, message: `platformClaims[${index}].evidence 必须是数组` }
    }
    const evidence = (Array.isArray(rawEvidence) ? rawEvidence : []).flatMap((entry) => {
      if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return []
      const row = entry as Record<string, unknown>
      if (row.interface !== 'business_list' && row.interface !== 'apply_list') return []
      const sequenceNo = Number(row.sequenceNo)
      if (!Number.isInteger(sequenceNo) || sequenceNo < 1) return []
      if (typeof row.nameRaw !== 'string' || !row.nameRaw) return []
      return [
        {
          interface: row.interface as 'business_list' | 'apply_list',
          rdjb: typeof row.rdjb === 'string' ? row.rdjb : '',
          sequenceNo,
          relationKey: typeof row.relationKey === 'string' ? row.relationKey : null,
          nameRaw: row.nameRaw,
          status: typeof row.status === 'string' ? row.status : null,
          usccRaw: typeof row.usccRaw === 'string' ? row.usccRaw : null,
        },
      ]
    })
    platformClaims.push({
      ...(typeof claim.enterpriseId === 'number' ? { enterpriseId: Math.trunc(claim.enterpriseId) } : {}),
      ...(str(claim.enterpriseName) ? { enterpriseName: str(claim.enterpriseName) } : {}),
      uscc: String(claim.uscc),
      evidence,
      reason: typeof claim.reason === 'string' ? claim.reason : null,
      batchRef: typeof claim.batchRef === 'string' ? claim.batchRef : null,
      observedAt: typeof claim.observedAt === 'string' ? claim.observedAt : null,
    })
  }
  return { ...base, claims, platformClaims, verdictFiles, enterpriseIds }
}

export function prepareUsccClaims(parsed: Extract<UsccQueryParse, { ok: true }>) {
  const ingest = parsed.verdictFiles.length
    ? normalizeUsccVerdicts(parsed.verdictFiles.map(({ file, value }) => ({ file, value: value as UsccVerdictFile })))
    : null
  return {
    claims: {
      ...(parsed.enterpriseIds ? { enterpriseIds: parsed.enterpriseIds } : {}),
      claims: [...parsed.claims, ...(ingest?.claims ?? [])],
      platformClaims: [...parsed.platformClaims, ...(ingest?.platformClaims ?? [])],
    },
    verdicts: ingest ? {
      batches: ingest.batches,
      accepted: ingest.platformClaims.length,
      foundClaims: ingest.claims.length,
      untouched: ingest.untouched,
      problems: ingest.problems,
    } : null,
  }
}
