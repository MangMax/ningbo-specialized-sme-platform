/**
 * **缺统一社会信用代码企业的库内核心词检索**（RL-06）—— 纯函数与契约类型。
 *
 * ── 这一层解决什么 ────────────────────────────────────────────────────────
 * 平台两接口都按 `tyshxydm` 精确取数（`businessList` **只认** `rdjb` + `tyshxydm`；
 * `queryList` 认 `tyshxydm` **或** `qymc`），所以一家**没有统代**的企业无法直接查平台。
 * 用户 2026-10-16 给的方法顺序是「**先库内、后平台**」：
 *
 *   ① 从公布名抓核心词（去区划前缀「宁波/宁波市/浙江/浙江省」+ 去组织形式后缀
 *      「有限公司/股份有限公司/有限责任公司/公司」）——`宁波上航测绘有限公司` → `上航测绘`；
 *   ② 在**我们自己的库**里搜这个词（企业现名 **+ 已确认曾用名**——曾用名表就是匹配字典的一部分）；
 *   ③ 代理从命中的候选里判断哪些最可能是同一家，**取它的统一社会信用代码**；
 *   ④ 拿这个统代**去平台按统代查**（`businessList` rdjb=1/2/3 + `queryList`）验证；
 *   ⑤ 关系里 `qymc` **逐字等于**公布名 ⇒ 独立原始证据成立 ⇒ 回填统代 + 建曾用名。
 *
 * 库内搜不出时才退到辅助手段：平台 `queryList?qymc=<名称>` 子串反查。
 *
 * ── 红线（用户与父代理都点过名）──────────────────────────────────────────
 * **不做模糊推断、不做相似度打分、不按名合并**。名称（核心词）**只用来决定「去问哪个统代」**；
 * 这一层产出的永远是**候选**，身份由平台的原始关系行拍板（见
 * `server/utils/uscc-research.ts` 的证据查找）。所以本文件里没有任何打分、没有编辑距离、
 * 没有「相似即同一家」的判断。
 */

// ---------------------------------------------------------------------------
// 核心词
// ---------------------------------------------------------------------------

/**
 * 区划前缀 —— 公布名里最容易被改写的一段。按**长前缀优先**匹配，只去一次。
 *
 * 为什么含「浙江」：实测同一家公司在不同年份的写法会在「宁波…」与「浙江…」之间切换
 * （如 `宁波仁栋电气有限公司` → `浙江仁栋电气科技有限公司`），去前缀才抓得到共同的核心词。
 */
export const CORE_WORD_PREFIXES = ['浙江省', '浙江', '宁波市', '宁波'] as const

/**
 * 组织形式后缀 —— 同一家公司的历史写法里变的最多的就是这一段
 * （实测 `宁波上航测绘有限公司` → `宁波上航测绘股份有限公司`）。按**长后缀优先**匹配，只去一次。
 */
export const CORE_WORD_SUFFIXES = ['股份有限公司', '有限责任公司', '有限公司', '公司'] as const

/** 名称里的不可见字符 / 空白 / 全角空格（与 `lib/domain.ts` 的归一化同一集合）。 */
const INVISIBLE = /[\s\u{00A0}\u{200B}-\u{200D}\u{FEFF}\u{3000}]+/gu

/**
 * 从企业名里抓**核心词**：去一处区划前缀 + 去一处组织形式后缀。
 *
 * ⚠️ 这不是「归一化」，也不是「改名」——它**只用于库内检索**。返回值不参与任何身份判定，
 * 也不落库。抓不出内容（空名、只剩前缀/后缀）时返回**空串**，调用方按「没有核心词」处理
 * （即不产生候选，而不是拿全名去猜）。
 *
 * 例：`宁波上航测绘有限公司` → `上航测绘`；`浙江瑞堂塑料科技股份有限公司` → `瑞堂塑料科技`；
 *     `华裕电器集团股份有限公司` → `华裕电器集团`。
 */
export function coreWordOf(raw: string | null | undefined): string {
  if (raw == null) return ''
  let name = String(raw).replace(INVISIBLE, '').trim()
  if (!name) return ''
  // 前后缀**各去一次**；去完可以是空串（`宁波` / `有限公司` 这类只剩前后缀的名字抓不出核心词）。
  for (const prefix of CORE_WORD_PREFIXES) {
    if (name.startsWith(prefix)) {
      name = name.slice(prefix.length)
      break
    }
  }
  for (const suffix of CORE_WORD_SUFFIXES) {
    if (name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length)
      break
    }
  }
  return name
}

// ---------------------------------------------------------------------------
// 统一社会信用代码格式（GB 32100-2015）
// ---------------------------------------------------------------------------

/**
 * 统一社会信用代码的**字符集**（GB 32100-2015）：数字 + 大写字母，但**不含** `I` `O` `S` `V` `Z`
 * （避免与 1/0/5/U/2 混淆）。
 */
export const USCC_ALPHABET = '0123456789ABCDEFGHJKLMNPQRTUWXY'

