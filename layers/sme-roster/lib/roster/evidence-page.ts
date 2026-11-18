/**
 * RL-10 —— **出处页码**的纯规则:能不能给页码、页码指向哪一行、跳转链接怎么写。
 *
 * ── 这一层解决的是哪件事 ────────────────────────────────────────────────
 *
 * 台账的「出处」是 `(文件 / 附件 / 序号 / 页码)` 四元组,而 `record_evidence.page`
 * 是**PDF 实际页序**(见 `lib/roster-import-client.ts` 与 `db/schema.ts`)。
 * 两个数字很容易被当成一回事,而它们完全是两回事:
 *
 *   **序号**(`list_no`)是名单里的行号,**页码**(`page`)是这一行印在 PDF 的第几页。
 *
 * ── ★ 裸序号会定位到错的公司(本票必须挡住的那件事)──────────────────────
 *
 * `甬经信中小〔2022〕145号` 的「附件」里并置着**三张分节名单**,序号**各自从 1 起算**
 * (实测:一、198 行;二、104 行;三、413 行,共 715 家)。库里 `record_evidence` 只留了
 * `(source_file, attachment, list_no)`,**分节没有列** —— 于是:
 *
 *     按「145号 + 序号 6」去查,库里命中 **3 条**(海曙区三家不同企业:
 *     宁波培源股份有限公司 / 宁波开诚生态技术有限公司 / 宁波恒特汽车零部件…)。
 *     人工核对页图证实:**开诚那一条在附件二、第 8 页**;另两条在别的分节、别的页。
 *
 * 所以本文件的定位判据**绝不接受裸序号**:一条页码写入必须同时给出**定位**
 * (`enterpriseId` 或 `enterpriseName`,可再加 `district`)。
 * 找不到唯一一条时**留空待核**,而不是拿第一条凑数 —— `no_match` / `ambiguous`
 * 两种待核原因都会把「同序号有几条」一并报出来,让这个陷阱**在报告里看得见**。
 *
 * ── 与「不做模糊推断」的关系 ────────────────────────────────────────────
 *
 * 这里的名称比对**只用 `normalizeName` 的逐字归一**(大小写无关、括号与空白无关),
 * **不是**相似度、不是编辑距离。而且它的方向是**收窄候选**:候选先由
 * `(source_file, list_no)` 这类原始记录给出,名称/属地只用来**排除**不属于这一条的
 * 那些行。判定仍然由原始记录(那条出处行 + 人工核对的页码)触发。
 */
import { normalizeName } from '../domain'
// `lib/preview.ts` 是**零依赖**的纯规则(它只按扩展名分派预览类型,不 import 任何东西),
// 所以「取扩展名」这件事直接用它的那一份,不另抄一遍 —— 抄一份就多一处会跟它走偏的口径。
import { isSafeBackPath, positiveInt } from '../../../core/lib/preview-query'
import { extensionOf } from '../../../core/lib/preview'

/** 只有 PDF 有**稳定的实际页序**;Word / Excel / 图片没有「第 N 页」这回事。 */
const PAGE_CAPABLE_EXT = 'pdf'

/**
 * 这份来源**给不给得出页码**。
 *
 * 只有 PDF 为真。`.docx` / `.xlsx` 的排版由打开它的程序决定,**页是渲染出来的、不是文件里的**
 * —— 同一份 docx 在 Word 和 WPS 里分页都可能不同,「第 N 页」不是一个可复核的事实。
 * 票面要求这类文件**不跳转到猜测页**,`evidencePageState` 据此把它们标成 `unavailable`
 * (「本来就没有页码」),而不是 `pending`(「还没定,待核」)。两者在界面上的话不一样。
 */
export function isPageCapable(sourceFile: string): boolean {
  return extensionOf(sourceFile) === PAGE_CAPABLE_EXT
}

