import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pageDirRelPath } from '../../lib/pdf-page'
import { resolveWithinRoot } from './pdf-pages'

/**
 * 通路 a 的**成功页中转**(票 14 的断点续跑半边)。
 *
 * ── 它解决的具体故障 ────────────────────────────────────────────────────
 * `runOcr` 原本把一份 PDF 的页结果**只放在内存**里,`persistPages` 只在**全页成功**
 * 时执行一次。于是「12 页里成功 7 页、5 页撞上 Paddle 的 HTTP 429」这种很常见的局面
 * 会变成:7 页白识别(钱已经花了)、一份结果都没落库,重跑**从第 1 页重来**、把那 7 页
 * 再发给服务端一次 —— 而 429 恰恰是**不允许自动重试**的(4xx 不重试,见 `ocr-api.ts`),
 * 所以「重跑」正是最容易再次触发限流的动作,12 页的文件可能永远跑不完。
 * 实证见本仓 `acceptance/20261015/fresh-flow/evidence/ocr-429/`。
 *
 * ── 边界:它是**缓存**,不是结果 ─────────────────────────────────────────
 * 这里只存**在线 API(通路 a)真的识别出来的**页。人工纠偏/上传(通路 b)与代理写回
 * (通路 c)的结果**不进这里** —— 它们是人的判断,不是「provider 对这个输入说了什么」,
 * 拿它们当缓存去顶替一次真实识别,等于把人的编辑悄悄固化成机器的输出。
 *
 * 命中判据是**这一页**的三要素,合在一颗 key 里(见 `ocrPageCacheKey`):
 *  - **页图的真实内容 sha256**(不是路径、不是 mtime —— 重渲染换了 DPI 就换内容);
 *  - **模型名**;
 *  - **影响识别结果的有效选项指纹**(`ocrRequestVariant`:模型 + 实际发出的 optionalPayload)。
 * 任何一项变了就是另一个 key ⇒ 旧条目**自然不再命中**,不需要谁去「清缓存」。
 *
 * ── 落盘位置与生命周期 ──────────────────────────────────────────────────
 * 放在源 PDF 自己的页图目录里:`files/<…>/.<文件名>.pages/.ocr-cache/<key>.json`。
 * 与页图同一条 ADR(页图是派生缓存、落文件库、带前导点所以不被扫描器当成文件)同一口径,
 * 也一并被 `.gitignore` 的 `files/**​/.*.pages/` 覆盖。删掉即可重跑,不建表、无迁移。
 *
 * ── 坏了怎么办 ──────────────────────────────────────────────────────────
 * 读不出来(缺失 / 半截 / JSON 坏了 / 形状不对 / 身份对不上)一律**当未命中**:
 * 宁可多识别一次,也不把一条可疑数据当成结果。写入是「先 `.tmp` 再 `rename`」的原子写,
 * 且**尽力而为** —— 它只是加速件,写不进去不能让一次**已经成功**的付费识别跟着失败。
 */

/** 缓存目录名。带前导点:与页图目录同一理由(扫描器跳过 `.` 开头)。 */
export const OCR_PAGE_CACHE_DIR = '.ocr-cache'

/** 条目版本。形状变了就递增,旧条目自动不再命中。 */
export const OCR_PAGE_CACHE_VERSION = 1

/** 一条缓存的页结果(磁盘上的形状)。 */
export interface CachedOcrPage {
  version: typeof OCR_PAGE_CACHE_VERSION
  /** 页图内容哈希(sha256,小写十六进制)。 */
  imageSha256: string
  /** 有效选项指纹(模型 + optionalPayload);与 `imageSha256` 一起构成命中判据。 */
  variant: string
  /** **产出这一页**的远端 job id。命中时如实回带,不伪造一个新 job。 */
  jobId: string
  /** 实际使用的模型(冗余存一份,排查时不必再算 key)。 */
  model: string
  markdown: string
  /** 该页原始响应(与 `ocr_result.raw` 同源)。 */
  raw: unknown
  createdAt: string
}

/** 一次命中(投影成 `runOcr` 要的形状)。 */
export interface OcrPageCacheHit {
  jobId: string
  model: string
  markdown: string
  raw: unknown
  createdAt: string | null
}

/** 一份 PDF 的中转缓存目录(绝对路径;解析后必须仍在文件库根内)。 */
export function ocrPageCacheDirAbs(filesDir: string, pdfRelPath: string): string {
  return resolveWithinRoot(filesDir, `${pageDirRelPath(pdfRelPath)}/${OCR_PAGE_CACHE_DIR}`)
}

/**
 * 流式算文件的 sha256(不把页图整个读进内存)。
 *
 * 与 `server/utils/pdf-pages.ts` 的同名函数**逐行相同** —— 照抄而不抽取,是因为抽取要改
 * 那份文件(票 13 的地盘)。同仓已有先例(`layers/sme-roster/lib/stored-file.ts` 也照抄了 pipeline 的
 * `parseBatch` 并注明来源),合流留给后续清理。
 */
export function sha256OfFile(absPath: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(absPath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

/**
 * 命中 key = H(页图内容哈希 ‖ 有效选项指纹)。
 *
 * 用 `\u0000` 分隔而不是拼接字符串,是为了让「哈希 + 指纹」的任何组合都**无法**被
 * 另一个组合冒充(分隔符不出现在十六进制与指纹里)。
 */
export function ocrPageCacheKey(imageSha256: string, variant: string): string {
  return createHash('sha256').update(`${imageSha256}\u0000${variant}`).digest('hex')
}

/**
 * 读一条缓存。**任何异常都返回 `null`(未命中)** —— 缺失、半截、坏 JSON、形状不对,
 * 或身份(哈希/指纹)与本次请求对不上,都不该被当成「这一页识别过了」。
 */
export async function readOcrPageCache(
  cacheDirAbs: string,
  key: string,
  expected: { imageSha256: string; variant: string },
): Promise<OcrPageCacheHit | null> {
  let parsed: Partial<CachedOcrPage>
  try {
    parsed = JSON.parse(await readFile(join(cacheDirAbs, `${key}.json`), 'utf8')) as Partial<CachedOcrPage>
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  if (
    parsed.version !== OCR_PAGE_CACHE_VERSION ||
    parsed.imageSha256 !== expected.imageSha256 ||
    parsed.variant !== expected.variant ||
    typeof parsed.jobId !== 'string' ||
    !parsed.jobId ||
    typeof parsed.markdown !== 'string'
  ) {
    return null
  }
  return {
    jobId: parsed.jobId,
    model: typeof parsed.model === 'string' ? parsed.model : '',
    markdown: parsed.markdown,
    raw: parsed.raw,
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : null,
  }
}

/**
 * 写一条缓存(原子替换)。**尽力而为**:失败只吞掉,不向上抛 —— 一次已经成功的付费识别
 * 不该因为缓存写不进去而被判失败。写失败的真实后果只是「下次重跑要多识别一次」,
 * 那是退化,不是错误。
 */
export async function writeOcrPageCache(
  cacheDirAbs: string,
  key: string,
  entry: CachedOcrPage,
): Promise<void> {
  try {
    await mkdir(cacheDirAbs, { recursive: true })
    const target = join(cacheDirAbs, `${key}.json`)
    const tmp = `${target}.tmp`
    await writeFile(tmp, `${JSON.stringify(entry)}\n`, 'utf8')
    await rename(tmp, target)
  } catch {
    // 见上:加速件,写不进去不改变本次识别的成败。
  }
}
