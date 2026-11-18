import { TUS_ENDPOINT, baseName, targetsEndpoint, type PreviousUpload } from '../../core/lib/upload-transport'
/**
 * 上传的**纯模型层**:落位元数据的形状、可取的值、从文件名推导,以及把
 * 服务器/网络的失败翻译成一句人看得懂的话。
 *
 * 这里不碰 tus-js-client,也不碰 Vue —— 组件只负责把它接起来,规则本身可以单测。
 *
 * 契约来源:`app/server/utils/tus.ts`(端点与 metadata 白名单)与
 * `app/lib/file-store-scope.ts`(文件库目录规则 `files/<source>/<kind>/<year>/<batch>/<filename>`)。
 * 客户端在此**声明**元数据,服务端**裁决**落位;声明错了会被 400 挡回来。
 */

import { KIND_ORDER, KINDS, SOURCE_ORDER, SOURCES } from './labels'

/** 来源白名单:经信局 / 工信部。 */
export type SourceCode = 'jxj' | 'miit'

/** 类别白名单:公布文件 / 导出表。 */
export type KindCode = 'announcement' | 'export'

/**
 * **一批文件的**落位声明:`source` / `kind` 必填,`year` / `batch` 可省略
 * (省略即不落那一段,如导出表没有批次)。
 *
 * 文件名**不在这里** —— 它由投放的文件自带,不是让人手填的字段
 * (手填会和实际文件对不上)。到发请求时才和它拼成 `UploadMetadata`。
 */
export interface BatchMeta {
  source: SourceCode | ''
  kind: KindCode | ''
  /** 四位年份。留空则省略该段。 */
  year: string
  /** 批次号(阿拉伯数字)。留空则省略该段;填了就必须同时有 year。 */
  batch: string
}

/** 真正发进 `Upload-Metadata` 的完整声明(批次字段 + 该文件的文件名)。 */
export interface UploadMetadata extends BatchMeta {
  /** 原文件名,保留文号与中文书名号。 */
  filename: string
}

/** 空的批次声明:两个选择未定,年份批次留空。 */
export function emptyBatchMeta(): BatchMeta {
  return { source: '', kind: '', year: '', batch: '' }
}

/**
 * 选择框用的取值,顺序即展示顺序 —— **中文一律取 `layers/sme-roster/lib/labels.ts` 的单一来源**,
 * 不在这里另写一份(那正是「经信局」在多处漂移的来路)。`layers/sme-roster/lib/labels.ts` 是纯数据、
 * 客户端可安全引用(它只依赖 `db/titles.ts` 的静态种子,不碰 better-sqlite3)。
 */
export const SOURCE_OPTIONS: ReadonlyArray<{ value: SourceCode; label: string }> =
  SOURCE_ORDER.map((value) => ({ value: value as SourceCode, label: SOURCES[value] ?? value }))

export const KIND_OPTIONS: ReadonlyArray<{ value: KindCode; label: string }> = KIND_ORDER.map(
  (value) => ({ value: value as KindCode, label: KINDS[value] ?? value }),
)

const SOURCE_VALUES = new Set<string>(SOURCE_OPTIONS.map((o) => o.value))
const KIND_VALUES = new Set<string>(KIND_OPTIONS.map((o) => o.value))

/** 中文数字(含「十二」「二十三」这类)转阿拉伯数字。 */
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

function cnNumberToInt(text: string): number | undefined {
  if (/^\d+$/.test(text)) return Number(text)
  if (text === '十') return 10
  if (!text.includes('十')) return CN_DIGITS[text]
  const [tens = '', ones = ''] = text.split('十')
  const tensPart = tens === '' ? 1 : (CN_DIGITS[tens] ?? 0)
  const onesPart = ones === '' ? 0 : (CN_DIGITS[ones] ?? 0)
  const value = tensPart * 10 + onesPart
  return value > 0 ? value : undefined
}

/**
 * 从文件名**推导**批次声明:只填有把握的,拿不准的空着交给用户。
 *
 * 有一条规则刻意不猜:**`kind` 不按扩展名(是不是 xlsx)猜**。经信局的公布文件里
 * 也有 `.xlsx` 附件(见 `lib/file-store-scope.ts` 关于 `.docx` 的说明),扩展名判不出来源目录,
 * 猜错会把文件落进错的格子 —— 不如空着让人选。反过来,`.xlsx` 必属工信部导出表,
 * 所以**来源**这一项可以由扩展名定。
 */
export function suggestBatch(filename: string): Partial<BatchMeta> {
  const suggestion: Partial<BatchMeta> = {}

  if (/\.xlsx$/i.test(filename)) {
    suggestion.source = 'miit'
    suggestion.kind = 'export'
  }

  // 年份:四位数,取文件名里第一个出现的那一个。
  const yearMatch = filename.match(/(?:19|20)\d{2}/)
  if (yearMatch) suggestion.year = yearMatch[0]

  // 批次:「第一批」「第10批」。解析不出就不填。
  const batchMatch = filename.match(/第\s*([0-9一二三四五六七八九十]+)\s*批/)
  if (batchMatch) {
    const batch = cnNumberToInt(batchMatch[1]!.trim())
    if (batch !== undefined && batch > 0) suggestion.batch = String(batch)
  }

  return suggestion
}

