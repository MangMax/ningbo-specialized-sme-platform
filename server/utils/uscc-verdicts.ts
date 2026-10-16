/**
 * **批次判断代理的判定文件 → 平台证据认领**（RL-06 的中央写回）。
 *
 * ── 分工 ────────────────────────────────────────────────────────────────
 * 用户 2026-10-16 要求「关键词判断本来就可以并行」,于是 5 个**只读**判断代理各自产出一份
 * `uscc-verdict-batch-<N>.json`(每条带 `candidateUscc` / `platformEvidence` /
 * `qymcEqualsAnnouncedName` / `verdict` / `reason`)。本模块只做**归一化与筛选取舍**,
 * 一行都不写库:
 *
 *  - 只有 `verdict === 'resolved'` **且** `qymcEqualsAnnouncedName === true`、且带合法
 *    `candidateUscc` 的条目,才转成 `UsccPlatformClaim` 交给计划;
 *  - `conflict` / `not_found` / `needs_human` **一律不动库**,如实列出(带文件给的理由);
 *  - 文件缺字段 / 形状不对 ⇒ 记一条 `problem` 并把该条**跳过**,不猜。
 *
 * ── 判定文件**不是证据** ────────────────────────────────────────────────
 * `qymcEqualsAnnouncedName: true` 是**代理的断言**。真正的判据在
 * `server/utils/uscc-research.ts`:库里已有的平台关系,或随本批写入的关系行,
 * 其 `qymc` 必须**逐字等于**公布名。断言对不上 ⇒ `no_platform_evidence`,不写。
 *
 * ── 只读、可重放 ────────────────────────────────────────────────────────
 * 判定文件在仓库外(不入 Git、不进提交);本模块按**文件名**读固定 5 个批次,容忍
 * 部分批次还没产出(报告里说清「读到几批」),且**只读不改**。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeUscc } from '../../lib/domain'
import { isByteEqualName, nameMatchLevel, type UsccPlatformClaim } from '../../lib/roster/uscc-research'

/** 判定文件里的一条(形状见 `orchestration-notes/07-USCC-BATCH-BRIEF.md`)。 */
export interface UsccVerdictItem {
  enterpriseId?: number
  name?: string
  district?: string | null
  keyword?: string
  libraryHits?: Array<{ enterpriseId?: number; name?: string; uscc?: string | null; district?: string | null }>
  candidateUscc?: string | null
  platformEvidence?: Array<{
    /** `business_list` / `apply_list`；复查文件里 queryList 那条可能写作 `query_list`。 */
    interface?: string
    rdjb?: string
    sequenceNo?: number
    relationKey?: string | null
    qymc?: string
    cszt?: string | null
    /** 关系自己写的统代（`tyshxydm`）。 */
    tyshxydm?: string | null
    /** 代理实际发出的那次查询（如 `qymc=…`），留作证据出处。 */
    query?: string | null
  }>
  /**
   * 代理的判据断言。**三/四种形态都见过**：布尔 `true`/`false`、
   * 整个字段缺席（批次 5），以及**字符串**（复查文件写 `"normalizeName"`，意为「只在归一化
   * 口径下相等」）。它**不是**我们的采纳判据（见下），所以只如实记档、不做准入门槛。
   */
  qymcEqualsAnnouncedName?: boolean | string | null
  verdict?: string
  reason?: string | null
  blocked?: string | null
}

export interface UsccVerdictFile {
  batch?: number
  generatedAt?: string
  /** 常规形态。 */
  items?: UsccVerdictItem[]
  /**
   * **只含转正条目的交接形态**（复查代理给补充证据时用这个键）。
   * 与 `items` 同形，只是键名不同 —— 两种都收，缺一个就会把整份文件当成空的。
   */
  resolvedItems?: UsccVerdictItem[]
}

/** 判定文件里**没被采纳**的一条(逐条带文件给的理由,绝不静默丢弃)。 */
export interface UsccVerdictUntouched {
  enterpriseId: number | null
  name: string
  verdict: string
  reason: string
  /**
   * 判定代理写明、**必须人工去核对的原件位置**（如 `甬经信中小〔2024〕192号 附件1 序号290`）。
   *
   * 为什么原样带出来：这类条目（同一家公司在公布件与平台之间**差一个字**、或用字/解析差异）
   * 软件**不能**回填，但「要去哪一页核对」这件事只有代理知道。丢了它，待核清单就只剩一句
   * 「证据不足」，人还得从头再查一遍。
   */
  blocked: string | null
}

