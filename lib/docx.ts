import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'
import mammoth from 'mammoth'
import { parse } from 'node-html-parser'

const execFileAsync = promisify(execFile)

export type Block =
  | { type: 'p'; text: string }
  | { type: 'tbl'; rows: string[][] }

interface HtmlNode {
  tagName?: string
  text?: string
  childNodes?: HtmlNode[]
  querySelectorAll?: (sel: string) => HtmlNode[]
}

/** 把 mammoth 输出的 HTML 按文档顺序压平成「段落 / 表格」块。 */
function blocksFromHtml(html: string): Block[] {
  const root = parse(html) as unknown as HtmlNode
  const blocks: Block[] = []

  const walk = (node: HtmlNode) => {
    const tag = node.tagName?.toLowerCase()
    if (tag === 'p') {
      const text = (node.text ?? '').trim()
      if (text) blocks.push({ type: 'p', text })
      return
    }
    if (tag === 'table') {
      const rows = (node.querySelectorAll?.('tr') ?? []).map((tr) =>
        (tr.querySelectorAll?.('th,td') ?? []).map((c) => (c.text ?? '').replace(/\s+/g, ' ').trim()),
      )
      blocks.push({ type: 'tbl', rows })
      return
    }
    for (const child of node.childNodes ?? []) walk(child)
  }

  for (const child of root.childNodes ?? []) walk(child)
  return blocks
}

/** 把 .docx 字节流解析成按文档顺序排列的「段落 / 表格」块。 */
export async function readDocxBlocks(buf: Buffer | Uint8Array): Promise<Block[]> {
  const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(buf) })
  return blocksFromHtml(value)
}

let sofficeChecked = false
let sofficePath: string | null = null

async function findSoffice(): Promise<string | null> {
  if (sofficeChecked) return sofficePath
  sofficeChecked = true
  const candidates = [
    process.env.SOFFICE_PATH,
    '/opt/homebrew/bin/soffice',
    '/usr/local/bin/soffice',
    '/usr/bin/soffice',
    'soffice',
  ].filter(Boolean) as string[]
  for (const c of candidates) {
    try {
      await execFileAsync(c, ['--version'], { timeout: 20_000 })
      sofficePath = c
      return c
    } catch {
      /* try next */
    }
  }
  return null
}

/**
 * 读取一个公布文件为块序列。`.docx` 直读;`.doc` 依赖本机 LibreOffice(soffice)转换。
 * 找不到 soffice 时抛出带指引的错误。
 */
export async function readAnnouncementBlocks(path: string): Promise<Block[]> {
  const ext = extname(path).toLowerCase()
  if (ext === '.docx') {
    const { value } = await mammoth.convertToHtml({ path })
    return blocksFromHtml(value)
  }

  if (ext === '.doc') {
    const soffice = await findSoffice()
    if (!soffice) {
      throw new Error(
        `无法读取 ${basename(path)}:需要 LibreOffice(soffice)将 .doc 转为 .docx。` +
          `请安装后重试,或设置 SOFFICE_PATH。`,
      )
    }
    const dir = mkdtempSync(join(tmpdir(), 'spztx-doc-'))
    try {
      await execFileAsync(soffice, ['--headless', '--convert-to', 'docx', '--outdir', dir, path], {
        timeout: 120_000,
      })
      const converted = join(dir, basename(path).replace(/\.doc$/i, '.docx'))
      const { value } = await mammoth.convertToHtml({ path: converted })
      return blocksFromHtml(value)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  throw new Error(`不支持的文件类型:${ext}`)
}
