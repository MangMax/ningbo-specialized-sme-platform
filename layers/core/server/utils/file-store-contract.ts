import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { extensionOf } from '../../lib/core/file-path'
import type { evaluateFileAdmission, FileFilter } from '../../lib/core/file-categories'
import type { FileContentConflict } from './file-identity'
import { appLog, type LogContext } from '../../lib/logging'

export interface FileQuery {
  q?: string
  includeRemoved?: boolean
  page?: number
  pageSize?: number
}

export type FileQueryFilters = Readonly<Record<string, readonly string[] | undefined>>

export function selectedFileFilters(filters: readonly FileFilter[], params: Record<string, unknown>): FileQueryFilters {
  return Object.fromEntries(filters.flatMap(filter => {
    const raw = params[filter.key]
    const values = (Array.isArray(raw) ? raw : [raw])
      .flatMap(value => typeof value === 'string' ? value.split(',').map(part => part.trim()) : [])
      .filter(value => filter.options.some(option => option.value === value))
    return values.length ? [[filter.key, values]] : []
  }))
}

export interface FileRegistrationResult {
  row: FileRow
  created: boolean
}

export interface RegistrationFile {
  relPath: string
  filename: string
  abs: string
  bytes: number
}

export class UploadRegistrationError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly conflict?: FileContentConflict,
    readonly reason?: string,
  ) {
    super(message)
    this.name = 'UploadRegistrationError'
  }
}

export interface FileRow extends ScannedFile {
  id: number
  displayName: string
  createdAt: string
  removedAt: string | null
  referenceCount?: number
  contentIdentity?: { registered: { fileId: number; relPath: string; sha256: string; bytes: number }; status: 'unknown'; historical: 'unknown' }
}

export const MAX_PAGE_SIZE = 200

/** 扫描到的磁盘事实。 */
export interface ScannedFile {
  relPath: string
  filename: string
  ext: string
  bytes: number
  sha256: string
}

/** 计算文件的 SHA-256(流式,避免把大文件整个读进内存)。 */
export function sha256Of(absPath: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(absPath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

export async function fileRegistrationFacts({ relPath, filename, abs, bytes }: RegistrationFile): Promise<ScannedFile> {
  return { relPath, filename, ext: extensionOf(filename), bytes, sha256: await sha256Of(abs) }
}

/**
 * 把一个库内相对路径**锁在文件库根内**,返回绝对路径;越界返回 `null`。
 *
 * 用 `resolve` 之后再比对前缀,而不是字符串过滤 `..` —— 符号链接与编码变体都绕不过
 * resolve。加 `sep` 是为了避免 `/root-evil` 被 `/root` 前缀匹配上。
 *
 * 三个地方需要同一条判据(回填/删除、预览路由、上传登记),各写一份的话
 * 修一处漏两处 —— 故收在这一处。
 */
export function resolveInsideRoot(root: string, relPath: string): string | null {
  const base = resolve(root)
  const abs = resolve(join(base, relPath))
  if (abs !== base && !abs.startsWith(base + sep)) return null
  return abs
}

export function splitRegistrationPath(relPath: string): string[] {
  const segments = relPath.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0'))) {
    throw new UploadRegistrationError(`落位路径非法:${relPath}`)
  }
  return segments
}

export async function registerLandedFile(
  root: string,
  relPath: string,
  prepare: () => Promise<(file: RegistrationFile) => Promise<FileRegistrationResult>>,
  checkAdmission: (path: string, siblings: ReadonlySet<string>) => ReturnType<typeof evaluateFileAdmission>,
  context: LogContext,
): Promise<FileRegistrationResult> {
  const startedAt = Date.now()
  try {
    const write = await prepare()
    const filename = splitRegistrationPath(relPath).at(-1)!
    const abs = resolveInsideRoot(root, relPath)
    if (!abs) throw new UploadRegistrationError(`落位路径越界:${relPath}`)
    let info
    try {
      info = await stat(abs)
    } catch {
      throw new UploadRegistrationError(`落位文件不存在:${relPath}`)
    }
    if (!info.isFile()) throw new UploadRegistrationError(`落位路径不是一个文件:${relPath}`)
    const siblings = await readdir(dirname(abs), { withFileTypes: true })
    const exclusion = checkAdmission(relPath, new Set(siblings.filter(entry => entry.isFile()).map(entry => entry.name)))
    if (exclusion) throw new UploadRegistrationError(exclusion.detail, 400, undefined, exclusion.reason)

    const result = await write({ relPath, filename, abs, bytes: info.size })
    appLog({ module: 'core', source: 'file', operation: result.created ? 'file.register' : 'file.register.refresh', outcome: 'success', fileId: result.row.id, durationMs: Date.now() - startedAt }, context)
    return result
  } catch (error) {
    appLog({ module: 'core', source: 'file', operation: 'file.register', outcome: error instanceof UploadRegistrationError ? 'denied' : 'failure', level: 'error', errorCode: error instanceof UploadRegistrationError ? 'file_registration_rejected' : 'file_registration_failed', durationMs: Date.now() - startedAt }, context)
    throw error
  }
}

/** 解析用户可见文件名。这个字段不会被用于路径或磁盘操作。 */
export function parseDisplayNamePatch(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('请求体必须是对象')
  }
  const patch = body as Record<string, unknown>
  const keys = Object.keys(patch)
  if (keys.length !== 1 || keys[0] !== 'displayName') {
    throw new Error('改显示名称时只能提供 displayName')
  }
  if (typeof patch.displayName !== 'string') throw new Error('显示名称必须是字符串')
  const displayName = patch.displayName.trim()
  if (!displayName) throw new Error('显示名称不能为空')
  if (Array.from(displayName).length > 255) throw new Error('显示名称不能超过 255 个字符')
  if (/[\u0000-\u001f\u007f-\u009f]/.test(displayName)) throw new Error('显示名称不能包含控制字符')
  return displayName
}

export class FileMaintenanceError extends Error {
  constructor(public statusCode: number, message: string) { super(message) }
}

export async function verifyFileRestorationBytes(root: string, current: Pick<FileRow, 'relPath' | 'bytes' | 'sha256'>) {
  const abs = resolveInsideRoot(root, current.relPath)
  if (!abs) throw new FileMaintenanceError(409, '文件路径越界')
  try {
    const physicalRoot = await realpath(root)
    const physical = await realpath(abs)
    if (!physical.startsWith(physicalRoot + sep) || !(await lstat(abs)).isFile()) {
      throw new FileMaintenanceError(409, '恢复必须指向库内原始普通文件')
    }
    const before = await stat(abs)
    const hash = await sha256Of(abs)
    const after = await stat(abs)
    if (before.size !== current.bytes || hash !== current.sha256 || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new FileMaintenanceError(409, '文件字节数或哈希不匹配,不能恢复')
    }
  } catch (error) {
    if (error instanceof FileMaintenanceError) throw error
    throw new FileMaintenanceError(409, '恢复文件不存在或不可读取')
  }
}
