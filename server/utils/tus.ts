import { link, mkdir, rm } from 'node:fs/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import { basename, extname, join, resolve } from 'node:path'
import { EVENTS, Server } from '@tus/server'
import { FileStore } from '@tus/file-store'

/**
 * tus 断点续传上传端点(文件库的**写路径**)。
 *
 * 边界与规则见:
 *  - `docs/adr/2026-10-14-tus-uploads-in-app.md`(上传落在 app 内)
 *  - `docs/adr/2026-10-13-source-files-in-repo.md`(文件库目录规则)
 *  - `lib/file-store-scope.ts` 与 `.research/tus-research.md`
 *
 * 这里只放两件事:**Server 单例**,以及从客户端声明的 metadata 到落位路径的**裁决规则**。
 * 落位规则(`landingSegments`)是纯函数、不碰 Nitro 全局,便于单测;只有拼绝对路径的
 * `filesDir()`/`incomingDir()` 才读 `runtimeConfig`。
 */

/** tus 端点的挂载基路径。中间件按它拦截;tus 也据此从 URL 尾段取 id。 */
export const TUS_PATH = '/api/uploads'

/** 单次上传上限 2GiB —— 超过返回 413。 */
export const MAX_SIZE = 2 * 1024 ** 3

/** `source` 白名单:经信局 / 工信部。 */
const SOURCES = new Set(['jxj', 'miit'])
/** `kind` 白名单:公布文件 / 导出表。 */
const KINDS = new Set(['announcement', 'export'])

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

/** 客户端在 `Upload-Metadata` 里声明的键(全部为可选,由规则决定必需项)。 */
export type UploadMetadata = Record<string, string | null | undefined>

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
 * `year`/`batch` 缺省时**省略对应段**(与 `lib/file-store-scope.ts` 规则一致,如导出表无批次)。
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

/**
 * 文件库根(`app/files/`):tus 上传的落位目标。走 `runtimeConfig.filesDir`
 * (可用 `NUXT_FILES_DIR` 覆盖),不写死路径。
 */
function filesDir(): string {
  return resolve(useRuntimeConfig().filesDir)
}

/**
 * tus 工作目录(`app/.incoming/`):分片先落这里,完成后 `link` + `unlink` 进文件库。
 * 必须与 `filesDir()` **同卷**(硬链接/rename 的前提)。走 `runtimeConfig.incomingDir`。
 */
function incomingDir(): string {
  return resolve(useRuntimeConfig().incomingDir)
}

/**
 * 跨源白名单:tus 协议默认 `Access-Control-Allow-Origin: *`,这里收窄。
 * 同源请求不受影响;默认只放行本机开发来源,可用 `NUXT_TUS_ALLOWED_ORIGINS`
 * (逗号分隔)覆盖(见 nuxt.config.ts)。
 */
