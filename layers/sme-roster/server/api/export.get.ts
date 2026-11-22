import { legacyExportSheet, writeLegacyXlsx } from '../utils/legacy-export-xlsx'
import { appLog, requestLogContext } from '../../../core/lib/logging'
import { usePostgresRosterDb } from '../utils/postgres-roster-db'
import { allPostgresLedgerRecords } from '../../lib/query-postgres'
import type { EventType } from '#sme-roster/lib/query-projection'
import { TITLES, SOURCES } from '#sme-roster/lib/labels'

const EVENT_TYPES: EventType[] = ['award', 'review', 'maintain', 'nurture']

defineRouteMeta({
  openAPI: {
    tags: ['台账'],
    summary: '导出 Excel',
    responses: {
      200: {
        description: 'xlsx 文件字节(不是 JSON)。',
        content: {
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
            schema: { type: 'string', format: 'binary' },
          },
        },
      },
      400: { description: '不支持的导出参数。' },
    },
    parameters: [
      { name: 'title', in: 'query', schema: { type: 'string' }, description: '称号代号，多值。' },
      { name: 'source', in: 'query', schema: { type: 'string' }, description: '来源,多值。' },
      { name: 'district', in: 'query', schema: { type: 'string' } },
      { name: 'eventType', in: 'query', schema: { type: 'string' }, description: '事件类型,多值。' },
      { name: 'year', in: 'query', schema: { type: 'string' }, description: '事件年份,多值。' },
      { name: 'q', in: 'query', schema: { type: 'string' } },
      { name: 'flags', in: 'query', schema: { type: 'string' } },
    ],
  },
})

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const logContext = requestLogContext(event)
  const operation = 'export.legacy.records.summary'
  let summarized = false
  appLog({ module: 'sme-roster', source: 'export', operation, outcome: 'started' }, logContext)
  try {
    if (q.mode !== undefined) throw createError({ statusCode: 400, statusMessage: 'Unsupported export mode' })
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

    /** 与 `/api/records` 一致的多值解析:逗号分隔或重复参数。 */
    const csv = (v: unknown): string[] | undefined => {
      if (v == null) return undefined
      const raw = Array.isArray(v)
        ? v.flatMap((x) => String(x).split(','))
        : String(v).split(',')
      const list = raw.map((s) => s.trim()).filter(Boolean)
      return list.length ? list : undefined
    }
    const csvEventTypes = (v: unknown): EventType[] | undefined => {
      const list = csv(v)?.filter((x): x is EventType =>
        EVENT_TYPES.includes(x as EventType),
      )
      return list?.length ? list : undefined
    }
    const csvYears = (v: unknown): number[] | undefined => {
      const list = csv(v)
        ?.map((s) => Number(s))
        .filter((n) => Number.isInteger(n) && n > 0)
      return list?.length ? list : undefined
    }

    const filter = {
      title: csv(q.title),
      source: csv(q.source),
      district: str(q.district),
      eventType: csvEventTypes(q.eventType),
      year: csvYears(q.year),
      q: str(q.q),
      flags: str(q.flags),
    }
    const rows = await allPostgresLedgerRecords(usePostgresRosterDb(), filter)

    const enterprises = new Set(rows.map((r) => r.enterpriseId)).size
    summarized = true
    appLog({ module: 'sme-roster', source: 'export', operation, outcome: 'success', counts: { done: rows.length, total: rows.length } }, logContext)
    // 企业数由本次筛选的企业×称号行去重,说明先于表头写入。
    const download = await writeLegacyXlsx(event, async (wb, pace) => {
      const ws = legacyExportSheet(wb, pace, '台账', [
        { header: '企业名称', key: 'name', width: 34 },
        { header: '统一社会信用代码', key: 'uscc', width: 20 },
        { header: '区县', key: 'district', width: 12 },
        { header: '称号', key: 'title', width: 18 },
        { header: '来源', key: 'source', width: 14 },
        { header: '事件', key: 'events', width: 32 },
        { header: '出处', key: 'evidence', width: 44 },
      ],
        `口径:一行 = 一个「企业 × 称号」(同一组合下的多个来源合并成一行)。` +
          `本次筛选共 ${rows.length} 行,属于 ${enterprises} 家企业(多称号企业在行数里按称号各计一次)。` +
          `导出为当前筛选下的全部行,不受页面分页限制;同一筛选条件的「按企业」导出见企业总表导出。`,
      )
      for (const r of rows) {
        await ws.addRow({
          name: r.name,
          uscc: r.uscc ?? '',
          district: r.district ?? '',
          title: TITLES[r.titleCode] ?? r.titleCode,
          source: r.sources.map((s) => SOURCES[s] ?? s).join('、'),
          events: r.events,
          evidence: r.evidence,
        })
      }
    }, 'records')
    setHeader(event, 'content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    setHeader(event, 'content-disposition', `attachment; filename="roster.xlsx"; filename*=UTF-8''roster.xlsx`)
    return download
  } catch (error) {
    if (!summarized) {
      const status = (error as { statusCode?: number })?.statusCode ?? 500
      appLog({ module: 'sme-roster', source: 'export', operation, outcome: status < 500 ? 'denied' : 'failure', statusCode: status, level: 'warn', errorCode: status === 400 ? 'invalid_export_request' : 'legacy_summary_failed' }, logContext)
    }
    throw error
  }
})
