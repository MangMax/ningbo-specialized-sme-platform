import { createError } from 'h3'
import type { useApplicationDb } from '../../../../db/client'
import { readEffectiveQualifications } from '../../../sme-roster/public'
import type { JobSpec } from '../../../core/server/utils/job-runner'
import { LEAD_LIST_EXPORT, leadListExportInput } from '../../lib/export-contract'
import { readLeadVersion } from './versions'

function cell(value: string | number | null) {
  const text = String(value ?? '')
  const literal = /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/u.test(text) ? "'" + text : text
  return '"' + literal.replaceAll('"', '""') + '"'
}

type NativeDb = ReturnType<typeof useApplicationDb>

export const leadListVersionExport = {
  kind: LEAD_LIST_EXPORT,
  status: 'ready',
  summary: '导出名单版本',
  maxPending: 4,
  deduplicateRequest: true,
  paramsHint: 'versionId 为名单版本编号，clientRequestId 为请求 UUID',
  parse(raw) {
    const result = leadListExportInput.safeParse(raw)
    return result.success ? { ok: true, params: result.data } : { ok: false, message: '需要有效的版本编号和请求 UUID' }
  },
  prepare(params, database) {
    const db = database as NativeDb
    if (!db.$client.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='lead_list_export'").get()) {
      throw createError({ statusCode: 503, message: '请先完成线索名单数据库升级' })
    }
    readLeadVersion(db, Number(params.versionId))
    return runLeadListExport
  },
  run: runLeadListExport,
} satisfies JobSpec

const titleNames: Record<string, string> = {
  little_giant: '专精特新小巨人',
  specialized_sme: '专精特新中小企业',
  innovative_sme: '创新型中小企业',
}
const headings = ['系列', '获取日期', '来源原件', '原表序号', '企业名称', '统一社会信用代码', '区县', '备注', '基础库企业编号', '有效称号']
async function runLeadListExport({ db: database, jobId }: Parameters<NonNullable<JobSpec['run']>>[0], params: Record<string, unknown>) {
  const db = database as NativeDb
  const asOf = Date.now()
  const result = db.$client.transaction(() => {
    const version = readLeadVersion(db, Number(params.versionId))
    const qualifications = new Map<number, string>()
    const rows = version.rows.map(row => {
      const id = row.enterpriseId
      if (id !== null && !qualifications.has(id)) {
        const effective = readEffectiveQualifications(db.$client, id, asOf) ?? []
        qualifications.set(id, effective.map(item => titleNames[item.titleCode] ?? item.titleCode).join('、'))
      }
      return [version.series, version.acquiredOn, version.fileName, row.rowNumber,
        row.name, row.uscc, row.district, row.note, id, id === null ? '' : (qualifications.get(id) ?? '')]
    })
    const content = '\uFEFF' + [headings, ...rows].map(record => record.map(cell).join(',')).join('\r\n') + '\r\n'
    db.$client.prepare('INSERT INTO lead_list_export(job_id,version_id,content) VALUES(?,?,?) ON CONFLICT(job_id) DO UPDATE SET content=excluded.content')
      .run(jobId, version.id, content)
    return { versionId: version.id, rowCount: rows.length, asOf: new Date(asOf).toISOString(), downloadUrl: `/api/lead-lists/exports/${jobId}/download` }
  }).immediate()
  return { result }
}
