import { createReadStream, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { resolveInsideRoot } from '../../utils/stored-files'

/**
 * 按台账「出处」路径读取来源文件,供预览组件使用。
 *
 * 文件库是 app 内的 `files/`(约定见 files/README.md):记录里的
 * `record_evidence.source_file` 存**相对该目录**的路径,如
 * `jxj/announcement/2024/1/甬经信中小〔2024〕72号….pdf`。
 * 这里把它交给浏览器里的预览器。
 *
 * 安全边界(这个接口能读到磁盘上的任意文件,必须自己把关):
 *  1. **锁根**:所有路径先相对文件库根(`runtimeConfig.filesDir`)解析,解析结果必须仍在根内。
 *     用 resolve 之后再比对前缀,而不是字符串过滤 `..` —— 符号链接和
 *     编码变体都绕不过 resolve。
 *  2. **白名单扩展名**:只放预览支持的那几种,不给一个通用文件服务器。
 *  3. **只读**:只实现 GET,没有写入面。
 */

/**
 * 文件库根目录。
 *
 * 走 `runtimeConfig.filesDir`,与 tus 上传写入的目标目录**同一个来源**
 * (见 `server/utils/tus.ts` 的 `filesDir()`)。两边各读各的常量会出现
 * 「tus 按 NUXT_FILES_DIR 写到别处、预览仍读 <cwd>/files」这种只在部署时才暴露的错位。
 */
function filesRoot(): string {
  return resolve(useRuntimeConfig().filesDir)
}

/** 预览支持的扩展名,与 lib/preview.ts 的 BY_EXTENSION 保持一致。 */
const ALLOWED = new Set([
  '.docx',
  '.xlsx',
  '.xlsm',
  '.pptx',
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.avif',
  '.bmp',
  '.svg',
])

const MIME: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
}

export default defineEventHandler((event) => {
  const raw = getRouterParam(event, 'path')
  if (!raw) {
    throw createError({ statusCode: 400, statusMessage: '缺少文件路径' })
  }

  // 路由参数可能是数组(带斜杠的路径),拼回一条相对路径。
  const requested = Array.isArray(raw) ? raw.join('/') : raw
  const decoded = decodeURIComponent(requested)

  const root = filesRoot()
  const abs = resolveInsideRoot(root, normalize(decoded))

  // 锁根:解析之后必须仍在根目录之内(判据集中在 `resolveInsideRoot`,
  // 与删除、上传登记共用一处 —— 各写一份的话修一处漏两处)。
  if (!abs) {
    throw createError({ statusCode: 403, statusMessage: '路径越界' })
  }

  const ext = extname(abs).toLowerCase()
  if (!ALLOWED.has(ext)) {
    throw createError({
      statusCode: 415,
      statusMessage: `不支持的文件类型 ${ext || '(无扩展名)'}`,
    })
  }

  let stat
  try {
    stat = statSync(abs)
  } catch {
    throw createError({ statusCode: 404, statusMessage: '文件不存在' })
  }
  if (!stat.isFile()) {
    throw createError({ statusCode: 404, statusMessage: '不是一个文件' })
  }

  setHeader(event, 'content-type', MIME[ext] ?? 'application/octet-stream')
  // 来源文件不会变,可以放心长缓存;预览器重复打开时不必再走一次磁盘。
  setHeader(event, 'cache-control', 'private, max-age=3600')
  // 文件名里常有中文与书名号,统一按 UTF-8 编码。
  setHeader(
    event,
    'content-disposition',
    `inline; filename*=UTF-8''${encodeURIComponent(abs.split(sep).pop() ?? 'file')}`,
  )
  // 预览器(尤其 PDF)可能发起 range 请求。
  setHeader(event, 'accept-ranges', 'bytes')

  const range = getRequestHeader(event, 'range')
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (match) {
      const start = match[1] ? Number(match[1]) : 0
      const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1
      if (start <= end && start < stat.size) {
        setResponseStatus(event, 206)
        setHeader(event, 'content-range', `bytes ${start}-${end}/${stat.size}`)
        // h3 把 content-length 标成数字,不传字符串。
        setHeader(event, 'content-length', end - start + 1)
        return sendStream(event, createReadStream(abs, { start, end }))
      }
    }
  }

  setHeader(event, 'content-length', stat.size)
  return sendStream(event, createReadStream(abs))
})