function allowedOrigins(): string[] {
  const raw = useRuntimeConfig().tusAllowedOrigins
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** `Server` 的依赖路径与白名单,全部**显式注入**(便于测试脱离 Nitro 装配)。 */
export interface TusConfig {
  /** 文件库根(`app/files/`)。 */
  filesDir: string
  /** tus 工作目录(`app/.incoming/`),必须与 `filesDir` 同卷。 */
  incomingDir: string
  /** 跨源白名单。 */
  allowedOrigins: string[]
}

/**
 * Request-local observation populated only by the real @tus/server callbacks.
 * It is not server state: each `handleWeb` call gets its own store, so
 * concurrent uploads cannot observe each other's uploadId/offset.
 */
export interface TusObservation {
  uploadId?: string
  method?: string
  size?: number
  offset?: number
  created?: boolean
  completed?: boolean
  failed?: boolean
}
const tusObservation = new AsyncLocalStorage<TusObservation>()
/** Default @tus/utils Uid.rand(): 16 random bytes as lowercase hex. */
const generatedUploadId = /^[a-f0-9]{32}$/
const tusMethods = new Set(['POST', 'PATCH', 'HEAD', 'DELETE', 'OPTIONS'])
const safeCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

function currentObservation(): TusObservation | undefined {
  try { return tusObservation.getStore() } catch { return undefined }
}
function observe(read: (observation: TusObservation) => void): void {
  const observation = currentObservation()
  if (!observation) return
  try { read(observation) } catch { /* Diagnostics cannot change the upload. */ }
}
function noteRequest(method: unknown, uploadId: unknown): void {
  observe(observation => {
    if (typeof method === 'string' && tusMethods.has(method.toUpperCase())) observation.method = method.toUpperCase()
    if (typeof uploadId === 'string' && generatedUploadId.test(uploadId)) observation.uploadId = uploadId
  })
}
function noteUpload(upload: { id?: unknown; size?: unknown; offset?: unknown }, state: 'created' | 'completed'): void {
  observe(observation => {
    if (typeof upload.id === 'string' && generatedUploadId.test(upload.id)) observation.uploadId = upload.id
    const size = safeCount(upload.size), offset = safeCount(upload.offset)
    if (size !== undefined) observation.size = size
    if (offset !== undefined) observation.offset = offset
    observation[state] = true
  })
}
function noteProgress(upload: { id?: unknown; size?: unknown; offset?: unknown }): void {
  observe(observation => {
    if (typeof upload.id === 'string' && generatedUploadId.test(upload.id)) observation.uploadId = upload.id
    const size = safeCount(upload.size), offset = safeCount(upload.offset)
    if (size !== undefined) observation.size = size
    if (offset !== undefined) observation.offset = offset
  })
}

/**
 * Bind one tus `handleWeb` call to a fresh observation. The store is scoped to
 * this request's async chain; it never lives on the singleton `Server`.
 */
export async function withTusObservation<T>(
  run: () => Promise<T>,
  observation: TusObservation = {},
): Promise<{ result: T; observation: TusObservation }> {
  const result = await tusObservation.run(observation, run)
  return { result, observation }
}

/**
 * 组装一个 tus `Server`(纯函数式入口,不读 Nitro 全局)。
 * `getTus()` 用运行时配置调它;测试用临时目录调它。
 */
export function createTus(config: TusConfig): Server {
  const files = resolve(config.filesDir)
  const incoming = resolve(config.incomingDir)
  const server = new Server({
    path: TUS_PATH,
    datastore: new FileStore({ directory: incoming }),
    maxSize: MAX_SIZE,
    allowedOrigins: config.allowedOrigins,
    // 把落位路径回报给客户端(`onUploadFinish` 里设;见下)。跨源时也要能读到,
    // 端点自带的 `EXPOSED_HEADERS` 不包含自定义头。
    exposedHeaders: ['X-Upload-Path'],
    // 代理后 Location 仍正确(见 .research/tus-research.md §5.4)。
    respectForwardedHeaders: true,
    // Request-local ids/methods come from the library, never from the raw URL.
    onIncomingRequest: (req, uploadId) => {
      noteRequest(req.method, uploadId)
      return Promise.resolve()
    },
    // 创建时校验客户端声明的 metadata;非法 → 400。返回空对象表示不改写 metadata。
    onUploadCreate: (_req, upload) => {
      landingSegments((upload.metadata ?? {}) as UploadMetadata)
      // Only after the business validation passed; a rejected create is not a created upload.
      noteUpload(upload, 'created')
      return Promise.resolve({})
    },
    // 传完后按规则落位。此处重算一次段序列(与创建时同源、确定性),保证只落合法路径。
    onUploadFinish: async (_req, upload) => {
      const segments = landingSegments((upload.metadata ?? {}) as UploadMetadata)
      const filename = segments[segments.length - 1]!
      const dir = join(files, ...segments.slice(0, -1))
      await mkdir(dir, { recursive: true })
      // PATCH 的 getUpload 会带 storage.path(工作目录里的临时文件);兜底用 id 拼。
      const src = upload.storage?.path ?? join(incoming, upload.id)
      const landed = await linkUnique(src, dir, filename)
      // 落位后清掉工作目录里的 sidecar 元数据,别让 `.incoming/` 攒垃圾。
      await rm(join(incoming, `${upload.id}.json`), { force: true })
      // The original mkdir/link/rm work has succeeded; only now is the upload
      // a completed placement. A client disconnect later cannot roll it back.
      noteUpload(upload, 'completed')
      // 回报**实际**落位路径(同名防覆盖会加 ` (n)` 后缀,客户端算不出来)。
      // 口径与 `record_evidence.source_file` 一致:相对文件库根,正斜杠分隔。
      // HTTP 头是 ByteString(≤255),中文文件名不能直接放进去 —— 百分号编码后
      // 客户端 decodeURIComponent 还原,路径里的空格、括号一并不用手拼。
      const relativePath = segments.slice(0, -1).concat(basename(landed)).join('/')
      return { headers: { 'X-Upload-Path': encodeURIComponent(relativePath) } }
    },
    // A response error is an observation, never a claim that bytes/placement rolled back.
    onResponseError: (_req, _error) => {
      observe(observation => { observation.failed = true })
      return undefined
    },
  })
  // Progress is observed in memory only; it never emits an event per chunk.
  server.on(EVENTS.POST_RECEIVE, (_req, upload) => noteProgress(upload))
  return server
}

/** 模块级单例:tus 的 datastore/locker 每请求重建代价高,建一次复用。 */
let server: Server | undefined

/**
 * 取得 tus `Server` 单例(Nitro 从 `server/utils/**` 自动导入,中间件直接用)。
 * 首次调用发生在请求期内,此时 `useRuntimeConfig()` 可用。
 */
export function getTus(): Server {
  if (server) return server
  server = createTus({
    filesDir: filesDir(),
    incomingDir: incomingDir(),
    allowedOrigins: allowedOrigins(),
  })
  return server
}

/**
 * 把已完成的上传从工作目录**移入**文件库,**绝不覆盖**:
 * 优先用 `link`(目标已存在会 EEXIST,原子、O(1)、需同卷),成功后再 `unlink` 源。
 * 撞名依次尝试 `<name> (1)`、`<name> (2)`……
 */
async function linkUnique(src: string, dir: string, filename: string): Promise<string> {
  const ext = extname(filename)
  const stem = ext ? filename.slice(0, filename.length - ext.length) : filename
  for (let n = 0; ; n += 1) {
    const target = join(dir, n === 0 ? filename : `${stem} (${n})${ext}`)
    try {
      await link(src, target)
      await rm(src, { force: true })
      return target
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
  }
}
