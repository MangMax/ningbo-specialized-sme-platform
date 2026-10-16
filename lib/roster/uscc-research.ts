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

/**
 * 公开来源证据的**三要素**检查（URL / 查证日期 / 主体对应依据）+ 来源里的主体名称。
 *
 * 为什么单独抽出来：计划侧（`judgeUsccClaim`）与**写入侧**（`planUsccBackfill`，
 * 载荷校验）都要判这一条 —— 「可复核的来源」是票面第 3 条的硬要求，两处各写一遍迟早会漂，
 * 而漂了以后「计划说能写、写入拒了」或者反过来「写入放行了一条不可复核的来源」都很难发现。
 * 返回**缺哪几项**（空数组 = 齐备），调用方用自己那句错误文案。
 */
export function missingUsccSourceFields(
  source: { url?: unknown; checkedOn?: unknown; basis?: unknown; name?: unknown } | null | undefined,
): string[] {
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  return [
    text(source?.url) ? null : '公开来源 URL',
    /^\d{4}-\d{2}-\d{2}$/.test(text(source?.checkedOn)) ? null : '查证日期(YYYY-MM-DD)',
    text(source?.basis) ? null : '主体对应依据',
    text(source?.name) ? null : '来源里的主体名称',
  ].filter((item): item is string => item != null)
}

/**
 * **逐字相等** —— 本票的**唯一**身份判据，就这一条，所以只有这一处实现。
 *
 * 「同一 `tyshxydm` 下 `qymc` 逐字等于公布名」是唯一能触发回填/归并的事实（契约 §5.1 与
 * 用户 2026-10-16 的口径）。**不做归一化、不做大小写折叠、不算相似度** —— 归一化会把
 * 「有限公司 / 股份有限公司」这种**正是要留住的差异**抹掉。
 * 放成具名函数是为了让这条红线**可被 grep、可被审**：调用它的地方就是判据生效的地方。
 */
export function isByteEqualName(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a === b
}

/**
 * 名称比对的**档次**（父代理 2026-10-16 裁定：「归一化后相等即成立，A 类仍不抹平」）。
 *
 * 三档**逐级放宽**，每一档都必须能说出「差的是哪一类字形/写法」：
 *
 *  - `byte` —— **逐字相等**。用户原始口径（契约 §5.1）与默认判据；
 *  - `typographic` —— 只差**全/半角括号**与空白/零宽字符。括号是同一个符号的两种字形，
 *    不可能改变「这是哪家公司」（实测 `爱芯元智半导体(宁波)有限公司` vs
 *    `爱芯元智半导体（宁波）有限公司`：平台只写了全角括号）；
 *  - `district_suffix` —— 只差**区县名后面那个「县」/「区」的有无**（实测
 *    `象山县时利模塑有限公司` vs `象山时利模塑有限公司`）。
 *
 * ⚠️ **不抹平「有限公司 ↔ 股份有限公司」**（父代理明令）：那一类正是**更名**证据
 * （契约 §5.1 靠它认曾用名），抹平了就再也认不出来。所以本函数**不做**归一化替换，
 * 只做上面这三种**可命名的字形/写法差异**，其余一律返回 `null`（判据不成立）。
 *
 * ⚠️ 与 `normalizeName` 的分工：`normalizeName` 会**去掉**括号、补「宁波」前缀，
 * 用作**检索**口径；本函数是**判据**，比它窄得多 —— 它不能改变名字里除上述三类以外的任何字符。
 */
export type NameMatchLevel = 'byte' | 'typographic' | 'district_suffix'

/** 宁波的区县短名（去「区/县/市」后缀），用于识别「区县后缀有无」这一类写法差异。 */
const DISTRICT_STEMS = ['海曙', '江北', '北仑', '镇海', '鄞州', '奉化', '余姚', '慈溪', '宁海', '象山', '前湾'] as const

/**
 * 名称比对：返回成立的最强档次，不成立返回 `null`。**纯函数、无 IO、无打分**。
 *
 * 「逐字」之外的两档都不是相似度：它们要求**除该字形/写法差异外逐字相同**，
 * 所以是「同一条记录的两个写法」，不是「两个名字像不像」。
 */