export interface UsccVerdictIngest {
  /** 转成平台证据认领、准备进写入计划的条目。 */
  platformClaims: UsccPlatformClaim[]
  /** 未采纳的条目(冲突 / 未找到 / 待人工 / 库内已解决),原样带理由。 */
  untouched: UsccVerdictUntouched[]
  /** 读到的批次(文件名 → 条数 / 产出时刻)。 */
  batches: Array<{ batch: number | null; file: string; generatedAt: string | null; items: number }>
  /** 文件本身的问题(缺字段 / 形状不对 / 文件读不了);**逐条列出不静默**。 */
  problems: string[]
}

/**
 * 这条认领带来的证据里，有没有一条与公布名**同档**的 `qymc`（即「能拿去锚定」的那种）。
 *
 * 用途只有一个：同一企业、同一候选统代被两份文件分别给出时，**优先采用带可用证据的那份**。
 * 判据与计划侧同一处（`nameMatchLevel`），不在这里另写一套。
 */
function hasUsableEvidence(claim: { uscc: string; evidence?: UsccPlatformClaim['evidence'] }, name: string): boolean {
  return (claim.evidence ?? []).some((entry) => nameMatchLevel(entry?.nameRaw, name) != null)
}

/** 默认的判定文件名(5 批)。 */
export const USCC_VERDICT_FILES = [1, 2, 3, 4, 5].map((n) => `uscc-verdict-batch-${n}.json`)

/** 只认这几种 verdict 取值;别的取值记 problem 并跳过。 */
const KNOWN_VERDICTS = new Set(['resolved', 'conflict', 'not_found', 'needs_human', 'query_error'])

/**
 * 从目录里读判定文件(按固定文件名),返回归一化结果。
 *
 * 文件读不了(还没产出)不算错误 —— 报告里如实说「读到几批」即可;
 * 读到了但**内容**不合形状才是 `problem`。
 */
export function readUsccVerdicts(dir: string, files: readonly string[] = USCC_VERDICT_FILES): UsccVerdictIngest {
  const parsed: Array<{ file: string; value: UsccVerdictFile }> = []
  const missing: string[] = []
  const problems: string[] = []
  for (const file of files) {
    let raw: string
    try {
      raw = readFileSync(join(dir, file), 'utf8')
    } catch {
      missing.push(file)
      continue
    }
    try {
      const value = JSON.parse(raw) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        problems.push(`${file}: 顶层必须是对象`)
        continue
      }
      parsed.push({ file, value: value as UsccVerdictFile })
    } catch (error) {
      problems.push(`${file}: JSON 解析失败（${error instanceof Error ? error.message : String(error)}）`)
    }
  }
  // 目录里可能还有别的批次文件（例如父代理改过批次数）—— 一并列出来提醒，不自动纳入。
  let extra: string[] = []
  try {
    extra = readdirSync(dir).filter((name) => /^uscc-verdict-batch-\d+\.json$/.test(name) && !files.includes(name))
  } catch {
    /* 目录读不了：按「一批都没读到」处理，下面会如实报出来 */
  }
  const ingest = normalizeUsccVerdicts(parsed)
  if (missing.length) {
    ingest.problems.push(`以下判定文件尚未产出（按「这一批还没跑完」处理）：${missing.join('、')}`)
  }
  if (extra.length) {
    ingest.problems.push(`目录里还有未纳入的判定文件：${extra.join('、')}（请把它们也加进文件名列表再跑）`)
  }
  return ingest
}

