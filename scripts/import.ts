/**
 * 导入 CLI:解析经信局公布文件与工信部导出,写入 SQLite。
 * 用法:`pnpm tsx scripts/import.ts [--root <数据目录>] [--label 20261013] [--title specialized_sme]`
 *
 * `--root` 可给**绝对路径**(跨 worktree / 任意位置);未给时回退 `SOURCE_ROOT`
 * 环境变量,再回退 `../`(仓库根之上一年一份数据目录的约定)。
 */
import { resolve, join, relative } from 'node:path'
import { useDb, dbPath } from '../db'
import { readAnnouncementBlocks } from '../lib/docx'
import { parseAnnouncement } from '../lib/announcement'
import { parseMiitFile, MIIT_FILES } from '../lib/miit'
import { importEntries, newImportContext, openImportBatch } from '../lib/import'
import { JXJ_SOURCES, discoverAnnouncements } from '../lib/sources'

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

// resolve() 同时兼容相对路径与绝对路径;绝对路径不受 cwd 影响。
const root = resolve(arg('root') ?? process.env.SOURCE_ROOT ?? '../')
const label = arg('label', new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()))!
const onlyTitle = arg('title')

const db = useDb()
console.log('db:', dbPath)
console.log('root:', root)

// 同 label 复用同一快照 → 重跑幂等(见 lib/import.ts openImportBatch)。
const batchId = openImportBatch(db, label, root, 'jxj announcements + miit exports')
const ctx = newImportContext(batchId)

let grand = 0
for (const src of JXJ_SOURCES) {
  if (onlyTitle && src.titleCode !== onlyTitle) continue
  const files = await discoverAnnouncements(root, src.subdir)
  let n = 0
  for (const file of files) {
    const blocks = await readAnnouncementBlocks(file)
    const entries = parseAnnouncement(blocks, { title: src.titleCode, sourceFile: relative(root, file) })
    const stats = importEntries(db, ctx, src.titleCode, entries)
    n += stats.entries
  }
  grand += n
  console.log(`  ${src.titleCode.padEnd(16)} ${String(n).padStart(6)} 条  (经信局)`)
}

for (const src of MIIT_FILES) {
  const entries = await parseMiitFile(join(root, src.file), src)
  const stats = importEntries(db, ctx, src.titleCode, entries)
  grand += stats.entries
  console.log(`  ${src.titleCode.padEnd(16)} ${String(stats.entries).padStart(6)} 条  (工信部)`)
}
console.log(`完成:导入 ${grand} 条记录`)