/** 用户是否能现在提交:两项必需声明定下来才放行。 */
export function isBatchComplete(meta: BatchMeta): boolean {
  return SOURCE_VALUES.has(meta.source) && KIND_VALUES.has(meta.kind)
}

/**
 * 落位路径,**相对文件库根**(`files/`)。与服务端 `landingSegments` 同一条规则,
 * 值得注意:返回值与 `record_evidence.source_file` 存的口径一致。
 *
 * 客户端只用它**预览**;真正裁决在服务端。
 */
export function landingPath(meta: UploadMetadata): string {
  return [meta.source, meta.kind, meta.year.trim(), meta.batch.trim(), baseName(meta.filename.trim())]
    .filter((segment) => segment.length > 0)
    .join('/')
}

/**
 * 拼出真正发出去的 `Upload-Metadata`(明文;`tus-js-client` 会做 base64 编码)。
 *
 * `year` / `batch` 为空时**不带这个键**(见 `metadataPayload`),不要发空串 ——
 * 服务端把空串当缺省,但少发一个键更不容易误读。
 */
export function buildMetadata(batch: BatchMeta, filename: string): UploadMetadata {
  return {
    source: batch.source,
    kind: batch.kind,
    year: batch.year.trim(),
    batch: batch.batch.trim(),
    filename: baseName(filename.trim()),
  }
}

/** 发请求时真正带上的键值对(丢掉空的 year/batch)。 */
export function metadataPayload(meta: UploadMetadata): Record<string, string> {
  const payload: Record<string, string> = {
    source: meta.source,
    kind: meta.kind,
    filename: meta.filename,
  }
  if (meta.year) payload.year = meta.year
  if (meta.batch) payload.batch = meta.batch
  return payload
}

/**
 * 断点续传的匹配键,必须**恰好**包含会改变落位结果的那些字段。
 *
 * 只给文件名不够:同一份文件改了年份/批次再传,就是往另一个格子放**另一份**文件,
 * 不能续到旧上传上(否则会把新声明配上旧落位)。`source/kind/year/batch/filename`
 * 都进键,加上 `size` 防同名不同体,再加端点防跨端点串。
 */
export function resumeKey(
  file: { name: string; size: number },
  meta: BatchMeta,
  endpoint: string = TUS_ENDPOINT,
): string {
  return [
    'spztx-upload',
    endpoint,
    meta.source,
    meta.kind,
    meta.year.trim(),
    meta.batch.trim(),
    baseName(file.name),
    String(file.size),
  ].join('|')
}

/**
 * 从历史上传里挑出**能续**的那一条:元数据逐字段相符,且上传地址指向同一个端点。
 *
 * 这是本项目里一个**静默出错**的陷阱,必须显式挡住:`findUploadsByFingerprint`
 * 的默认键是「文件名 + 大小 + 类型 + 最后修改时间 + 端点」,里面**没有**元数据。
 * 换一个批次、重新提交同一份文件,它会返回上一次那条记录;直接
 * `resumeFromPreviousUpload()` 就把**新声明**的年份/批次接到了**旧落位**上 ——
 * 上传照样 204 成功,文件却进了错的目录,而且全程没有任何报错。
 *
 * 本组件用自定义 fingerprint(见 `resumeKey`)已经把元数据并进键里,这里是第二道闸:
 * 键算错了、或存储里留了旧版本的条目,也不会把文件送错格子。
 */
export function matchPreviousUpload(
  candidates: PreviousUpload[],
  file: { name: string; size: number },
  meta: UploadMetadata,
  endpoint: string = TUS_ENDPOINT,
  origin: string | undefined = typeof location !== 'undefined' ? location.origin : undefined,
): PreviousUpload | undefined {
  const [, , source, kind, year, batch, filename] = resumeKey(file, meta, endpoint).split('|')
  const matches = candidates.filter((candidate) => {
    const stored = candidate.metadata ?? {}
    if (stored.source !== source) return false
    if (stored.kind !== kind) return false
    if ((stored.year ?? '') !== year) return false
    if ((stored.batch ?? '') !== batch) return false
    if (stored.filename !== filename) return false
    if (candidate.size != null && String(candidate.size) !== String(file.size)) return false
    if (candidate.uploadUrl && !targetsEndpoint(candidate.uploadUrl, endpoint, origin)) return false
    return true
  })
  // 同一份文件与同一组声明可能留下多条(上次中断后又被选入过);取最新的一条续。
  return matches.sort((a, b) => Date.parse(b.creationTime) - Date.parse(a.creationTime))[0]
}

/** 元数据填充的**实时**校验提示:即时告诉用户哪儿还不对,而不是等 400。 */
export function validateBatch(meta: BatchMeta): string[] {
  const problems: string[] = []
  if (!SOURCE_VALUES.has(meta.source)) problems.push('请选择来源')
  if (!KIND_VALUES.has(meta.kind)) problems.push('请选择类别')

  const year = meta.year.trim()
  const batch = meta.batch.trim()
  if (year && !/^\d{4}$/.test(year)) problems.push('年份要四位数字')
  if (batch) {
    if (!/^\d+$/.test(batch)) problems.push('批次要数字')
    else if (!year) problems.push('填了批次就要同时填年份')
  }
  return problems
}