/**
 * 界面上这一条出处该怎么写「页码」。
 *
 *  - `assigned` —— 有页码,显示它(并且可以跳);
 *  - `pending` —— 这份来源**本该有**页码(PDF)但还没定下来 ⇒ 明说「待核」,不显示数字;
 *  - `unavailable` —— 这份来源**没有**可靠的页(Word / Excel / 图片)⇒ 留空,不承诺待核。
 *
 * 三态分开是刻意的:`pending` 是在说「这件事还没做完」(有人该去补),
 * `unavailable` 是在说「这件事不存在」(别去补)。合成一个「空」会让前者被当成后者。
 *
 * ⚠️ **来源不给页码这一条优先于「有没有 page 值」**。Word / Excel 行的 `page` 若被谁写了个
 * 数(手工塞参数、旧数据、拼接出错),它**依然不是一个可复核的页** —— 这时该说的是
 * 「这类文件没有页」,而不是照着那个数字把人带到「第 5 页」去。票面把这一条写死了:
 * **Word、Excel 等没有可靠分页的文件不跳转到猜测页**。写入侧同样拒收(`not_page_capable`)。
 */
export type EvidencePageState = 'assigned' | 'pending' | 'unavailable'

export function evidencePageState(sourceFile: string, page: number | null | undefined): EvidencePageState {
  if (!isPageCapable(sourceFile)) return 'unavailable'
  return page === null || page === undefined ? 'pending' : 'assigned'
}

/** 页码三态在界面上的字。`assigned` 不在这里 —— 它的字是数字本身(`第 N 页`)。 */
export const EVIDENCE_PAGE_WORDS: Record<Exclude<EvidencePageState, 'assigned'>, string> = {
  pending: '页码待核',
  unavailable: '—',
}

// ---------------------------------------------------------------------------
// 写入侧:一条页码 → 一条出处行
// ---------------------------------------------------------------------------

/**
 * **待写入的一条页码**(调用方给的输入)。
 *
 * `sourceFile` + `listNo` 找到候选;`enterpriseId` / `enterpriseName` / `district`
 * 把候选**收窄到唯一一条**。只给 `listNo` 是**不够**的 —— 见文件头「裸序号」那一节。
 */
export interface EvidencePageEntry {
  /** 来源文件,相对文件库根(与 `record_evidence.source_file` 同一口径)。 */
  sourceFile: string
  /** 名单里的序号。**不是**页码。 */
  listNo: number
  /** **PDF 实际页序**(1 起)。 */
  page: number
  /** 定位:企业 id。与 `enterpriseName` 至少给一个。 */
  enterpriseId?: number
  /** 定位:企业名(**逐字归一**后比对,不是相似度)。 */
  enterpriseName?: string
  /** 定位(可选,进一步收窄):属地。同序号同企业名但分属两区时用它。 */
  district?: string | null
  /** 这条页码**怎么来的**(人工核对页图 / OCR 页标记 / …)。留档用,**不参与判定**。 */
  basis?: string
}

/** 库里的一条出处行(候选)。由读查询给出,判定只用这几个字段。 */
export interface EvidencePageCandidate {
  evidenceId: number
  sourceFile: string
  listNo: number | null
  enterpriseId: number
  enterpriseName: string
  /**
   * 这条**记录**上的属地(公布文件里那一行印的属地)。
   * ⚠️ 判定时**不能只看它** —— 界面上显示、导出里写的属地是「有效属地」
   * (`layers/sme-roster/lib/roster/enterprise-roster.ts` 的 `effectiveDistrict`:**企业自身属地优先**,
   * 为空才退回记录)。调用方多半是照着界面抄的属地,所以两个都要认,否则一条
   * 看起来完全正确的条目会莫名其妙 `no_match`。
   */
  district: string | null
  /** 这个**企业**自身的属地(见上)。 */
  enterpriseDistrict: string | null
  /** 这一行**当前**的页码;`null` = 还没定。重跑时用来报「本来就是这个值」。 */
  page: number | null
}

