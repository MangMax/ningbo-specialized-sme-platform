/**
 * 文件库(`app/files/`)元数据的**纯规则**:从相对路径反推分类(来源 / 类别 / 年份 / 批次),
 * 以及由文件名取扩展名。
 *
 * 目录规则见 `files/README.md`:
 *
 *     files/<source>/<kind>/<year>/<batch>/<filename>
 *
 * `year` / `batch` 为**可选段**(导出表无年份批次;年份区间无批次)。见票 09
 * (`.scratch/ingest-pipeline/issues/09-file-manager.md`)。
 *
 * ── 复用说明 ─────────────────────────────────────────────────────────────
 * 本文件的两段规则**照抄自项目外的 pipeline,不另发明一套**(票 09 允许,并要求注明来源):
 *
 *  - `parseBatch`  ← `pipeline/src/normalize.ts`
 *  - `resolveJxjParts` 的取段思路 ← `pipeline/src/files.ts`
 *
 * app 是**独立可部署的只读看板**,不能 import `../pipeline`(它在本仓之外,
 * 见 `docs/adr/2026-10-13-ingestion-is-outside-the-app.md`),故照抄一份并在此标注。
 * **若 pipeline 侧改了规则,这里必须同步** —— 两处不一致会让回填出来的元数据与导入口径漂移。
 * ─────────────────────────────────────────────────────────────────────────
 */

/** 文件库来源代号。与 `pipeline/src/files.ts` 的 `FileSource` 一致。 */
export type FileSource = 'jxj' | 'miit'
/** 文件库类别。与 `pipeline/src/files.ts` 的 `FileKind` 一致。 */
export type FileKind = 'announcement' | 'export'
/** 分类状态。`set` 已定 / `inferred` 程序推的 / `unset` 未定。 */
export type CategoryState = 'set' | 'inferred' | 'unset'
/** 解析状态。 */
export type ParseState = 'unparsed' | 'parsed' | 'failed'

/** 分类与磁盘事实。`year` / `batch` 可空 —— 「上传时未定、后续回写」(票 12)。 */
export interface FileParts {
  source: FileSource
  kind: FileKind
  year: number | null
  batch: number | null
}

/** 一轮推导的结果:分类 + 由分类完整性得出的状态。 */
export interface DerivedParts extends FileParts {
  categoryState: CategoryState
}

/**
 * 中文数字(含「十二」「二十三」这类)转阿拉伯数字。
 *
 * **照抄自 `pipeline/src/normalize.ts`**(该文件是 pipeline 的归一化内核)。
 */
const CN_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
}

/**
 * 解析批次文本。支持 `2024-1`、`2025-2`、`2022`、`2024年度第一批`、`第一批`。
 * 年份缺失时 year 为 null;批次缺失时 seq 为 null。
 *
 * **照抄自 `pipeline/src/normalize.ts` 的同名函数**(逐行一致,含年份区间的处理)。
 */
export function parseBatch(text: string | number | boolean | null | undefined): {
  year: number | null
  seq: number | null
} {
  const s = String(text ?? '')

  // 年份区间如 `2021-2022` 不是「年-批次」,取首年、无批次。
  const range = s.match(/(19|20)\d{2}\s*[-–—~至]\s*(19|20)\d{2}/)
  if (range) return { year: Number(range[0].match(/(19|20)\d{2}/)![0]), seq: null }

  const yearMatch = s.match(/(19|20)\d{2}/)
  const year = yearMatch ? Number(yearMatch[0]) : null

  // 批次:优先「第 N 批」(阿拉伯数字),其次 `-N`,再次汉字批次号。
  const seqText = s.match(/第\s*(\d+)\s*批/)?.[1] ?? s.match(/-(\d+)\b/)?.[1]
  const seq =
    seqText !== undefined
      ? Number(seqText)
      : (CN_DIGITS[s.match(/第\s*([一二三四五六七八九十])\s*批/)?.[1] ?? ''] ?? null)
  return { year, seq }
}

/** 目录名前缀数字(`01第一批公布` → `1`);无则 null。与 `pipeline/src/files.ts` 同。 */
function leadingNumber(name: string): number | null {
  const m = name.match(/^(\d+)/)
  return m ? Number(m[1]) : null
}

