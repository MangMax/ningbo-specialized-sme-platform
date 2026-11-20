import { createHash } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, fstatSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { compareFileContentIdentity, type StoredFileContentIdentity } from './file-content-identity'
import { FileMaintenanceError, resolveInsideRoot } from './file-store'

type Intent = StoredFileContentIdentity & { id: string }
const fail = (message: string): never => { throw new FileMaintenanceError(409, message) }

function paths(root: string, intent: Intent, createQuarantine = true) {
  if (!/^[0-9a-f-]{36}$/.test(intent.id)) fail('隔离意图 ID 非法')
  const base = realpathSync(root)
  const original = resolveInsideRoot(base, intent.relPath)
  if (!original) return fail('文件路径越界')
  if (original === base || intent.relPath.split(/[\\/]/).some(p => p.startsWith('.'))) fail('文件路径越界或属于保留目录')
  if (!realpathSync(dirname(original)).startsWith(base + sep) && realpathSync(dirname(original)) !== base) fail('文件父目录越界')
  const quarantineDir = join(base, '.physical-quarantine')
  if (createQuarantine) mkdirSync(quarantineDir, { recursive: true, mode: 0o700 })
  const quarantineEntry = lstatSync(quarantineDir, { throwIfNoEntry: false })
  if (quarantineEntry && (!quarantineEntry.isDirectory() || realpathSync(quarantineDir) !== resolve(quarantineDir))) fail('隔离目录必须是库内真实目录')
  return { original: original!, quarantine: join(quarantineDir, intent.id), base }
}
function verify(path: string, intent: Intent) {
  if (!existsSync(path)) fail('原字节不可用；不能恢复或隔离')
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) fail('恢复或隔离对象必须是原始普通文件')
  const fd = openSync(path, 'r')
  try {
    const before = fstatSync(fd), hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024)
    let count: number
    while ((count = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count))
    const after = fstatSync(fd)
    if (compareFileContentIdentity({ fileId: intent.fileId, relPath: intent.relPath, sha256: intent.sha256, bytes: intent.bytes }, { sha256: hash.digest('hex'), bytes: after.size }) || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('登记 SHA 或字节数不匹配；保留现状等待人工处理')
    fsyncSync(fd)
  } finally { closeSync(fd) }
}
function syncDirs(...paths: string[]) {
  for (const path of new Set(paths.map(dirname))) {
    const fd = openSync(path, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }
}
export function verifyPhysicalOriginal(root: string, intent: Intent) {
  verify(paths(root, intent, false).original, intent)
}

export function movePhysicalFile(root: string, intent: Intent, action: 'quarantine' | 'recover') {
  const p = paths(root, intent)
  if (action === 'quarantine') {
    if (lstatSync(p.quarantine, { throwIfNoEntry: false })) {
      if (lstatSync(p.original, { throwIfNoEntry: false })) fail('原路径和隔离副本同时存在，保留两者等待处理')
      verify(p.quarantine, intent)
    } else {
      verify(p.original, intent)
      renameSync(p.original, p.quarantine)
    }
  } else {
      if (lstatSync(p.quarantine, { throwIfNoEntry: false })) {
        if (lstatSync(p.original, { throwIfNoEntry: false })) fail('原路径已存在，禁止覆盖')
        verify(p.quarantine, intent)
        renameSync(p.quarantine, p.original)
      } else verify(p.original, intent)
  }
  syncDirs(p.original, p.quarantine, join(p.base, 'directory-entry'))
}