/** 这一条为什么**没写**(要写进报告、也要在界面上说清)。 */
export type EvidencePagePendingReason =
  /** 输入缺东西(没有 sourceFile / listNo 不是正整数 / 没有定位信息)。 */
  | 'entry_incomplete'
  /** `page` 不是正整数,或已知超出源 PDF 页数 —— **不取整、不夹值**。 */
  | 'page_invalid'
  /** 源 PDF 实际页数无法可靠读取,因此不能证明请求页码在有效范围内。 */
  | 'page_count_unknown'
  /** 非 PDF:这份来源给不出可靠的页。 */
  | 'not_page_capable'
  /** 按 `(文件, 序号)` + 定位找不到候选。 */
  | 'no_match'
  /** 命中不止一条 —— **不猜**。 */
  | 'ambiguous'

export interface EvidencePagePending {
  /** 在入参 `entries` 里的下标 —— 报告要能对回调用方给的那一条。 */
  index: number
  entry: EvidencePageEntry
  reason: EvidencePagePendingReason
  /** 一句人话(报告里直接显示)。 */
  detail: string
  /** 相关的出处行 id(便于人工核对)。 */
  candidateIds: number[]
  /**
   * 同 `(文件, 序号)` 在库里一共有几条 —— **分节陷阱的可观察探针**。
   * `> 1` 而 `no_match` ⇒ 是「同序号不同分节」那一类,不是「库里没有」。
   */
  sameListNo: number
}

export interface EvidencePageAssignment {
  index: number
  entry: EvidencePageEntry
  evidenceId: number
  /** 本次要写入的页码。 */
  page: number
  /** 该行**原来**的页码(`null` = 原来没有)。与 `page` 相同 ⇒ 这是一次空操作。 */
  previous: number | null
}

export interface EvidencePagePlan {
  assignments: EvidencePageAssignment[]
  pending: EvidencePagePending[]
}

/**
 * 把一批页码排到具体的出处行上。**纯函数**:不碰库、不写日志,便于单测钉住判据。
 *
 * 判据(按顺序,任何一条不过就**留空待核**,绝不猜):
 *  1. `sourceFile` 非空、`listNo` 是正整数;**必须**带 `enterpriseId` 或 `enterpriseName`
 *     (裸序号一律拒收 —— 见文件头)。输入不合这三条 → `entry_incomplete`。
 *  2. `page` 是正整数 → 否则 `page_invalid`。
 *  3. 来源是 PDF → 否则 `not_page_capable`。
 *  4. 源 PDF 页数可读取且请求页未越界；未知 → `page_count_unknown`，越界 → `page_invalid`。
 *  5. 候选 = 同 `sourceFile` 且同 `listNo` 的出处行。
 *  6. 用 `enterpriseId` / `enterpriseName`(逐字归一)/ `district` **收窄**候选。
 *  7. 收窄后**恰好一条**才写;0 条 → `no_match`;≥2 条 → `ambiguous`。
 *  8. 两条入参**抢同一行且页码不同** → 两条都留空(`ambiguous`),不写任何一条 ——
 *     宁可都不写,也不要让「后一条覆盖前一条」把一条没有依据的页码留在库里。
 */