/**
 * 经信局公布文件的年份 / 批次。**取段思路照抄 `pipeline/src/files.ts` 的 `resolveJxjParts`**,
 * 并按**文件库的目录形状**改写取段方式:
 *
 * pipeline 的版本对着**数据根**跑,那里批次是目录名(`01第一批公布`),所以它靠
 * 「含『第』且含『批』」找批次段。文件库 `files/` 把 year/batch 落成**独立的第 3、4 段**
 * (见 `files/README.md`),批次段只剩一个纯数字(`1`)—— 用同一条判据找不到它。
 * 故这里改为:年份取四位年份段,批次取**四位年份段之后**的那个纯数字段。
 *
 * 两者一致的部分(也是本函数真正复用的规则):**年份一律取目录,不取文件名** ——
 * 文件名里的年份常是复核的**原始认定年份**(如 2024 年发布的「2021 年度第一批复核」),
 * 取文件名会串年份。目录结构才是按公布年份组织的。
 *
 * 目录给不出时回退文件名解析(`files/README.md`「year/batch 取值」第 3 条,与 pipeline 相同),
 * 仍无则对应段为 null。**注意这个兜底的风险**:文件名里的四位数字可能是**文号**年份而非公布年份
 * (如 `〔2024〕19号关于公布2023年第二批…`),一旦取错就是错值。所以这里**目录有就绝不用文件名**;
 * 正常文件库里 year/batch 段一定在(文件就是按年/批次分层放的),兜底几乎不会走到。
 */
export function resolveJxjParts(relPath: string, filename: string): FileParts {
  const segments = relPath.split('/').slice(0, -1) // 去掉文件名
  // 去掉 `<source>/<kind>` 两段,剩下的是分类段(year?、batch?)与可能的消歧子目录段。
  const parts = segments.slice(2)

  const yearIdx = parts.findIndex((s) => /^(19|20)\d{2}$/.test(s))
  const dirYear = yearIdx >= 0 ? Number(parts[yearIdx]) : null

  // 批次 = 年份段**之后**的第一个纯数字段。消歧子目录(`省专` / `创新型`)不是数字,不受影响。
  const afterYear = yearIdx >= 0 ? parts.slice(yearIdx + 1) : []
  const batchSeg = afterYear.find((s) => /^\d+$/.test(s))
  const dirBatch = batchSeg !== undefined ? leadingNumber(batchSeg) : null

  const fileBatch = parseBatch(filename)

  return {
    source: 'jxj',
    kind: 'announcement',
    year: dirYear ?? fileBatch.year,
    batch: dirBatch ?? fileBatch.seq,
  }
}

/** 取小写扩展名(不含点);无扩展名返回空串。与 `pipeline/src/files.ts` 的 `extname` 同口径。 */
export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

/** 路径末段(文件名)。 */
export function baseName(relPath: string): string {
  return relPath.split('/').pop() ?? relPath
}

/**
 * 路径的**目录段**(去掉文件名);根下的文件返回空串。
 *
 * 与 `baseName` 成对放在这里:`baseName` 是「取末段」,它是「取其余」—— 两处各写一份
 * `lastIndexOf('/')` 的话,改了一处另一处就漂(库内路径一律 `/` 分隔,与
 * `stored_file.rel_path` 同口径)。
 */
export function directoryOf(relPath: string): string {
  const i = relPath.lastIndexOf('/')
  return i < 0 ? '' : relPath.slice(0, i)
}

/**
 * 由相对路径反推分类。
 *
 * - `jxj/announcement/…` → 经信局公布文件,年份/批次按目录(回退文件名);
 * - `miit/export/…`      → 工信部导出表,**无年份批次**(与 pipeline 一致)。
 *
 * 认不出的路径(既非 jxj 也非 miit 开头)返回 `null` —— 回填时**跳过**,不猜。
 */
export function deriveParts(relPath: string): FileParts | null {
  const filename = baseName(relPath)
  const segments = relPath.split('/')
  const source = segments[0]
  const kind = segments[1]

  if (source === 'jxj' && kind === 'announcement') {
    return resolveJxjParts(relPath, filename)
  }
  if (source === 'miit' && kind === 'export') {
    return { source: 'miit', kind: 'export', year: null, batch: null }
  }
  return null
}

/**
 * 分类状态:**分类是否已定**。
 *
 * 导出表只要来源与类别在就够(它本来就没有年份批次);公布文件要**年份在**才算定 ——
 * 没有年份的公布文件(如目录给不出、文件名也无年份)归入 `unset`,交票 12 回写,
 * 而不是硬填一个年份(**空值优于错值**,见 data-integrity SPEC 的安全阀)。
 */
export function categoryStateOf(parts: FileParts): CategoryState {
  if (parts.kind === 'export') return 'set'
  return parts.year !== null ? 'set' : 'unset'
}

/** 由相对路径直接得出分类 + 状态;认不出返回 null。 */
export function deriveClassification(relPath: string): DerivedParts | null {
  const parts = deriveParts(relPath)
  return parts ? { ...parts, categoryState: categoryStateOf(parts) } : null
}
