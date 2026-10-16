/**
 * 文件库的**入库范围规则** —— 「哪些文件该进文件库」的**单一出处**(RL-16,票 #17)。
 *
 * ── 为什么要单独一个模块 ──────────────────────────────────────────────
 * 用户反馈过两次同类问题:「文件库中多出了两个 doc 和一个入库培育文件,他们应该就不入库才对」。
 * 根因不是某一次操作做错了,而是**「该不该入库」这条规则没有落成代码** —— 它散在
 * `files/README.md` 的散文里、pipeline 的脚本里、以及人的记忆里。于是每次搬运都可能再混进来。
 *
 * 这里把它写成**纯函数**:给一个库内相对路径 + 它的同目录兄弟名,回答「入不入库、为什么」。
 * 由 `server/utils/stored-files.ts` 的回填(`backfillStoredFiles`)执行 —— 规则被**真的用上**,
 * 而不只是被写下来。
 *
 * ── 与项目外 pipeline 的关系(边界)────────────────────────────────────
 * app **不能** import 项目外的 `../pipeline`(见
 * `docs/adr/2026-10-13-ingestion-is-outside-the-app.md`),而这条规则的另一半 ——
 * **来源侧的收录范围**(扫哪些目录、跳过哪些扩展名)—— 住在 `pipeline/src/files.ts`
 * 的 `scanSources()` 里。两边必须同口径,故:
 *
 *  | 判据 | 来源侧(pipeline `scanSources`) | 库内(本模块) |
 *  |---|---|---|
 *  | 扫哪些子树 | 只扫 `经信局名单/{省专,创新型}` + `工信部名单/*.xlsx` | `<source>/<kind>/` 规则之内(`lib/stored-file.ts` 的 `deriveParts`) |
 *  | 通知类 | **目录段**含「通知」的一律不收 | 同左 —— 但库内路径已经丢掉了来源目录,故这一条只在来源侧执行 |
 *  | 入库培育 | 文件名含「入库培育」 | 文件名含「入库培育」 |
 *  | 重复 DOC/DOCX | `.doc` 与转出件 `.docx` 并存,保留**可预览的** `.docx` | 同左 |
 *  | 人工 OCR 的 `.docx` | 不内化与 PDF 同名的 `.docx` | 同左 |
 *
 * **来源侧那段我没有改动权**(禁令:不要动项目外 `pipeline/`),所以本模块只覆盖
 * 「已经落在 `files/` 里的文件该怎么裁」。来源侧的收录范围与本文档同口径 —— 见
 * `files/README.md` 的「入库范围」一节,以及 `.agents/skills/roster-ingestion-pipeline/`。
 *
 * ── 判据为什么用「同目录兄弟名」而不是读文件内容 ─────────────────────────
 * 「重复 DOC/DOCX」与「PDF 同名的 OCR 产物」这两条本质上都是**同名兄弟**的关系:
 * 同一个 stem 下并存 `.doc`/`.docx`、或 `.pdf`/`.docx`。读内容判不出来(内容本就不同:
 * 一份是二进制 `.doc`,一份是转出的 OOXML),而**文件名**把这个关系记得清清楚楚。
 * 于是判据 = 兄弟名集合,调用方(回填)本来就在扫整个目录,顺手就有。
 */

import { baseName, extensionOf } from './stored-file'

/** 入库范围判定的**原因码**。`in-scope` 是唯一「入库」的取值。 */
export type StoreScopeReason =
  /** 在范围内 —— 入库。 */
  | 'in-scope'
  /** 文件名含「入库培育」:是**培育对象**,不构成称号 ⇒ 不入库。 */
  | 'nurture'
  /** `.doc` 且同目录有同名 `.docx`:重复的旧版二进制件,只保留**可预览的** `.docx`。 */
  | 'duplicate-doc'
  /** `.docx` 且同目录有同名 `.pdf`:人工 OCR 产物,PDF 才是权威原件且可内联预览。 */
  | 'human-ocr-docx'

/** 不入库判定的中文说明(逐条),给回填报告与验收输出直接用。 */
const DETAIL: Record<StoreScopeReason, string> = {
  'in-scope': '在入库范围内',
  nurture: '文件名含「入库培育」—— 培育对象不构成称号,按 files/README.md 排除',
  'duplicate-doc': '同目录已有同名 .docx(可预览的转出件)—— 重复的旧版 .doc 不入库',
  'human-ocr-docx': '同目录已有同名 .pdf —— 该 .docx 是人工 OCR 产物,PDF 才是权威原件',
}

