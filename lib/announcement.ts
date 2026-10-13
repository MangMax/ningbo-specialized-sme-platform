import type { Block } from './docx'
import {
  classifyEvent,
  normalizeUscc,
  parseBatch,
  type EventKind,
} from './normalize'

/** 公布文件解析出的单条记录(未落库)。 */
export interface ParsedEntry {
  title: string
  source: 'jxj'
  eventType: EventKind
  year: number | null
  seq: number | null
  district: string
  name: string
  uscc: string | null
  sourceFile: string
  attachment: string | null
  listNo: number
}

const ATTACHMENT_RE = /^附\s*件/

interface Section {
  attachment: string
  header: string
  tables: string[][][]
}

function splitSections(blocks: Block[]): Section[] {
  const sections: Section[] = []
  let cur: Section | null = null
  for (const b of blocks) {
    if (b.type === 'p') {
      if (ATTACHMENT_RE.test(b.text)) {
        cur = { attachment: b.text.replace(/\s+/g, ' ').trim(), header: '', tables: [] }
        sections.push(cur)
      } else if (cur && cur.tables.length === 0 && b.text) {
        cur.header += (cur.header ? ' ' : '') + b.text
      }
    } else if (cur) {
      cur.tables.push(b.rows)
    }
  }
  return sections
}

interface ColMap {
  no: number
  name: number
  district: number
  uscc: number
}

function mapColumns(header: string[]): ColMap {
  const find = (keys: string[]) =>
    header.findIndex((h) => keys.some((k) => h.includes(k)))
  return {
    no: find(['序号']),
    name: find(['企业名称']),
    district: find(['属地']),
    uscc: find(['统一社会信用代码', '统一信用代码', '统一社会信用']),
  }
}

/**
 * 解析一份公布文件的块序列为记录。
 * 附件标题决定称号与事件类型;段内「有效期：YYYY…」行切换当前年份(处理同一附件并置多段名单)。
 */
export function parseAnnouncement(
  blocks: Block[],
  opts: { title: string; sourceFile: string },
): ParsedEntry[] {
  const out: ParsedEntry[] = []
  for (const section of splitSections(blocks)) {
    if (section.tables.length === 0) continue
    const eventType = classifyEvent(section.header)
    const base = parseBatch(section.header)
    let year = base.year
    let seq = base.seq

    for (const table of section.tables) {
      const header = table[0]
      if (!header || table.length < 2) continue
      const cols = mapColumns(header)
      if (cols.no === -1 || cols.name === -1) continue

      for (const row of table.slice(1)) {
        const noCell = (row[cols.no] ?? '').trim()
        const joined = row.join(' ')

        // 段内小标题行(如「一、有效期：2021年6月1日至…」)切换当前年份。
        if (!/^\d+$/.test(noCell)) {
          const ym = joined.match(/有效期[^\d]*(20\d{2})/) ?? joined.match(/(20\d{2})年[^。]{0,8}起有效/)
          if (ym) year = Number(ym[1])
          continue
        }

        const name = (row[cols.name] ?? '').trim()
        if (!name) continue

        out.push({
          title: opts.title,
          source: 'jxj',
          eventType,
          year,
          seq,
          district: cols.district >= 0 ? (row[cols.district] ?? '').trim() : '',
          name,
          uscc: normalizeUscc(cols.uscc >= 0 ? row[cols.uscc] : null),
          sourceFile: opts.sourceFile,
          attachment: section.attachment,
          listNo: Number(noCell),
        })
      }
    }
  }
  return out
}