/** 前 17 位的加权因子（GB 32100-2015）。 */
export const USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28] as const

/** 格式检查的结论；`ok` 之外每一种都对应一句可读的拒绝理由（不合并成一个「非法」）。 */
export type UsccFormatVerdict = 'ok' | 'length' | 'charset' | 'checksum'

/**
 * 校验统一社会信用代码的**格式与校验位**。
 *
 * 为什么连校验位一起查：票面把「代码格式不合法」列为**必须拒绝写入**的一种情形，
 * 而只查长度/字符集会放过「长度对、字符集对、校验位错」的抄录错误。
 * 实测本库 7227 个既有统代（企业 7227 个 + 记录 510 个去重）**全部**通过格式与校验位 ——
 * 所以这条检查不会把真实数据误判成非法。
 *
 * 入参是 `unknown`：来源常常是「不知道是什么」的值（JSON 载荷、公开页面抓下来的文本）。
 */
export function usccFormatVerdict(raw: unknown): UsccFormatVerdict {
  if (typeof raw !== 'string' && typeof raw !== 'number') return 'length'
  const code = String(raw).replace(INVISIBLE, '').toUpperCase()
  if (code.length !== 18) return 'length'
  for (const ch of code) if (!USCC_ALPHABET.includes(ch)) return 'charset'
  let sum = 0
  for (let i = 0; i < 17; i += 1) sum += USCC_ALPHABET.indexOf(code[i]!) * USCC_WEIGHTS[i]!
  const remainder = 31 - (sum % 31)
  const expected = USCC_ALPHABET[remainder === 31 ? 0 : remainder]
  return expected === code[17] ? 'ok' : 'checksum'
}

/** 格式与校验位都对才算合法。 */
export function isValidUscc(raw: unknown): boolean {
  return usccFormatVerdict(raw) === 'ok'
}

// ---------------------------------------------------------------------------
// 待查清单（票面：企业名 / 地区 / 称号 / 来源文件与可用页码 / 接口匹配追溯）
// ---------------------------------------------------------------------------

/** 一条**接口匹配追溯**：这个（企业 × 称号 × 方向）为什么还没解决。 */
export interface UsccInterfaceTrace {
  /** 归属企业 id（清单按企业聚合时用）。 */
  enterpriseId: number
  /** 存下来的解释行 id；`null` = 还没有解释记录（状态是状态机默认的 `not_queried`）。 */
  explanationId: number | null
  titleCode: string
  direction: string
  /** §3.2 状态机取值，**只从 `difference_reason.status` 取**（读侧同一口径）。 */
  status: string
  reasonCode: string | null
  reasonNote: string | null
}

/** 一条公布来源（文件 / 附件 / 序号 / **页**）。 */
export interface UsccSourceEvidence {
  titleCode: string
  sourceFile: string
  attachment: string | null
  listNo: number | null
  /** 源文件里的页码（1 起）；给不出**留空**，不猜。 */
  page: number | null
}

/** 该企业名下的平台查询（**已经查过什么**，供解释「为什么它是未查询而不是无记录」）。 */
export interface UsccQueryTrace {
  interface: string
  queryKey: string
  rdjb: string
  queriedAt: string
  status: string
  relationCount: number
}

/** 待查清单的一行 = 一家**仍缺统一社会信用代码**的企业。 */
export interface UsccChecklistRow {
  enterpriseId: number
  name: string
  district: string | null
  city: string | null
  /** 该企业的称号（按等级排序）。 */
  titles: string[]
  /** 已确认曾用名 —— **匹配字典的一部分**（用户：曾用名表就是匹配字典）。 */
  aliasNames: string[]
  /** 每个（称号 × 方向）的接口匹配追溯。 */
  traces: UsccInterfaceTrace[]
  /** 公布来源（带可用页码）。 */
  evidence: UsccSourceEvidence[]
  /** 以该企业为查询键的平台查询（无统代企业通常为空）。 */
  queries: UsccQueryTrace[]
  /** 由公布名抓出的核心词（检索用，**不是**身份判据）。 */
  coreWord: string
}

export interface UsccChecklistFilter {
  /** 名称 / 已确认曾用名关键词（归一化后包含）。 */
  q?: string
  title?: string[]
  district?: string
  page?: number
  pageSize?: number
}

export interface UsccChecklistResult {
  rows: UsccChecklistRow[]
  counts: { total: number; titles: Record<string, number> }
  page: number
  pageSize: number
}

// ---------------------------------------------------------------------------
// 库内候选与判定
// ---------------------------------------------------------------------------

/** 一条**库内候选**：库里有统代的企业，其现名或已确认曾用名包含目标的核心词。 */
export interface UsccLibraryCandidate {
  enterpriseId: number
  name: string
  uscc: string
  district: string | null
  /** 命中方式：企业**现名** / **已确认曾用名**。 */
  matchedBy: 'name' | 'alias'
  /** 命中的那个写法（现名或曾用名原值）。 */
  matchedName: string
  /** 命中的核心词。 */
  matchedCoreWord: string
}

