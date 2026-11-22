import { TITLE_ORDER } from '../labels'
import { MAX_PAGE_SIZE } from '../query-limits'
import { summarizeFirstRecognition, type RecognitionEntry, type RecognitionEvent } from './first-recognition'
import { computeFirstAward } from './lifecycle'

export interface RecognitionCoordinate { enterpriseId: number; name: string; titleCode: string }
type AwardRow = RecognitionCoordinate & RecognitionEvent & { hasEvidence: boolean }

function rank(code: string) {
  const index = TITLE_ORDER.indexOf(code)
  return index < 0 ? TITLE_ORDER.length : index
}

export function compareRecognitionCoordinates(a: RecognitionCoordinate, b: RecognitionCoordinate) {
  return rank(a.titleCode) - rank(b.titleCode) || a.name.localeCompare(b.name) || a.enterpriseId - b.enterpriseId
}

export function* summarizeRecognitionAwards(rows: Iterable<AwardRow>) {
  let coordinate: RecognitionCoordinate | undefined
  let events: AwardRow[] = []
  const finish = () => {
    const lifecycle = computeFirstAward(events)
    const hasEvidence = events.some(event => event.id === lifecycle.firstRecognitionEventId && event.hasEvidence)
    return { ...coordinate!, ...summarizeFirstRecognition({ titleCode: coordinate!.titleCode, lifecycle, events, hasEvidence })! }
  }
  for (const row of rows) {
    if (coordinate?.enterpriseId !== row.enterpriseId || coordinate?.titleCode !== row.titleCode) {
      if (coordinate) yield finish()
      coordinate = { enterpriseId: row.enterpriseId, name: row.name, titleCode: row.titleCode }
      events = []
    }
    events.push(row)
  }
  if (coordinate) yield finish()
}

/** §7.5 的一行:身份 + 该(企业 × 称号)的首次认定。 */
export interface RosterRecognitionRow extends RecognitionEntry {
  enterpriseId: number
  name: string
  uscc: string | null
  /** 与 §7.1 同一处口径(企业属地,为空时退回最早那条带属地的记录)。 */
  district: string | null
}

export interface RosterRecognitionFilter {
  /** 称号(多值,命中任一)。 */
  title?: string[]
  /**
   * **首次认定年份**(多值,命中任一)。
   *
   * 就叫 `year`:这个端点的主体**本来就是**首次认定,`year` 在这里没有第二种解释
   * (与 §7.1 的 `firstYear` 是同一个量 —— 那边名字更长是因为它得与**事件**年份区分开)。
   */
  year?: number[]
  /** 首次认定状态(多值:`confirmed` / `pending`)。 */
  status?: string[]
  page?: number
  pageSize?: number
}

export interface RosterRecognitionsResult {
  rows: RosterRecognitionRow[]
  counts: {
    /** 符合筛选的**企业 × 称号**数(= 行数,先于分页)。 */
    titlePairs: number
    /** 符合筛选的**企业**数(多称号企业在总数里只算一家)。 */
    enterprises: number
    /** 每个称号下符合筛选的**企业 × 称号**数(桶恒在,缺省为 0)。 */
    titles: Record<string, number>
  }
  page: number
  pageSize: number
}

const DEFAULT_PAGE_SIZE = 50

export function recognitionPageOf(input: { page?: number; pageSize?: number }): { page: number; pageSize: number } {
  const page = Number.isFinite(input.page) && (input.page as number) >= 1 ? Math.floor(input.page as number) : 1
  const size =
    Number.isFinite(input.pageSize) && (input.pageSize as number) >= 1
      ? Math.floor(input.pageSize as number)
      : DEFAULT_PAGE_SIZE
  return { page, pageSize: Math.min(size, MAX_PAGE_SIZE) }
}