/** 判定结果。 */
export interface StoreScopeVerdict {
  inScope: boolean
  reason: StoreScopeReason
  /** 一句话说明(中文),可直接进回填报告 / 验收输出。 */
  detail: string
}

/** 排除 **入库培育** 文件的关键词。与 `pipeline/src/files.ts` 的判据、`files/README.md` 同字面量。 */
export const NURTURE_KEYWORD = '入库培育'

/** 一份排除判定。 */
function exclude(reason: StoreScopeReason): StoreScopeVerdict {
  return { inScope: false, reason, detail: DETAIL[reason] }
}

/** 文件名去掉扩展名(保留点之前的全部内容,含中文书名号与文号)。 */
function stemOf(filename: string): string {
  const ext = extensionOf(filename)
  return ext === '' ? filename : filename.slice(0, filename.length - ext.length - 1)
}

/** 目录段(去掉文件名);根下的文件返回空串。 */
export function directoryOf(relPath: string): string {
  const i = relPath.lastIndexOf('/')
  return i < 0 ? '' : relPath.slice(0, i)
}

/**
 * 一份文件的**同目录兄弟名**集合。回填把扫到的全部文件喂进来一次即可。
 *
 * 键是目录(库内相对路径的目录段),值是该目录下**全部**文件名。
 */
export function siblingIndex(relPaths: Iterable<string>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>()
  for (const relPath of relPaths) {
    const dir = directoryOf(relPath)
    const name = baseName(relPath)
    const set = index.get(dir)
    if (set) set.add(name)
    else index.set(dir, new Set([name]))
  }
  return index
}

/**
 * 判一份文件该不该进文件库。
 *
 * @param relPath 库内相对路径(`/` 分隔,与 `stored_file.rel_path` 同口径)。
 * @param siblings **同目录**下的全部文件名(含本文件自己)。缺省当成空集合 —— 此时
 *   「同名兄弟」两条判据自然不成立,即**没有兄弟就不算重复**,与语义一致。
 */
export function scopeOf(relPath: string, siblings?: ReadonlySet<string>): StoreScopeVerdict {
  const filename = baseName(relPath)

  // 1. 入库培育:文件名判据,与 pipeline / README 同一条(来源侧与库内都能判,故两处都留)。
  if (filename.includes(NURTURE_KEYWORD)) return exclude('nurture')

  const ext = extensionOf(filename)
  if (ext !== 'doc' && ext !== 'docx') return { inScope: true, reason: 'in-scope', detail: DETAIL['in-scope'] }

  const stem = stemOf(filename)
  // 2. 旧版二进制 `.doc` 与转出件并存 ⇒ 只留可预览的 `.docx`(用户 2026-10-16 口径)。
  if (ext === 'doc' && siblings?.has(`${stem}.docx`)) return exclude('duplicate-doc')
  // 3. `.docx` 与 PDF 同名 ⇒ 人工 OCR 产物;PDF 可内联预览且是权威原件。
  if (ext === 'docx' && siblings?.has(`${stem}.pdf`)) return exclude('human-ocr-docx')

  return { inScope: true, reason: 'in-scope', detail: DETAIL['in-scope'] }
}

/**
 * 规则全表(判据 → 处置),给文档与验收核对用 —— **一处定义、多处引用**:
 * `files/README.md` 与清理技能里的那张表就该是这几行,不另抄一份。
 */
export const STORE_SCOPE_RULES: ReadonlyArray<{
  reason: StoreScopeReason
  criterion: string
  disposition: string
}> = [
  { reason: 'nurture', criterion: '文件名含「入库培育」', disposition: '不入库(已入库的移出;不构成称号,无历史可丢)' },
  { reason: 'duplicate-doc', criterion: '.doc 且同目录有同名 .docx', disposition: '不入库(重复件;保留可预览的 .docx)' },
  { reason: 'human-ocr-docx', criterion: '.docx 且同目录有同名 .pdf', disposition: '不入库(PDF 才是权威原件且可内联预览)' },
  { reason: 'in-scope', criterion: '其余落在 <source>/<kind>/ 规则内的文件', disposition: '入库' },
]