/** 结果分项（票面「补齐 / 冲突 / 未找到 / 待人工」四项）。 */
export const USCC_OUTCOMES = ['filled', 'conflict', 'not_found', 'manual'] as const
export type UsccOutcome = (typeof USCC_OUTCOMES)[number]

/** 目标最终落进的桶；`filled` 之外每一种都带一句可读的理由（不合并成一个「失败」）。 */
export interface UsccTargetOutcome {
  enterpriseId: number
  name: string
  outcome: UsccOutcome
  /** 简短原因码（`filled` 时是路径：`library` / `platform_name` / `public_source`）。 */
  code: string
  message: string
  /** 库内候选（逐条留下，供复核「为什么是 A 不是 B」）。 */
  candidates: UsccLibraryCandidate[]
  /** 回填/归并到的统代；未补齐为 `null`。 */
  uscc: string | null
}

/** 补录的**来源证据**（票面：公开内容来源 URL + 查证日期 + 主体对应依据）。 */
export interface UsccResearchSource {
  /** 可复核的公开内容来源 URL。 */
  url: string
  /** 查证日期（`YYYY-MM-DD`）。 */
  checkedOn: string
  /** 名称 / 地区对应依据（为什么这个主体就是本企业）。 */
  basis: string
  /** 来源里写出的主体名称（原值）。 */
  name: string
  /** 来源给出的地区（如 `宁波市/鄞州区`）。**给不出留空，不猜**。 */
  region?: string | null
}

/**
 * **一条待补录的公开来源查证结果**——即 RL-06 的**输入**（路径二）。
 *
 * 这不是结论：它要经 `POST /api/roster/import/commit` 的 `usccBackfills` 校验
 * （企业存在 / 企业本来没有统代 / 代码格式与校验位合法 / 代码未被别的企业占用 /
 * 三要素齐备），任何一条不过就拒绝写入并标冲突。
 */
export interface UsccResearchClaim {
  /** 归属企业：给 `enterpriseId` 优先，否则按 `enterpriseName` 归一化名找。 */
  enterpriseId?: number
  enterpriseName?: string
  /** 查到的统一社会信用代码。 */
  uscc: string
  source: UsccResearchSource
  note?: string | null
}

/** 公开来源**地区与本企业属地不符**时的判据用的城名（全库都在这座城市）。 */
export const LOCAL_CITY = '宁波'

/** 一条 claim 在**判定层**的可行性结论（写入层还会再校验一遍，两边规则同源）。 */
export type UsccClaimVerdict =
  | { ok: true }
  | { ok: false; code: 'uscc_format_invalid' | 'region_mismatch' | 'source_evidence_incomplete'; message: string }

/**
 * 判定一条公开来源 claim **够不够格进写入载荷**。
 *
 * 只做**客观**检查（票面第 4 条里可机械判定的那几种），**不做**任何名称相似度判断：
 *  - 代码格式 / 校验位不合法 ⇒ `uscc_format_invalid`（不填猜测值）；
 *  - 三要素（URL / 查证日期 / 对应依据）缺一 ⇒ `source_evidence_incomplete`（证据不足 ⇒ 待核实）；
 *  - 来源写出的地区**明说**不在宁波 ⇒ `region_mismatch`（地区不符 ⇒ 冲突）。
 *
 * 「同名多主体」「代码已被占用」这两条要看**库内状态**，由调用方（读侧计划）判定，
 * 不在这里 —— 本函数是纯函数，不碰库。
 */
export function judgeUsccClaim(claim: UsccResearchClaim): UsccClaimVerdict {
  if (!isValidUscc(claim?.uscc)) {
    return {
      ok: false,
      code: 'uscc_format_invalid',
      message: `统一社会信用代码 ${String(claim?.uscc ?? '(空)')} 的格式或校验位不合法（GB 32100-2015）`,
    }
  }
  const source = claim?.source
  const missing = [
    typeof source?.url === 'string' && source.url.trim() ? null : '公开来源 URL',
    typeof source?.checkedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(source.checkedOn.trim()) ? null : '查证日期(YYYY-MM-DD)',
    typeof source?.basis === 'string' && source.basis.trim() ? null : '主体对应依据',
    typeof source?.name === 'string' && source.name.trim() ? null : '来源里的主体名称',
  ].filter((item): item is string => item != null)
  if (missing.length) {
    return { ok: false, code: 'source_evidence_incomplete', message: `公开来源证据不齐，缺：${missing.join('、')}` }
  }
  const region = typeof source.region === 'string' ? source.region.trim() : ''
  if (region && !region.includes(LOCAL_CITY)) {
    return {
      ok: false,
      code: 'region_mismatch',
      message: `公开来源写出的地区「${region}」不含「${LOCAL_CITY}」⇒ 地区不符，不填猜测值`,
    }
  }
  return { ok: true }
}
