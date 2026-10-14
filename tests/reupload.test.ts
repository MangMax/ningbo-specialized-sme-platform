import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Upload } from 'tus-js-client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTus, TUS_PATH, type TusConfig } from '../server/utils/tus'
import { startTusServer, type MiniTusServer } from './helpers/tus-mini-server'

/**
 * 「脚本内化」与「tus 上传」两条写入路径的**落位规则一致性**验证(票 02)。
 *
 * 遍历仓库文件库(`files/**`)里现有的内化文件(当前 24 个:22 个来源文件,
 * 加上 2 个由 `.doc` 转出的 `.docx` —— 见 files/README.md),按**路径反推** metadata
 * (`source/kind/year/batch/filename`),再经 **tus 协议**(`tus-js-client` 走真实
 * HTTP)上传到**临时文件库**(不碰真实 `files/`),断言:
 *   1. 每个文件落到规则路径 `files/<source>/<kind>/<year>/<batch>/<filename>`,
 *      且与源文件**逐字节一致**(SHA-256);
 *   2. 同名再传不覆盖,新文件落 ` (n)`。
 *
 * 落位端的 `createTus()` / `landingSegments()` 就是生产用的那套;上传端是真实
 * `tus-js-client`,只经由一个把 `Request`/`Response` 桥到 Node socket 的迷你服务器
 * (见 `tests/helpers/tus-mini-server.ts`),与 `server/middleware/tus.ts` 同入口。
 */

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
/** 仓库里现有的文件库(22 个来源文件 + 2 个 `.doc` 转出的 `.docx` + README)。 */
const LIBRARY_DIR = join(APP_ROOT, 'files')

/** 文件库根下与落位规则无关的说明文件。 */
const NON_DATA_FILES = new Set(['README.md'])
/** 经信局冲突消歧用的来源子目录段(见 files/README.md)。 */
const VARIANT_SEGMENTS = new Set(['省专', '创新型'])

/** 一个待重传的文件:源绝对路径 + 由路径反推的 tus metadata。 */
interface LibraryFile {
  /** 相对文件库根的路径(`/` 分隔),作稳定标识。 */
  rel: string
  absPath: string
  /** 落位规则的**段序列** `[source, kind, year?, batch?, filename]`。 */
  segments: string[]
  /** 上传声明用的 metadata(平铺的 source/kind/year/batch/filename)。 */
  metadata: Record<string, string>
  bytes: number
  sha256: string
}

/** 递归列出文件库里的数据文件(排除 README 等非数据文件)。 */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(abs)))
    else if (entry.isFile() && !NON_DATA_FILES.has(entry.name)) out.push(abs)
  }
  return out
}

/**
 * 从**路径反推** metadata —— 这正是内化脚本(`pipeline/src/files.ts` 的
 * `resolveJxjParts` 等)在做的事:段序即 `source/kind[/year[/batch]][/variant]/filename`。
 */
function deriveMetadata(parts: string[]): Record<string, string> {
  const [source, kind, ...rest] = parts
  const filename = rest.pop() as string
  // rest 现在只剩可选的 year / batch / variant。
  const head = rest[0]
  const year = head !== undefined && /^\d{4}$/.test(head) ? head : undefined
  if (year) rest.shift()
  const second = rest[0]
  const batch = second !== undefined && /^\d+$/.test(second) ? second : undefined
  if (batch) rest.shift()
  // 其余段是消歧用的来源子目录;忽略(本验证不含此类文件)。
  const metadata: Record<string, string> = { source: source!, kind: kind!, filename }
  if (year) metadata.year = year
  if (batch) metadata.batch = batch
  return metadata
}

/** 扫描文件库,读出每个文件的字节数与 SHA-256。 */
async function scanLibrary(): Promise<LibraryFile[]> {
  const files: LibraryFile[] = []
  for (const absPath of (await walk(LIBRARY_DIR)).sort()) {
    const rel = relative(LIBRARY_DIR, absPath).split(sep).join('/')
    const parts = rel.split('/')
    const content = await readFile(absPath)
    files.push({
      rel,
      absPath,
      segments: parts,
      metadata: deriveMetadata(parts),
      bytes: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
    })
  }
  return files
}

