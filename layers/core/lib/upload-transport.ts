import { formatBytes } from './core/file-size'

/**
 * tus 端点。与 `server/utils/tus.ts` 的 `TUS_PATH` 是同一个值 ——
 * 服务端常量进不了客户端包,这里补一份;两处必须同时改。
 */
export const TUS_ENDPOINT = '/api/uploads'

/** 单次上传上限,与 `server/utils/tus.ts` 的 `MAX_SIZE` 一致(2GiB)。 */
export const MAX_SIZE = 2 * 1024 ** 3

/** 文件名(含路径分隔符时只取最后一段)安全化为可上传的裸文件名。 */
export function baseName(name: string): string {
  const at = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  return at >= 0 ? name.slice(at + 1) : name
}

/** `tus-js-client` 存下的历史条目里,我们真正需要的形状。 */
export interface PreviousUpload {
  size: number | null
  metadata: Record<string, string>
  creationTime: string
  urlStorageKey: string
  uploadUrl: string | null
  parallelUploadUrls: string[] | null
}

/**
 * 这条历史上传指向的地址,是不是**当前这个端点**。
 *
 * 只比路径不够:换过服务的绝对地址(另一个 host)路径可以一模一样。有 origin 时
 * 连 origin 一起比;拿不到 origin(非浏览器环境)就退化成路径前缀判断。
 */
export function targetsEndpoint(uploadUrl: string, endpoint: string, origin?: string): boolean {
  try {
    const resolved = new URL(uploadUrl, origin)
    if (origin && resolved.origin !== new URL(origin).origin) return false
    return resolved.pathname === endpoint || resolved.pathname.startsWith(`${endpoint}/`)
  } catch {
    // 相对地址或 origin 不合法时,退化成字符串前缀。
    return uploadUrl.startsWith(`${endpoint}/`)
  }
}

/** 上传的五个状态。`paused` 与 `error` 都可再点「继续」重来。 */
export type UploadPhase = 'queued' | 'uploading' | 'paused' | 'done' | 'error'

/** 失败的类型:决定用哪种措辞,以及值不值得重试。 */
export type UploadErrorKind = 'invalid' | 'too-large' | 'network' | 'server' | 'unknown'

export interface UploadFailure {
  kind: UploadErrorKind
  /** 一句话说清发生了什么。 */
  message: string
  /** 如果是服务端说 metadata 不对,这里带上它到底哪里不对。 */
  detail?: string
}

/** `@tus/server` 的钩子用 `status_code` + `body` 表达错误(见 server/utils/tus.ts)。 */
interface TusLikeError {
  message?: string
  originalResponse?: { getStatus: () => number; getBody: () => string } | null
}

/** 从响应体里读出一句话。服务端的 400 body 就是「filename 非法: …」这种。 */
function firstLine(body: string | undefined | null): string | undefined {
  const line = (body ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  return line || undefined
}

/**
 * 把 tus-js-client 抛出的东西翻译成**看得懂、且说得出下一步**的一段话。
 *
 * 原生 message 是英文的,而且创建失败时只有一句
 * `tus: unexpected response while creating upload` —— 看不出是元数据错了还是服务挂了,
 * 所以先看 HTTP 状态码,再决定措辞。
 */
export function toUploadFailure(error: unknown): UploadFailure {
  const err = (error ?? {}) as TusLikeError
  const response = err.originalResponse ?? null
  const status = response ? Number(response.getStatus()) : 0
  const body = response ? firstLine(response.getBody()) : undefined
  const raw = typeof err.message === 'string' ? err.message : ''

  switch (status) {
    case 400:
      return {
        kind: 'invalid',
        message: '落位信息不合规,服务端拒绝了这次上传。',
        detail: body ?? '核对来源与类别;年份要四位数字,批次要与年份同时提供。',
      }
    case 404:
      return {
        kind: 'server',
        message: '上传任务在服务端已不存在(多半是被当作过期清理了)。',
        detail: '从队列里删掉这一条,重新选一次文件。',
      }
    case 412:
      return {
        kind: 'server',
        message: '上传端点未就绪(缺少 Tus-Resumable 头)。',
        detail: '多半是服务端中间件没挂上,请联系维护者。',
      }
    case 413:
      return {
        kind: 'too-large',
        message: `文件超过单次上传上限 ${formatBytes(MAX_SIZE)}。`,
        detail: '请先拆分,或改走 pipeline 内化。',
      }
  }
  if (status >= 500) {
    return {
      kind: 'server',
      message: `服务端出错(${status}),这次上传没有完成。`,
      detail: '稍后点「重试」,进度不会丢。',
    }
  }
  if (!response) {
    return {
      kind: 'network',
      message: '连接中断,字节没有送到服务端。',
      detail:
        raw.includes('Failed to fetch') || raw.includes('NetworkError')
          ? '检查网络和服务是否在运行;恢复后点「重试」。'
          : '恢复后点「重试」,会从断点接着传。',
    }
  }
  return {
    kind: 'unknown',
    message: raw ? `上传失败:${raw}` : '上传失败。',
    detail: status ? `HTTP ${status}` : undefined,
  }
}

/** 文件名是否是服务端会接受的那一类(无路径分隔符、无 `..`、非空)。 */
export function isFilenameSafe(name: string): boolean {
  const value = name.trim()
  return (
    value.length > 0 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('..') &&
    !value.includes('\0')
  )
}

/** 字节数按人读的单位显示(1.2 MB)。 */
/** 剩余秒数 → 「约 1 分 20 秒」这类估计。速度为 0 时返回 `undefined`。 */
export function formatEta(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  if (seconds < 60) return `约 ${Math.ceil(seconds)} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return rest ? `约 ${minutes} 分 ${rest} 秒` : `约 ${minutes} 分`
}
