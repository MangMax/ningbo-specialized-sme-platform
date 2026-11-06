import type Database from 'better-sqlite3'
import { createCurrentQualificationAssessmentReader, CURRENT_RULE_VERSION, QUALIFICATION_ASSESSMENT_VERSION, qualificationDay } from './current-qualification'
import { CURRENT_TITLES, type CurrentTitle } from './current-titles'

/** Resolved once inside the caller's read transaction. No global row cache.
 * #515 can group rows by current district and select detail from these same rows.
 * The caller owns the transaction for summary, detail and any annual projection. */
export function readStatisticsEffectiveSnapshot(db: Database.Database, asOf: number) {
  const reader = createCurrentQualificationAssessmentReader(db)
  const pairs = db.prepare(`select distinct r.enterprise_id enterpriseId,r.title_code titleCode,e.name,e.uscc_norm uscc,e.district
    from record r join enterprise e on e.id=r.enterprise_id where r.title_code in ('little_giant','specialized_sme','innovative_sme') order by r.enterprise_id,r.title_code`).all() as { enterpriseId: number; titleCode: CurrentTitle; name: string; uscc: string | null; district: string | null }[]
  const rows = pairs.map(pair => {
    const assessed = reader.readTitle(pair.enterpriseId, pair.titleCode, asOf)
    return { ...pair, status: assessed.effectiveStatus, notes: assessed.row.notes, basis: assessed.row.basis, references: assessed.row.references }
  })
  return { asOf: new Date(asOf).toISOString(), evaluationDay: qualificationDay(asOf), timeZone: 'Asia/Shanghai' as const,
    ruleVersion: CURRENT_RULE_VERSION, assessmentVersion: QUALIFICATION_ASSESSMENT_VERSION, grain: 'enterprise_title' as const,
    rows, titles: CURRENT_TITLES.map(titleCode => ({ titleCode, effective: rows.filter(r => r.titleCode === titleCode && r.status === 'effective').length })) }
}