/** 用 `tus-js-client` 走真实协议把一个 buffer 上传到端点;resolve 出创建的 upload URL。 */
function tusUpload(
  endpoint: string,
  metadata: Record<string, string>,
  data: Buffer,
  overrides: { chunkSize?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const upload = new Upload(data, {
      endpoint,
      metadata,
      uploadSize: data.byteLength,
      // 强制分片,覆盖「多次 PATCH」路径(默认整文件一个 PATCH)。
      chunkSize: overrides.chunkSize ?? 512 * 1024,
      // 测试间复用同一 endpoint,禁用本地 URL 存储,避免 findPreviousUploads 串场。
      storeFingerprintForResuming: false,
      onError: reject,
      onSuccess: () => {
        if (!upload.url) reject(new Error('tus 未返回 upload URL'))
        else resolve(upload.url)
      },
    })
    upload.start()
  })
}

describe('票 02:现有 24 个文件按 tus 规则重传,落位一致', () => {
  let work: string
  let server: MiniTusServer
  let reUploadDir: string
  let endpoint: string
  let library: LibraryFile[]
  /** 上传结果(用于最后的清单打印)。 */
  const report: { rel: string; bytes: number; landed?: string; ok: boolean }[] = []

  beforeAll(async () => {
    // 临时工作区:落位库 + tus 工作目录同卷(硬链接前提)。
    work = await mkdtemp(join(tmpdir(), 'tus-reupload-'))
    const config: TusConfig = {
      filesDir: join(work, 'files'),
      incomingDir: join(work, '.incoming'),
      allowedOrigins: [],
    }
    reUploadDir = config.filesDir
    await mkdir(reUploadDir, { recursive: true })
    server = await startTusServer(createTus(config))
    endpoint = `${server.origin}${TUS_PATH}`
    library = await scanLibrary()
  })

  afterAll(async () => {
    await server?.close()
    // 临时目录在 os.tmpdir() 下,删掉即可;真实 files/ 未被触碰。
    await rm(work, { recursive: true, force: true })
  })

  it('扫描到的文件数与内化的 24 个一致', () => {
    expect(library).toHaveLength(24)
    // README 被排除;规则里 source/kind 都在白名单内。
    expect(library.every((f) => ['jxj', 'miit'].includes(f.metadata.source!))).toBe(true)
  })

  it('每个文件经 tus 上传后落到规则路径,且与源文件逐字节一致', async () => {
    for (const file of library) {
      await tusUpload(endpoint, file.metadata, await readFile(file.absPath))

      const target = join(reUploadDir, ...file.segments)
      expect(existsSync(target), `${file.rel} 未落到规则路径`).toBe(true)
      const landed = await readFile(target)
      const landedHash = createHash('sha256').update(landed).digest('hex')
      expect(landedHash, `${file.rel} 内容不一致`).toBe(file.sha256)
      expect(landed.byteLength).toBe(file.bytes)
      report.push({ rel: file.rel, bytes: file.bytes, landed: file.rel, ok: true })
    }

    // 落位库里的文件**恰好**是这 24 个(不多不少、无多余空目录产物)。
    const landedRels = (await walk(reUploadDir)).map((p) =>
      relative(reUploadDir, p).split(sep).join('/'),
    )
    expect(landedRels.sort()).toEqual(library.map((f) => f.rel).sort())
  })

  it('同名再传不覆盖:落到 ` (n)`,原文件不动', async () => {
    const sample = library.find((f) => f.metadata.year)!
    const original = await readFile(join(reUploadDir, ...sample.segments))
    const originalHash = createHash('sha256').update(original).digest('hex')

    // 造一份**同名不同内容**的字节再传一次。
    const altBytes = Buffer.from(`tus 重传冲突样本 ${sample.rel}\n`, 'utf8')
    await tusUpload(endpoint, sample.metadata, altBytes)

    const segments = sample.segments
    const filename = segments[segments.length - 1]!
    const dir = join(reUploadDir, ...segments.slice(0, -1))
    const dot = filename.lastIndexOf('.')
    const stem = dot > 0 ? filename.slice(0, dot) : filename
    const ext = dot > 0 ? filename.slice(dot) : ''

    // 原文件原样不动。
    expect(createHash('sha256').update(await readFile(join(dir, filename))).digest('hex')).toBe(
      originalHash,
    )
    // 新内容落到 ` (1)`。
    const suffixed = join(dir, `${stem} (1)${ext}`)
    expect(existsSync(suffixed)).toBe(true)
    expect(await readFile(suffixed)).toEqual(altBytes)
  })

  it('打印 24 个文件的上传结果清单', () => {
    expect(report).toHaveLength(24)
    const lines = report.map((r) => `${r.rel}  (${r.bytes} bytes)  → ${r.landed}  [ok]`)
    console.log(`\n[tus 重传] ${report.length} 个文件:\n${lines.join('\n')}\n`)
    expect(report.every((r) => r.ok)).toBe(true)
  })
})
