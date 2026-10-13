import { relative, resolve } from 'node:path'
import { readAnnouncementBlocks } from '../lib/docx'
import { parseAnnouncement } from '../lib/announcement'
import { JXJ_SOURCES, discoverAnnouncements } from '../lib/sources'

/**
 * 解析所有经信局公布文件并打印计数,用于与交叉校验基线
 * `公布文件名单全部整理版.xlsx` 比对(回归基线)。
 *
 * 用法:`pnpm check:jxj [--root <数据目录>]`
 * `--root` 可给绝对路径;未给时回退 `SOURCE_ROOT`,再回退 `../`。
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

// resolve() 同时兼容相对/绝对路径,使 `--root` 可用于任意目录。
const SOURCE_ROOT = resolve(arg('root') ?? process.env.SOURCE_ROOT ?? '../')
console.log('root:', SOURCE_ROOT)

for (const src of JXJ_SOURCES) {
  const files = await discoverAnnouncements(SOURCE_ROOT, src.subdir)
  let total = 0
  console.log(`\n### ${src.subdir} (${src.titleCode})`)
  for (const f of files) {
    try {
      const blocks = await readAnnouncementBlocks(f)
      const entries = parseAnnouncement(blocks, { title: src.titleCode, sourceFile: relative(SOURCE_ROOT, f) })
      total += entries.length
      const kinds = entries.reduce<Record<string, number>>((a, e) => {
        a[e.eventType] = (a[e.eventType] ?? 0) + 1
        return a
      }, {})
      console.log(`  ${String(entries.length).padStart(5)}  ${JSON.stringify(kinds)}  ${relative(SOURCE_ROOT, f)}`)
    } catch (err) {
      console.log(`  ERROR  ${relative(SOURCE_ROOT, f)}: ${(err as Error).message}`)
    }
  }
  console.log(`  TOTAL ${total}`)
}
