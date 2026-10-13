/**
 * 导入 CLI:解析经信局公布文件并写入 SQLite。
 * 用法:`pnpm tsx scripts/import.ts [--root ../] [--label 20261013] [--title specialized_sme]`
 */
import { resolve } from 'node:path'
import { useDb, schema, dbPath } from '../db'
import { readAnnouncementBlocks } from '../lib/docx'
import { parseAnnouncement } from '../lib/announcement'
import { importEntries, newImportContext } from '../lib/import'
import { JXJ_SOURCES, discoverAnnouncements, relPath } from '../lib/sources'

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const root = resolve(arg('root', '../')!)
const label = arg('label', new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()))!
const onlyTitle = arg('title')

const db = useDb()
console.log('db:', dbPath)

const batch = db
  .insert(schema.importBatch)
  .values({ label, sourceRoot: root, note: 'jxj announcements' })
  .returning({ id: schema.importBatch.id })
  .get()
const ctx = newImportContext(batch.id)

let grand = 0
for (const src of JXJ_SOURCES) {
  if (onlyTitle && src.titleCode !== onlyTitle) continue
  const files = await discoverAnnouncements(root, src.subdir)
  let n = 0
  for (const file of files) {
    const blocks = await readAnnouncementBlocks(file)
    const entries = parseAnnouncement(blocks, { title: src.titleCode, sourceFile: relPath(root, file) })
    const stats = importEntries(db, ctx, src.titleCode, entries)
    n += stats.entries
  }
  grand += n
  console.log(`  ${src.titleCode.padEnd(16)} ${String(n).padStart(6)} 条`)
}
console.log(`完成:导入 ${grand} 条记录`)
