import { createError } from 'h3'
import { eq } from 'drizzle-orm'
import { postgresLeadListExport, postgresLeadListVersion } from '../../../../db/postgresql/lead-tables'
import { TITLE_SEED } from '../../../../db/titles'
import { readPostgresEffectiveQualificationsBatch } from '../../../sme-roster/public'
import type { JobSpec, PostgresJobSpec } from '../../../core/server/public'
import type { LeadVersionDetail } from '../../lib/contracts'
import { LEAD_LIST_EXPORT, leadListExportInput } from '../../lib/export-contract'
import { readPostgresLeadVersionInSnapshot } from './postgres-versions'

function cell(value: string | number | null) {
  const text = String(value ?? '')
  const literal = /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/u.test(text) ? "'" + text : text
  return '"' + literal.replaceAll('"', '""') + '"'
}

const titleNames = new Map<string, string>(TITLE_SEED.map(title => [title.code, title.nameZh]))
const headings = ['系列', '获取日期', '来源原件', '原表序号', '企业名称', '统一社会信用代码', '区县', '备注', '基础库企业编号', '有效称号']

function qualificationNames(effective: readonly { titleCode: string }[]) {
  return effective.map(item => titleNames.get(item.titleCode) ?? item.titleCode).join('、')
}

function linkedEnterprises(version: LeadVersionDetail) {
  return new Set(version.rows.flatMap(row => row.enterpriseId === null ? [] : [row.enterpriseId]))
}

function exportContent(version: LeadVersionDetail, qualifications: Map<number, string>) {
  const rows = version.rows.map(row => [
    version.series, version.acquiredOn, version.fileName, row.rowNumber, row.name, row.uscc, row.district, row.note,
    row.enterpriseId, row.enterpriseId === null ? '' : (qualifications.get(row.enterpriseId) ?? ''),
  ])
  return '\uFEFF' + [headings, ...rows].map(record => record.map(cell).join(',')).join('\r\n') + '\r\n'
}

function exportResult(version: LeadVersionDetail, asOf: number, jobId: string) {
  return { versionId: version.id, rowCount: version.rows.length, asOf: new Date(asOf).toISOString(), downloadUrl: `/api/lead-lists/exports/${jobId}/download` }
}

const postgresExport: PostgresJobSpec = {
  async prepare(tx, params) {
    const rows = await tx.select({ id: postgresLeadListVersion.id }).from(postgresLeadListVersion)
      .where(eq(postgresLeadListVersion.id, Number(params.versionId)))
    if (!rows.length) throw createError({ statusCode: 404, message: '名单版本不存在' })
  },
  async run(ctx, params) {
    if (await ctx.cancelled()) return { cancelled: true, result: null }
    const asOf = Date.now()
    const { version, content } = await ctx.db.transaction(async tx => {
      const version = await readPostgresLeadVersionInSnapshot(tx, Number(params.versionId))
      const effective = await readPostgresEffectiveQualificationsBatch(tx, [...linkedEnterprises(version)], asOf)
      const qualifications = new Map([...effective].map(([id, titles]) => [id, qualificationNames(titles)]))
      return { version, content: exportContent(version, qualifications) }
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
    if (await ctx.cancelled()) return { cancelled: true, result: null }
    await ctx.db.insert(postgresLeadListExport).values({ jobId: ctx.jobId, versionId: version.id, content })
      .onConflictDoUpdate({ target: postgresLeadListExport.jobId, set: { content } })
    return { result: exportResult(version, asOf, ctx.jobId) }
  },
}

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
  postgres: postgresExport,
} satisfies JobSpec
