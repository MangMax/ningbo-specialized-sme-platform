import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import type { TitleCode } from '../db/titles'
import { COMPARISON_DIRECTIONS, getComparison, type ComparisonDirection, type ComparisonRow } from './comparison'
import { TITLE_ORDER } from './labels'

export interface CuratedRow extends ComparisonRow { nameNorm: string; note?: string }
interface Annotation { note?: string; by?: string; at: string }
type Annotations = Record<string, Annotation>
export interface CurationPatch {
  uscc?: string
  nameNorm?: string
  titleCode: TitleCode
  direction: ComparisonDirection
  curated: boolean
  note?: string
}

/** 不把名称键与统代键混用;JSON 元组同时隔离称号和方向。 */
function key(input: Pick<CurationPatch, 'uscc' | 'nameNorm' | 'titleCode' | 'direction'>) {
  return JSON.stringify([input.uscc || `name:${input.nameNorm}`, input.titleCode, input.direction])
}

export function parseCurationPatch(body: unknown): CurationPatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid curation body')
  const b = body as Record<string, unknown>
  const validIdentifier = (v: unknown) => v === undefined || (typeof v === 'string' && !!v.trim())
  if (!validIdentifier(b.uscc) || !validIdentifier(b.nameNorm) || (!b.uscc && !b.nameNorm) ||
      typeof b.titleCode !== 'string' || !TITLE_ORDER.includes(b.titleCode) ||
      !COMPARISON_DIRECTIONS.includes(b.direction as ComparisonDirection) ||
      typeof b.curated !== 'boolean' || (b.note !== undefined && typeof b.note !== 'string')) {
    throw new Error('Expected enterprise identifier, known title/direction, boolean curated and optional string note')
  }
  return {
    uscc: typeof b.uscc === 'string' ? b.uscc.trim() : undefined,
    nameNorm: typeof b.nameNorm === 'string' ? b.nameNorm.trim() : undefined,
    titleCode: b.titleCode as TitleCode, direction: b.direction as ComparisonDirection,
    curated: b.curated, note: b.note as string | undefined,
  }
}

export function readCuration(path: string): Annotations {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
}

/** 同步读改写避免同一 Nitro 进程的请求丢更新;原子替换避免读取半个 JSON。 */
export function patchCuration(path: string, patch: CurationPatch) {
  const annotations = readCuration(path)
  const identity = key(patch)
  const previous = annotations[identity]
  if (patch.curated) {
    const note = patch.note ?? previous?.note
    if (previous && previous.note === note) return
    annotations[identity] = { ...(note !== undefined ? { note } : {}), at: new Date().toISOString() }
  } else {
    if (!previous) return
    delete annotations[identity]
  }
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(annotations, null, 2)}\n`)
  renameSync(temporary, path)
}

/** 接口层装饰;口径函数及其既有测试保持原样。计数先于筛选与分页。 */
export function getCuratedComparison(db: BetterSQLite3Database<typeof schema>, path: string) {
  const result = getComparison(db)
  const annotations = readCuration(path)
  const names = new Map(db.select({ id: schema.enterprise.id, nameNorm: schema.enterprise.nameNorm }).from(schema.enterprise).all().map(e => [e.id, e.nameNorm]))
  const curatedCounts = Object.fromEntries(TITLE_ORDER.map(code => [code, { missing_in_miit: 0, extra_in_miit: 0 }])) as typeof result.counts
  const rows: CuratedRow[] = result.rows.map(row => {
    const nameNorm = names.get(row.enterpriseId)!
    const annotation = annotations[key({ uscc: row.uscc ?? undefined, nameNorm, titleCode: row.titleCode, direction: row.direction })]
    if (annotation) curatedCounts[row.titleCode][row.direction]++
    return { ...row, nameNorm, curated: !!annotation, ...(annotation?.note !== undefined ? { note: annotation.note } : {}) }
  })
  return { rows, counts: result.counts, curatedCounts }
}