export function planEvidencePages(
  entries: readonly EvidencePageEntry[],
  candidates: readonly EvidencePageCandidate[],
  pageCounts: ReadonlyMap<string, number | null> = new Map(),
): EvidencePagePlan {
  const assignments: EvidencePageAssignment[] = []
  const pending: EvidencePagePending[] = []

  /** 同一行被两条入参分别指向时,先记下来 —— 等扫完再判「页码是否一致」。 */
  const claimed = new Map<number, { index: number; page: number }[]>()

  entries.forEach((entry, index) => {
    const sourceFile = typeof entry?.sourceFile === 'string' ? entry.sourceFile.trim() : ''
    const listNo = positiveInt(entry?.listNo)
    const hasLocator =
      (typeof entry?.enterpriseId === 'number' && Number.isInteger(entry.enterpriseId)) ||
      (typeof entry?.enterpriseName === 'string' && entry.enterpriseName.trim() !== '')

    if (!sourceFile || listNo === null || !hasLocator) {
      const missing = [
        !sourceFile ? 'sourceFile' : null,
        listNo === null ? 'listNo(正整数)' : null,
        !hasLocator ? 'enterpriseId 或 enterpriseName(定位)' : null,
      ].filter(Boolean)
      pending.push({
        index,
        entry,
        reason: 'entry_incomplete',
        detail: `这一条缺 ${missing.join(' / ')}。出处页码必须能定位到**唯一一条**出处行;只给序号会落到同序号的其他分节上(见 145号 三张分节名单),故拒收。`,
        candidateIds: [],
        sameListNo: 0,
      })
      return
    }

    const page = positiveInt(entry?.page)
    if (page === null) {
      pending.push({
        index,
        entry,
        reason: 'page_invalid',
        detail: `page 必须是 ≥1 的整数,收到:${String(entry?.page)}。页码是 PDF 实际页序,取整或猜值都会指向错的证据页。`,
        candidateIds: [],
        sameListNo: 0,
      })
      return
    }

    if (!isPageCapable(sourceFile)) {
      pending.push({
        index,
        entry,
        reason: 'not_page_capable',
        detail: `${sourceFile} 不是 PDF —— Word / Excel 的分页由打开它的程序决定,给不出可复核的「第 N 页」。这一类来源一律不写页码。`,
        candidateIds: [],
        sameListNo: 0,
      })
      return
    }

    const pageCount = pageCounts.get(sourceFile)
    if (pageCount === null || pageCount === undefined || !Number.isInteger(pageCount) || pageCount < 1) {
      pending.push({
        index,
        entry,
        reason: 'page_count_unknown',
        detail: `无法从源 PDF 可靠读取实际页数(${sourceFile})，保留待核；不会用已渲染页图数量代替 PDF 页数。`,
        candidateIds: [],
        sameListNo: 0,
      })
      return
    }
    if (page > pageCount) {
      pending.push({
        index,
        entry,
        reason: 'page_invalid',
        detail: `第 ${page} 页超出源 PDF 实际页数(共 ${pageCount} 页)，保留待核。`,
        candidateIds: [],
        sameListNo: 0,
      })
      return
    }

    // 先按 (文件, 序号) 取池,再按定位收窄。池子的大小要报出去:它就是分节陷阱的探针。
    const byListNo = candidates.filter((c) => c.sourceFile === sourceFile && c.listNo === listNo)
    const narrowed = byListNo.filter((c) => {
      if (typeof entry.enterpriseId === 'number' && c.enterpriseId !== entry.enterpriseId) return false
      if (
        typeof entry.enterpriseName === 'string' &&
        entry.enterpriseName.trim() !== '' &&
        normalizeName(c.enterpriseName) !== normalizeName(entry.enterpriseName)
      ) {
        return false
      }
      // 属地:记录上的与**企业自身**的都算 —— 界面上给人看的是「有效属地」,
      // 而它优先取企业自身的(见 `EvidencePageCandidate.district` 的说明)。
      if (entry.district != null && entry.district !== '') {
        if (c.district !== entry.district && c.enterpriseDistrict !== entry.district) return false
      }
      return true
    })

    if (narrowed.length === 0) {
      pending.push({
        index,
        entry,
        reason: 'no_match',
        detail:
          byListNo.length === 0
            ? `${sourceFile} 里没有序号 ${listNo} 的出处行。`
            : `${sourceFile} 的序号 ${listNo} 有 ${byListNo.length} 条(分节不同、序号各自从 1 起算),但没有一条与本条给定的企业 / 属地一致 —— 不猜。`,
        candidateIds: byListNo.map((c) => c.evidenceId),
        sameListNo: byListNo.length,
      })
      return
    }

    if (narrowed.length > 1) {
      pending.push({
        index,
        entry,
        reason: 'ambiguous',
        detail: `${sourceFile} 的序号 ${listNo} 按本条定位仍命中 ${narrowed.length} 条出处行,无法确定页码该写在谁身上 —— 不猜。请补 district 或改用 enterpriseId。`,
        candidateIds: narrowed.map((c) => c.evidenceId),
        sameListNo: byListNo.length,
      })
      return
    }

    const hit = narrowed[0]!
    const claims = claimed.get(hit.evidenceId)
    if (claims) claims.push({ index, page })
    else claimed.set(hit.evidenceId, [{ index, page }])

    assignments.push({
      index,
      entry,
      evidenceId: hit.evidenceId,
      page,
      previous: hit.page,
    })
  })

  // 同一条出处行被两条入参指向、且页码**不同** ⇒ 两条都留空。同页码是同一个事实的
  // 重复表达(批处理重跑常见),保留各自的输入下标;写入侧只执行一次,重复项计入 unchanged。
  const conflicted = new Set<number>()
  for (const [evidenceId, claims] of claimed) {
    if (new Set(claims.map((c) => c.page)).size > 1) conflicted.add(evidenceId)
  }
  if (conflicted.size === 0) return { assignments, pending }

  const kept: EvidencePageAssignment[] = []
  for (const a of assignments) {
    if (!conflicted.has(a.evidenceId)) {
      kept.push(a)
      continue
    }
    const pages = [...new Set(claimed.get(a.evidenceId)!.map((c) => c.page))].sort((x, y) => x - y)
    // `sameListNo` 报的是**同 (文件, 序号) 在库里一共有几条**,不是「这条冲突涉及几行」——
    // 它是分节陷阱的探针,任何一条待核都要给出真实的池子大小(与 `no_match` 同一口径)。
    pending.push({
      index: a.index,
      entry: a.entry,
      reason: 'ambiguous',
      detail: `同一出处行(evidence #${a.evidenceId})被本批的两条入参分别指到第 ${pages.join(' / ')} 页 —— 页码互相矛盾,这一行不写,等人工核对后再补。`,
      candidateIds: [a.evidenceId],
      sameListNo: candidates.filter(
        (c) => c.sourceFile === a.entry.sourceFile.trim() && c.listNo === a.entry.listNo,
      ).length,
    })
  }
  return { assignments: kept, pending }
}