/** 归一化(纯函数,可单测):判定文件 → 平台证据认领 + 未采纳清单。 */
export function normalizeUsccVerdicts(input: Array<{ file: string; value: UsccVerdictFile }>): UsccVerdictIngest {
  const platformClaims: UsccPlatformClaim[] = []
  /** 已采纳的认领：enterpriseId → 那条（用来判「同一企业两批结论不同时取更强」）。 */
  const seenByEnterprise = new Map<number, UsccPlatformClaim>()
  /**
   * 两家文件给出**不同**候选统代的企业 —— 两边都自称有证据，软件不替它们挑。
   * 这类企业**整体不写**（连先出现的那条也撤回），所以它既不进「已采纳」，也不被
   * 下面的「取更强结论」收敛掉。
   */
  const conflictingEnterprises = new Set<number>()
  const untouched: UsccVerdictUntouched[] = []
  const batches: UsccVerdictIngest['batches'] = []
  const problems: string[] = []

  for (const { file, value } of input) {
    const items = Array.isArray(value.items)
      ? value.items
      : Array.isArray(value.resolvedItems)
        ? value.resolvedItems
        : []
    const generatedAt = typeof value.generatedAt === 'string' && value.generatedAt.trim() ? value.generatedAt.trim() : null
    batches.push({ batch: typeof value.batch === 'number' ? value.batch : null, file, generatedAt, items: items.length })
    if (!generatedAt) {
      problems.push(`${file}: 缺 generatedAt ⇒ 该批所有条目都拿不到证据产出时刻，无法落 platform_query.queried_at，全部跳过`)
      continue
    }
    items.forEach((item, index) => {
      const where = `${file}#${index}`
      if (!item || typeof item !== 'object') {
        problems.push(`${where}: 不是对象`)
        return
      }
      const enterpriseId = typeof item.enterpriseId === 'number' ? Math.trunc(item.enterpriseId) : null
      const name = typeof item.name === 'string' ? item.name.trim() : ''
      const reason = typeof item.reason === 'string' ? item.reason.trim() : ''
      if (enterpriseId == null || !name) {
        problems.push(`${where}: 缺 enterpriseId / name`)
        return
      }
      // `verdict` **缺席**按 `resolved` 处理并记一条 problem：补充证据的交接文件
      // （`resolvedItems`）本来就不带这个字段，而它只装已转正的条目。反正采纳与否由
      // 「库里对得上」决定，缺字段不会让不该写的写进去。
      const rawVerdict = typeof item.verdict === 'string' ? item.verdict.trim() : ''
      const verdict = rawVerdict || 'resolved'
      if (!rawVerdict) {
        problems.push(`${where}: 判定文件未给 verdict ⇒ 按 resolved 处理（只作线索，采纳仍看库里证据）`)
      }
      if (!KNOWN_VERDICTS.has(verdict)) {
        problems.push(`${where}: verdict 取值未知（${verdict || '(空)'}）⇒ 跳过（不猜它能补）`)
        return
      }
      if (verdict !== 'resolved') {
        untouched.push({
          enterpriseId,
          name,
          verdict,
          reason: reason || '(判定文件未给理由)',
          blocked: typeof item.blocked === 'string' && item.blocked.trim() ? item.blocked.trim() : null,
        })
        return
      }
      const uscc = typeof item.candidateUscc === 'string' ? item.candidateUscc.trim() : ''
      if (!uscc) {
        problems.push(`${where}: verdict=resolved 但缺 candidateUscc ⇒ 跳过`)
        untouched.push({ enterpriseId, name, verdict: 'needs_human', reason: 'resolved 但没给候选统代', blocked: null })
        return
      }
      // `qymcEqualsAnnouncedName` 只是代理的**一句话**，不是我们的判据 —— 我们的判据是
      // 「库里对得上」（`nameMatchLevel` 过的那条关系），所以它**缺席或标 false 都不拦**，
      // 只把三态如实记下来（`flagState`）供报告区分。理由与父代理 ④ 同源：
      // **用代码判据，不靠代理自律**。实测批次 5 整批漏写这个字段（15 条），
      // 若因为字段缺席就整批不写，会把平台确实逐字证实过的企业留在清单里。
      // 三态之外的第四态：复查文件把它写成**字符串**（如 `"normalizeName"`，表示「只在归一化
      // 口径下相等」）。那不是布尔，但信息量比 `absent` 大，所以单列一态（`normalized`）。
      const flagState: UsccPlatformClaim['flagState'] =
        item.qymcEqualsAnnouncedName === true
          ? 'true'
          : item.qymcEqualsAnnouncedName === false
            ? 'false'
            : typeof item.qymcEqualsAnnouncedName === 'string' && item.qymcEqualsAnnouncedName.trim()
              ? 'normalized'
              : 'absent'
      // 接口取值**只认字典里的两个**：未知取值拒掉（原来「不是 apply_list 就当 business_list」是
      // 把不可信输入往一个合法类别上硬套 —— 那正是不该做的猜测）。序号也必须是正整数。
      const evidence = (Array.isArray(item.platformEvidence) ? item.platformEvidence : [])
        .filter(
          (entry) =>
            entry?.interface === 'business_list' ||
            entry?.interface === 'apply_list' ||
            entry?.interface === 'query_list',
        )
        .map((entry) => ({
          // 判定文件里 queryList 那条可能写成 `query_list`（复查文件的拼写）——它**就是**
          // `apply_list` 端点，映射过去并把原始拼写留在证据里；其余未知取值一律拒掉。
          interface: (entry.interface === 'query_list' ? 'apply_list' : entry.interface) as
            | 'business_list'
            | 'apply_list',
          rdjb: typeof entry.rdjb === 'string' ? entry.rdjb : '',
          sequenceNo: typeof entry.sequenceNo === 'number' ? Math.trunc(entry.sequenceNo) : Number.NaN,
          relationKey: typeof entry.relationKey === 'string' ? entry.relationKey : null,
          nameRaw: typeof entry.qymc === 'string' ? entry.qymc : '',
          status: typeof entry.cszt === 'string' ? entry.cszt : null,
          // 关系自己写的统代：与候选统代不一致 ⇒ 这条讲的是别的企业，计划会拒掉它。
          usccRaw: typeof entry.tyshxydm === 'string' ? entry.tyshxydm : null,
          query: typeof entry.query === 'string' ? entry.query : null,
        }))
        // 这里**只做结构过滤**（接口在字典内、序号是正整数、名称非空），**不按名称筛**：
        //  1. 平台原文与公布名常常只在**归一化口径**下相等（复查文件实测 6/6 都是
        //     `typographic` 或 `district_suffix` 档）—— 按逐字筛会把整批证据丢光，
        //     于是「判定文件里没有一条逐字相等的摘要」这种误判（`384` 就这么被卡住过）；
        //  2. 同一次返回里的**现名行**也要留住（父代理明确「seq4/5 是现名,也一并给了」）,
        //     它们进库后是「这个统代还叫过什么」的背景。
        // 名称比对的判据只有一处：计划侧 `pickSuppliedEvidence` 用 `nameMatchLevel` 挑锚点。
        .filter((entry) => Number.isInteger(entry.sequenceNo) && entry.sequenceNo >= 1 && !!entry.nameRaw)
      // **按企业去重，取最强结论**（父代理 2026-10-16 裁定）：
      // 同一家企业可能有两个称号 ⇒ 在两个批次各出现一次（实测 10 家）。两批结论不同时取
      // **更强**的那个（`resolved` > `conflict`/`needs_human` > `not_found`）——「resolved」
      // 是**有证据的**（能指名具体关系与 qymc），另一批只是**搜得浅**；
      // **不按「哪批后跑完」定案**（那是运气，不是证据）。
      // 两边都 resolved 但候选统代**不同** ⇒ 落冲突（都自称有证据，软件不替它们挑）。
      const existing = seenByEnterprise.get(enterpriseId)
      if (existing) {
        if (normalizeUscc(existing.uscc) === normalizeUscc(uscc)) {
          // 同一家企业、同一个候选统代：**哪一份能写、就用哪一份**。
          // 补充证据的交接物（`uscc-recheck-extra-*.json`）后到，而先到的可能只带来结论、
          // 没带关系摘要 —— 按「先到先得」会让这种企业停在 `no_platform_evidence`
          // （实测 507 / 384 就是这样）。所以：**后到的那份带可用证据、先到的不带** ⇒ 换成后者。
          if (!hasUsableEvidence(existing, name) && hasUsableEvidence({ uscc, evidence } as UsccPlatformClaim, name)) {
            const upgraded: UsccPlatformClaim = {
              enterpriseId,
              enterpriseName: name,
              uscc,
              evidence,
              flagState,
              reason: reason || null,
              batchRef: value.batch != null ? `uscc-verdict-batch-${value.batch}` : file.replace(/\.json$/, ''),
              observedAt: generatedAt,
            }
            platformClaims[platformClaims.indexOf(existing)] = upgraded
            seenByEnterprise.set(enterpriseId, upgraded)
            problems.push(
              `企业 ${enterpriseId}「${name}」两份文件给了同一个候选统代 ${uscc}，` +
                `${existing.batchRef} 那份没带可用的关系摘要、${upgraded.batchRef} 带了 ⇒ 采用后者作证据`,
            )
            return
          }
          untouched.push({
            enterpriseId,
            name,
            verdict: 'resolved',
            reason: `同一企业已在更早的批次文件里采纳（${existing.batchRef}，候选统代 ${existing.uscc}）⇒ 本文件不重复采纳`,
            blocked: null,
          })
          return
        }
        problems.push(
          `${where}: 同一企业 ${enterpriseId} 在 ${existing.batchRef} 与本文件各有一个**不同**的候选统代` +
            `（${existing.uscc} / ${uscc}）⇒ 两批都自称有证据，不猜，本条转冲突待核`,
        )
        conflictingEnterprises.add(enterpriseId)
        untouched.push({
          enterpriseId,
          name,
          verdict: 'conflict',
          reason:
            `同一企业在两份判定文件里有两个不同候选统代（${existing.uscc} / ${uscc}）` +
            '⇒ 两边都自称有证据，**不猜**，该企业整体不写',
          blocked: null,
        })
        return
      }
      const claim: UsccPlatformClaim = {
        enterpriseId,
        enterpriseName: name,
        uscc,
        evidence,
        flagState,
        reason: reason || null,
        // 批次号缺失时用**文件名**（`uscc-recheck-extra-2.json` 这类补充交接物没有 `batch`）——
        // 证据出处必须可指回一份具体的文件。
        batchRef: value.batch != null ? `uscc-verdict-batch-${value.batch}` : file.replace(/\.json$/, ''),
        observedAt: generatedAt,
      }
      platformClaims.push(claim)
      seenByEnterprise.set(enterpriseId, claim)
    })
  }

  // **取最强结论**的收尾：一家企业只要有一份文件给出可采纳的 `resolved`，它就**不再**
  // 出现在「不动库」清单里 —— 否则同一条会既算补齐又算冲突（实测 10 家企业在两批里各出现一次，
  // 其中 9 家被「更强结论」收敛掉）。缺席的那几条留在 `problems` 里说明，不静默。
  // 候选统代打架的企业先整体撤回（不许「先出现的那条」偷偷写进去）。
  const finalClaims = platformClaims.filter((claim) => {
    if (claim.enterpriseId == null || !conflictingEnterprises.has(claim.enterpriseId)) return true
    problems.push(
      `企业 ${claim.enterpriseId}「${claim.enterpriseName}」的候选统代在两份文件里不一致 ⇒ ` +
        `撤回先前采纳的 ${claim.uscc}，该企业整体不写`,
    )
    return false
  })
  const accepted = new Set(finalClaims.map((claim) => claim.enterpriseId))
  const converged: UsccVerdictUntouched[] = []
  /** 企业 → 已经写进「不动库」清单的那一条（**按企业去重**，见下）。 */
  const keptByEnterprise = new Map<number, UsccVerdictUntouched>()
  const rank: Record<string, number> = { resolved: 3, conflict: 2, needs_human: 2, not_found: 1 }
  for (const row of untouched) {
    if (row.enterpriseId == null) {
      converged.push(row)
      continue
    }
    if (accepted.has(row.enterpriseId)) {
      problems.push(
        `企业 ${row.enterpriseId}「${row.name}」在某份判定文件里的结论是 ${row.verdict}，` +
          `但另一份给出了可采纳的 resolved ⇒ 按「取更强结论」收敛为已补齐，本条不再计入冲突/未找到/待人工`,
      )
      continue
    }
    // **按企业去重、取更强结论**：同一家企业可能在两批里各有一条结论不同的记录
    // （两个称号 / 复查改判）。五桶计数是**按企业**的，所以这里每个企业只留一条 ——
    // 「更强」= `resolved` > `conflict`/`needs_human` > `not_found`。
    // （实测 2411 在三份文件里各出现一次：conflict / not_found / not_found。）
    const kept = keptByEnterprise.get(row.enterpriseId)
    if (!kept) {
      keptByEnterprise.set(row.enterpriseId, row)
      converged.push(row)
      continue
    }
    if ((rank[row.verdict] ?? 0) > (rank[kept.verdict] ?? 0)) {
      problems.push(
        `企业 ${row.enterpriseId}「${row.name}」在不同判定文件里的结论不一致` +
          `（${kept.verdict} / ${row.verdict}）⇒ 按「取更强结论」留 ${row.verdict}`,
      )
      keptByEnterprise.set(row.enterpriseId, row)
      converged[converged.indexOf(kept)] = row
    } else {
      problems.push(
        `企业 ${row.enterpriseId}「${row.name}」重复出现在多份判定文件里（${kept.verdict} 与 ${row.verdict}）` +
          '⇒ 按企业去重，保留更强的那条',
      )
    }
  }
  return { platformClaims: finalClaims, untouched: converged, batches, problems }
}
