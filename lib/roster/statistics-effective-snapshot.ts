import { countBy } from 'es-toolkit'
import type Database from 'better-sqlite3'
import { createCurrentQualificationAssessmentReader, CURRENT_RULE_VERSION, QUALIFICATION_ASSESSMENT_VERSION, qualificationDay } from './current-qualification'
import { createCurrentTargetContext } from './current-target-context'
import { CURRENT_TITLES, type CurrentTitle } from './current-titles'

/** Summary and detail share the caller’s read transaction and evaluation time. */
export function readStatisticsEffectiveSnapshot(db: Database.Database, asOf: number) {
  const reader = createCurrentQualificationAssessmentReader(db)
  const pairs = db.prepare(`select distinct r.enterprise_id enterpriseId,r.title_code titleCode,e.name,e.uscc_norm uscc,e.district
    from record r join enterprise e on e.id=r.enterprise_id where r.title_code in ('little_giant','specialized_sme','innovative_sme') order by r.enterprise_id,r.title_code`).all() as { enterpriseId: number; titleCode: CurrentTitle; name: string; uscc: string | null; district: string | null }[]
  const rows = pairs.map(pair => {
    const assessed = reader.readEffectiveTitle(pair.enterpriseId, pair.titleCode, asOf)
    return { ...pair, status: assessed.effectiveStatus, notes: [] as string[], basis: assessed.basis, references: [] as string[] }
  })
  const counts = countBy(rows.filter(row => row.status === 'effective'), row => row.titleCode)
  return { asOf: new Date(asOf).toISOString(), evaluationDay: qualificationDay(asOf), timeZone: 'Asia/Shanghai' as const,
    ruleVersion: CURRENT_RULE_VERSION, assessmentVersion: QUALIFICATION_ASSESSMENT_VERSION, grain: 'enterprise_title' as const,
    rows, titles: CURRENT_TITLES.map(titleCode => ({ titleCode, effective: counts[titleCode] ?? 0 })) }
}

/** Hydrate diagnostics only after the caller has counted, filtered and paginated.
 * Keep this in the same read transaction as the effective projection. */
export function hydrateStatisticsRows<T extends { enterpriseId: number; titleCode: string }>(db: Database.Database, rows: T[], asOf: number) {
  const reader = createCurrentTargetContext(db)?.assessment ?? createCurrentQualificationAssessmentReader(db)
  return rows.map(row => {
    const assessed = reader.readTitle(row.enterpriseId, row.titleCode as CurrentTitle, asOf)
    return { ...row, notes: assessed.row.notes, basis: assessed.row.basis, references: assessed.row.references }
  })
}
