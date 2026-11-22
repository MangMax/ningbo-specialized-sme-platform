import { existsSync, readFileSync } from 'node:fs'
import type { TitleCode } from '../../../db/titles'
import type { ComparisonDirection, ComparisonRow, ComparisonResult } from './comparison-model'
import { TITLE_ORDER } from './labels'

export interface CuratedRow extends ComparisonRow { nameNorm: string; note?: string }
interface Annotation { note?: string; by?: string; at: string }
type Annotations = Record<string, Annotation>
/** 不把名称键与统代键混用;JSON 元组同时隔离称号和方向。 */
function key(input: { uscc?: string; nameNorm: string; titleCode: TitleCode; direction: ComparisonDirection }) {
  return JSON.stringify([input.uscc || `name:${input.nameNorm}`, input.titleCode, input.direction])
}

export function readCuration(path: string): Annotations {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
}

export function projectCuratedComparison(result: ComparisonResult, annotations: Annotations, names: ReadonlyMap<number, string>) {
  const curatedCounts = Object.fromEntries(TITLE_ORDER.map(code => [code, { missing_in_miit: 0, extra_in_miit: 0 }])) as typeof result.counts
  const rows: CuratedRow[] = result.rows.map(row => {
    const nameNorm = names.get(row.enterpriseId)!
    const annotation = annotations[key({ uscc: row.uscc ?? undefined, nameNorm, titleCode: row.titleCode, direction: row.direction })]
    if (annotation) curatedCounts[row.titleCode][row.direction]++
    return { ...row, nameNorm, curated: !!annotation, ...(annotation?.note !== undefined ? { note: annotation.note } : {}) }
  })
  return { rows, counts: result.counts, curatedCounts }
}
