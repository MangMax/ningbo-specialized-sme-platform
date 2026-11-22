import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import ExcelJS from 'exceljs'
import pg from 'pg'
import { expect } from 'vitest'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import { differenceReason } from '../../../../db/postgresql/roster-selection-tables'
import { normalizeUscc } from '../../../../layers/sme-roster/lib/domain'
import { TASK_EXPORTS } from '../../../../layers/sme-roster/lib/sme-roster/task-exports'
import type { CurrentTitle } from '../../../../layers/sme-roster/lib/roster/current-titles'
import { readPostgresEvidenceImpacts113 } from '../../../../layers/sme-roster/lib/roster/query-assessment-postgres'
import { readPostgresCurrentQualification } from '../../../../layers/sme-roster/lib/roster/current-qualification-postgres'
import { nativeAppAdapter } from '../../../support/native-app'
import { rows, type Event, fresh, titleCode } from './specialized-export'

type DecisionScope = { enterpriseId: number; titleCode: CurrentTitle; direction: typeof differenceReason.$inferInsert.direction }
const decisionPath = '/api/roster/decision-lifecycle/commands'
const exportFixtureActor = { type: 'agent', id: 'synthetic-export' }

export function postgresIdentityExportFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'roster-identity-export-'))
  const app = nativeAppAdapter({ dir, token: 'synthetic-export-identity-token' })
  const identities = new Map<number, { name: string; usccNorm: string }>()
  let pool: pg.Pool | undefined
  let database: NodePgDatabase

  async function start() {
    await app.start()
    pool = new pg.Pool({ connectionString: app.postgresUrl, options: '-c search_path=business,public' })
    database = drizzle(pool)
  }

  async function resetBusiness() {
    await pool!.query(`truncate business.enterprise, business.record, business.record_event, business.record_evidence,
      business.platform_collection, business.platform_archive_value, business.platform_business_record,
      business.import_batch, business.difference_reason, business.evidence_review_receipt_114,
      business.evidence_revision_113, business.evidence_semantic_head_113, business.evidence_scope_version_113,
      business.evidence_rule_release_114, business.explanation_impact_113 restart identity cascade`)
    identities.clear()
  }

  async function candidate(name: string, events: Event[] = fresh, title: CurrentTitle = titleCode, usccNorm = normalizeUscc('SYNTHETIC-118-' + name)) {
    const result = await database.transaction(async tx => {
      const [owner] = await tx.insert(enterprise).values({ name, nameNorm: name, usccNorm, district: '鄞州区', city: '宁波市' }).returning({ id: enterprise.id })
      const [row] = await tx.insert(record).values({ enterpriseId: owner!.id, source: 'jxj', titleCode: title, nameRaw: name }).returning({ id: record.id })
      for (const item of events) {
        const [event] = await tx.insert(recordEvent).values({ recordId: row!.id, ...item }).returning({ id: recordEvent.id })
        await tx.insert(recordEvidence).values({ recordEventId: event!.id, sourceFile: 'jxj/announcement/synthetic-118.xlsx', attachment: '专精特新中小企业名单', listNo: owner!.id })
      }
      return { enterprise: { id: owner!.id, name, usccNorm }, record: row! }
    })
    identities.set(result.enterprise.id, result.enterprise)
    return result
  }

  async function reviewToken(scope: DecisionScope, decisionId: number) {
    const { token } = (await readPostgresEvidenceImpacts113(database, [{ scope, decisionId, latestDecisionId: decisionId }]))[0]!
    expect(token.projectionReady).toBe(true)
    return { latestRevisionId: token.latestRevisionId, projectionReady: true }
  }

  async function decision(enterpriseId: number, reasonCode: NonNullable<typeof differenceReason.$inferInsert.reasonCode>, extra: Partial<typeof differenceReason.$inferInsert> = {}) {
    const now = new Date().toISOString()
    const [row] = await database.insert(differenceReason).values({ enterpriseId, titleCode, direction: 'extra_in_miit', status: 'confirmed_reason', reasonCode,
      verificationStatus: 'confirmed', lifecycleAction: 'replace', basis: '人工确认合成主体事实', effectiveAt: '2025-01-01T00:00:00Z', recordedAt: now, createdAt: now, ...extra }).returning()
    if (row!.lifecycleAction === 'replace' && row!.basis && row!.effectiveAt) {
      const scope = { enterpriseId, titleCode: row!.titleCode as CurrentTitle, direction: row!.direction }
      const response = await app.request(decisionPath, { method: 'POST', body: JSON.stringify({ ...scope,
        action: 'maintain', expectedCurrentId: row!.id, idempotencyKey: 'fixture-reviewed-' + row!.id, actor: exportFixtureActor, basis: row!.basis,
        ruleVersion: 'synthetic-export', effectiveAt: row!.effectiveAt, reviewedEvidence: await reviewToken(scope, row!.id),
      }) })
      expect(response.status, await response.text()).toBe(200)
    }
    return row!
  }

  async function workbook(key: string, title: CurrentTitle = titleCode) {
    const { path } = TASK_EXPORTS.find(item => item.titleCode === title)!
    const response = await app.request(path, { method: 'POST', body: JSON.stringify({ clientRequestId: key }) })
    const accepted = await response.json()
    expect(response.status, JSON.stringify(accepted)).toBe(202)
    const job = await app.terminal(accepted.jobId)
    expect(job.state, JSON.stringify(job)).toBe('done')
    expect(job.params.titleCode).toBe(title)
    const download = await app.download(job.result.artifact.downloadUrl)
    expect(download.response.status).toBe(200)
    expect(createHash('sha256').update(download.bytes).digest('hex')).toBe(job.result.artifact.sha256)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(Uint8Array.from(download.bytes).buffer)
    return { wb, result: job.result }
  }

  function identity(id: number) {
    const owner = identities.get(id)
    if (!owner) throw new Error('Missing synthetic enterprise ' + id)
    return owner
  }
  function occurrences(wb: ExcelJS.Workbook, id: number) {
    const { name, usccNorm } = identity(id)
    return wb.worksheets.slice(0, 5).flatMap(sheet => rows(wb, sheet.name)
      .filter(row => row[2] === name && row[3] === usccNorm).map(row => ({ sheet: sheet.name, row })))
  }

  async function currentGroup(id: number, title: CurrentTitle, asOf = Date.now()) {
    const assessment = await database.transaction(tx => readPostgresCurrentQualification(tx, id, asOf),
      { isolationLevel: 'repeatable read', accessMode: 'read only' })
    return assessment?.titles.find(row => row.titleCode === title)?.group
  }

  return { get db() { return database }, headers: app.headers, url: app.url, candidate, decision, identity, occurrences, reviewToken, start, resetBusiness, workbook,
    currentGroup,
    query: (statement: string, values: unknown[] = []) => pool!.query(statement, values),
    async close() {
      try { await pool?.end() }
      finally {
        try { await app.close() }
        finally { rmSync(dir, { recursive: true, force: true }) }
      }
    },
  }
}
