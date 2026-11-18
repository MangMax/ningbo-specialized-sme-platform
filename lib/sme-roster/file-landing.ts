import type { UploadMetadata } from '../core/file-categories'

/** `source` 白名单:经信局 / 工信部。 */
const SOURCES = new Set(['jxj', 'miit'])
/** `kind` 白名单:公布文件 / 导出表。 */
const KINDS = new Set(['announcement', 'export'])

export function matchesLandingPath(relPath: string): boolean {
  const [source = '', kind = '', filenameOrDirectory] = relPath.split('/')
  return filenameOrDirectory !== undefined && SOURCES.has(source) && KINDS.has(kind)
}

/**
 * 校验失败一律以 tus 约定的形状抛出:`status_code` + `body`。
 * `@tus/server` 的 `handler()` 会读 `error.status_code` 作为响应码
 * (见 node_modules/@tus/server/dist/server.js 的 onError)。
 */
function badRequest(message: string): never {
  throw { status_code: 400, body: `${message}\n` }
}

/** 安全的单段名称:非空、无路径分隔符、无 NUL、不是 `.`/`..`。 */
function isSafeSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  )
}

/** `year`:四位阿拉伯数字。 */
function isYear(value: string): boolean {
  return /^\d{4}$/.test(value)
}

/** `batch`:阿拉伯数字(规则里批次是 1、2…)。 */
function isBatch(value: string): boolean {
  return /^\d+$/.test(value)
}

/**
 * `filename`:非空白、无 `/` `\` NUL、不含 `..`(防路径穿越),且不是 `.`/`..`。
 * 文件名**原样保留**(含文号与中文书名号),只做安全校验、不规范化。
 */
function isSafeFilename(value: string): boolean {
  return isSafeSegment(value) && value.trim().length > 0 && !value.includes('..')
}

/**
 * 裁决:把客户端声明的 metadata 解析成落位路径的**段序列**
 * `[source, kind, year?, batch?, filename]`。
 *
 * 客户端只「声明」,服务端「裁决」——非法一律 400:
 *  - `source` 必填且 ∈ {jxj, miit}
 *  - `kind`   必填且 ∈ {announcement, export}
 *  - `filename` 必填且安全(防路径穿越)
 *  - `year`   可选,给了就必须四位数字
 *  - `batch`  可选,给了就必须是数字,且**必须同时有 year**(batch 嵌在 year 之下)
 *
 * `year`/`batch` 缺省时**省略对应段**(与 `lib/sme-roster/file-store-scope.ts` 规则一致,如导出表无批次)。
 */
export function landingSegments(metadata: UploadMetadata): string[] {
  const source = metadata.source ?? undefined
  const kind = metadata.kind ?? undefined
  const filename = metadata.filename ?? undefined
  let year = metadata.year ?? undefined
  let batch = metadata.batch ?? undefined

  if (!source) badRequest('缺少 source')
  if (!SOURCES.has(source)) badRequest(`source 不在白名单: ${source}`)
  if (!kind) badRequest('缺少 kind')
  if (!KINDS.has(kind)) badRequest(`kind 不在白名单: ${kind}`)
  if (!filename) badRequest('缺少 filename')
  if (!isSafeFilename(filename)) badRequest(`filename 非法: ${filename}`)

  // 空串等同于缺省。
  if (year === '') year = undefined
  if (batch === '') batch = undefined

  if (year !== undefined && !isYear(year)) badRequest(`year 必须是四位数字: ${year}`)
  if (batch !== undefined) {
    if (!isBatch(batch)) badRequest(`batch 必须是数字: ${batch}`)
    if (year === undefined) badRequest('batch 需要同时提供 year')
  }

  const segments = [source, kind]
  if (year) segments.push(year)
  if (batch) segments.push(batch)
  segments.push(filename)
  return segments
}
