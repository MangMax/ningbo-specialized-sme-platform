import { createError } from 'h3'
import { sql } from 'drizzle-orm'
import type { useApplicationDb } from '../../../../db/client'
import { TITLE_SEED } from '../../../../db/titles'
import { readEffectiveQualifications, readPostgresEffectiveQualifications } from '../../../sme-roster/public'
import type { JobSpec } from '../../../core/server/utils/job-runner'
import type { PostgresJobSpec } from '../../../core/server/public'
import type { LeadVersionDetail } from '../../lib/contracts'
import { LEAD_LIST_EXPORT, leadListExportInput } from '../../lib/export-contract'
import { readLeadVersion } from './versions'
import { readPostgresLeadVersionInSnapshot, usePostgresLeadDb } from './postgres-versions'

function cell(value: string | number | null) {
  const text = String(value ?? '')
  const literal = /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/u.test(text) ? "'" + text : text
  return '"' + literal.replaceAll('"', '""') + '"'
}

type NativeDb = ReturnType<typeof useApplicationDb>

const titleNames = new Map(TITLE_SEED.map(title => [title.code, title.nameZh]))
const headings = ['系列', '获取日期', '来源原件', '原表序号', '企业名称', '统一社会信用代码', '区县', '备注', '基础库企业编号', '有效称号']

function qualificationNames(effective: ReturnType<typeof readEffectiveQualifications>) {
  return (effective ?? []).map(item => titleNames.get(item.titleCode) ?? item.titleCode).join('、')
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

async function runLeadListExport({ db: database, jobId }: Parameters<NonNullable<JobSpec['run']>>[0], params: Record<string, unknown>) {
  const db = database as NativeDb
  const asOf = Date.now()
  const result = db.$client.transaction(() => {
    const version = readLeadVersion(db, Number(params.versionId))
    const qualifications = new Map<number, string>()
    for (const id of linkedEnterprises(version)) {
      qualifications.set(id, qualificationNames(readEffectiveQualifications(db.$client, id, asOf)))
    }
    db.$client.prepare('INSERT INTO lead_list_export(job_id,version_id,content) VALUES(?,?,?) ON CONFLICT(job_id) DO UPDATE SET content=excluded.content')
      .run(jobId, version.id, exportContent(version, qualifications))
    return exportResult(version, asOf, jobId)
  }).immediate()
  return { result }
}

const postgresExport: PostgresJobSpec = {
  async prepare(tx, params) {
    const { rows } = await tx.execute(sql`SELECT id FROM lead_list_version WHERE id = ${Number(params.versionId)}`)
    if (!rows.length) throw createError({ statusCode: 404, message: '名单版本不存在' })
  },
  async run(ctx, params) {
    if (await ctx.cancelled()) return { cancelled: true, result: null }
    const asOf = Date.now()
    const { version, content } = await ctx.db.transaction(async tx => {
      const version = await readPostgresLeadVersionInSnapshot(tx, Number(params.versionId))
      const qualifications = new Map<number, string>()
      for (const id of linkedEnterprises(version)) {
        qualifications.set(id, qualificationNames(await readPostgresEffectiveQualifications(tx, id, asOf)))
      }
      return { version, content: exportContent(version, qualifications) }
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
    if (await ctx.cancelled()) return { cancelled: true, result: null }
    await ctx.db.execute(sql`INSERT INTO lead_list_export (job_id, version_id, content)
      VALUES (${ctx.jobId}, ${version.id}, ${content})
      ON CONFLICT (job_id) DO UPDATE SET content = excluded.content`)
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
  prepare(params, database) {
    if (usePostgresLeadDb()) throw createError({ statusCode: 503, message: '需要启用 PostgreSQL 任务中心' })
    const db = database as NativeDb
    if (!db.$client.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='lead_list_export'").get()) {
      throw createError({ statusCode: 503, message: '请先完成线索名单数据库升级' })
    }
    readLeadVersion(db, Number(params.versionId))
    return runLeadListExport
  },
  run: runLeadListExport,
  get postgres() {
    return process.env.NUXT_POSTGRES_LEAD_REGISTRATION === '1' ? postgresExport : undefined
  },
} satisfies JobSpec