export function nameMatchLevel(a: unknown, b: unknown): NameMatchLevel | null {
  if (typeof a !== 'string' || typeof b !== 'string') return null
  if (a === b) return 'byte'
  const fold = (value: string) => value.replace(INVISIBLE, '').replace(/（/g, '(').replace(/）/g, ')')
  const fa = fold(a)
  const fb = fold(b)
  if (fa === fb) return 'typographic'
  // 区县后缀：从**一侧**删掉紧跟在区县短名后面的那个「县」或「区」，看是否与另一侧逐字相同。
  // 只允许删**一处**、且它必须紧跟在区县短名之后（父代理实测的反例：把「北仑顺兴」的
  // 「顺」前补一个「区」是把名字改坏了 —— 但作为**比对**，只有当平台/公布件一侧真的写了
  // 「北仑区顺兴」、另一侧写「北仑顺兴」时才会命中，那种情况本来就是同一个区县名）。
  for (const [x, y] of [
    [fa, fb],
    [fb, fa],
  ] as const) {
    for (const stem of DISTRICT_STEMS) {
      for (const suffix of ['县', '区'] as const) {
        const at = x.indexOf(stem + suffix)
        if (at < 0) continue
        const stripped = x.slice(0, at + stem.length) + x.slice(at + stem.length + suffix.length)
        if (stripped === y) return 'district_suffix'
      }
    }
  }
  return null
}

/** 三档里至少到 `typographic` 才算「归一化后相等」；`byte` 之外都算放宽。 */
export function isEquivalentName(a: unknown, b: unknown): boolean {
  return nameMatchLevel(a, b) != null
}

/** 平台接口地址（**平台原始证据**那一路的「来源」——它不是公开内容页，见 §8.10 的说明）。 */
export const PLATFORM_INTERFACE_URLS = {
  business_list: 'https://zjtx.miit.gov.cn/zxqy/ZjtxxjrBusInfoManageBLH/businessList',
  apply_list: 'https://zjtx.miit.gov.cn/zxqy/YzzxqyApplayBLH/queryList',
} as const

/** 公开来源**地区与本企业属地不符**时的判据用的城名（全库都在这座城市）。 */
export const LOCAL_CITY = '宁波'

/**
 * 一条**平台证据认领**：某个统代的平台关系写出的 `qymc` 逐字等于本企业的公布名。
 *
 * 这是路径一（④⑤ 两步）的输入形态 —— 与 {@link UsccResearchClaim}（公开来源）的区别在
 * **证据种类**：这里的证据是**平台原始关系**，那才是「平台自己说这个统代就叫这个名字」。
 * 批次判断代理交接的判定文件就走这条形态。
 *
 * ⚠️ **判定文件只是线索，不是证据**。`evidence` 里写的字段要**在库里对得上**才算数
 * （见 `server/utils/uscc-research.ts` 的证据解析）：

 *  - 库里**已有**那条关系（RL-03 实查落库的）⇒ 直接用真实行 id；
 *  - 库里没有、而判定文件带来了 `evidence` ⇒ 用**批内自然键**（契约 §8.7）把这批查询/关系
 *    与别名/归并的证据指针一起写进同一批 —— 归属由这批自己写下的行证明；
 *  - 两边都没有 ⇒ `no_platform_evidence`，**不写**（文件说 `resolved` 也不算数）。
 */
export interface UsccPlatformClaim {
  /** 归属企业：给 `enterpriseId` 优先，否则按 `enterpriseName` 归一化名找。 */
  enterpriseId?: number
  enterpriseName?: string
  /** 待补（或规范化行已持有）的统一社会信用代码。 */
  uscc: string
  /**
   * 判定代理交接的**原始关系摘要**（写进库做证据用）。缺省时只认库里**已有**的关系。
   */
  evidence?: {
    interface: 'business_list' | 'apply_list'
    /** `business_list` 的 rdjb；`apply_list` 为空串。 */
    rdjb?: string
    /** 同一次查询内第几条（从 1 起）。 */
    sequenceNo: number
    /** 平台关联主键（如 `SQ332022062212391`）。 */
    relationKey?: string | null
    /** 该关系的 `qymc` —— **必须逐字等于**本企业的公布名，否则不构成证据。 */
    nameRaw: string
    /** 该关系的 `cszt`（存续状态）。 */
    status?: string | null
    /** 该关系的 `tyshxydm`；与 `uscc` 不一致时这条讲的是别的企业（拒掉它）。 */
    usccRaw?: string | null
    /**
     * 代理**实际发出去的那次查询**（如 `qymc=余姚市宏达喷雾器有限公司` / `tyshxydm=9133…`）。
     * 记进 `source_text`，用来分清「按名反查」与「按统代正查」两条路。
     */
    query?: string | null
  }[]
  /** 判定依据（判定代理写的一句话）；落 `source_text` / `note`，供复核。 */
  reason?: string | null
  /** 证据来自哪个批次文件（如 `uscc-verdict-batch-3`）；落 `source_text`。 */
  batchRef?: string | null
  /**
   * 证据的**产出时刻**（判定文件里的 `generatedAt`）。
   *
   * 为什么要写它：判定文件的原始平台响应**没有随文件交接**（只有字段摘要），所以这批
   * `platform_query` 行的 `queried_at` 用的是**代理产出的时刻**而不是平台响应时刻 ——
   * 这一点在 `source_text` 里如实写明，不留「看着像原始响应时刻」的假象。
   */
  observedAt?: string | null
}

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
  const missing = missingUsccSourceFields(source)
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