// ---------------------------------------------------------------------------
// 读侧:跳转链接
// ---------------------------------------------------------------------------

/** 出处预览页的路径。 */
export const EVIDENCE_PREVIEW_PATH = '/preview'

/**
 * 出处 → 预览页的跳转链接。
 *
 * 链接在**地址栏里**(而不是一个开弹窗的按钮):票面要求「返回后保留原筛选与查看位置」——
 * 有「返回」就得有「去过」,所以跳转是一次**导航**,`back` 带着台账那份完整筛选串
 * (含 `view` / 各筛选 / 页码 / `expand`),回来时原样落回。
 *
 * `page` 为空(未定 / 无可靠页)时不写 `page` 参数 —— 打开文件本身,但**不假装**知道第几页。
 * 空参数的 `page=` 与「第 1 页」在解析端会撞在一起,那是把「没有」变成「第一页」。
 *
 * **非 PDF 一律不写 `page`**,哪怕调用方给了一个数 —— 与 `evidencePageState` 同一条口径
 * (Word / Excel 没有可复核的页)。判据放在这里,链接层就不会漏出一个带页码的 Word 地址。
 */
export function evidencePreviewHref(input: {
  sourceFile: string
  page?: number | null
  back?: string | null
  applicationOrigin?: string
}): string {
  const params = new URLSearchParams()
  params.set('file', input.sourceFile)
  const page = isPageCapable(input.sourceFile) ? positiveInt(input.page ?? null) : null
  if (page !== null) params.set('page', String(page))
  if (isSafeBackPath(input.back, input.applicationOrigin)) params.set('back', input.back)
  return `${EVIDENCE_PREVIEW_PATH}?${params.toString()}`
}
