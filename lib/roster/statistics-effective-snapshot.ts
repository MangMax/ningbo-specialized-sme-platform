import { currentCandidateIdBlocks } from './current-candidate-reader'
import { createCurrentTargetContext } from './current-target-context'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { inArray } from 'drizzle-orm'
import { enterprise } from '../../db/schema'
import { countBy } from 'es-toolkit'
import type Database from 'better-sqlite3'
import { createCurrentQualificationAssessmentReader, CURRENT_RULE_VERSION, QUALIFICATION_ASSESSMENT_VERSION, qualificationDay } from './current-qualification'
import { CURRENT_TITLES, type CurrentTitle } from './current-titles'

/** Summary and detail share the caller’s read transaction and evaluation time. */
export function readStatisticsEffectiveSnapshot(db: Database.Database, asOf: number) {
  const { assessment: reader, candidates } = createCurrentTargetContext(db)
  const profiles = drizzle(db)
  const pairs: { enterpriseId: number; titleCode: CurrentTitle; name: string; uscc: string | null; district: string | null }[] = []
  const statuses = new Map<string, ReturnType<typeof reader.readEffectiveTitle>>()
  for (const title of CURRENT_TITLES) {
    // Finish source enumeration before hydration opens its bounded SAVEPOINTs.
    const ids = [...candidates.iterate(title)].map(candidate => candidate.id)
    for (const block of currentCandidateIdBlocks(ids)) {
      for (const row of profiles.select({ enterpriseId: enterprise.id, name: enterprise.name, uscc: enterprise.usccNorm, district: enterprise.district }).from(enterprise).where(inArray(enterprise.id, block)).all()) pairs.push({ ...row, titleCode: title })
      for (const [id, status] of reader.readEffectiveTitleSummaries(block, asOf, title)) statuses.set(`${id}/${title}`, status)
    }
  }
  pairs.sort((a,b) => a.enterpriseId - b.enterpriseId || (a.titleCode < b.titleCode ? -1 : a.titleCode > b.titleCode ? 1 : 0))
  const rows = pairs.map(pair => ({ ...pair, status: statuses.get(`${pair.enterpriseId}/${pair.titleCode}`)!.effectiveStatus, notes: [] as string[], basis: statuses.get(`${pair.enterpriseId}/${pair.titleCode}`)!.basis, references: [] as string[] }))
  const counts = countBy(rows.filter(row => row.status === 'effective'), row => row.titleCode)
  return { asOf: new Date(asOf).toISOString(), evaluationDay: qualificationDay(asOf), timeZone: 'Asia/Shanghai' as const,
    ruleVersion: CURRENT_RULE_VERSION, assessmentVersion: QUALIFICATION_ASSESSMENT_VERSION, grain: 'enterprise_title' as const,
    rows, titles: CURRENT_TITLES.map(titleCode => ({ titleCode, effective: counts[titleCode] ?? 0 })) }
}

/** Hydrate diagnostics only after the caller has counted, filtered and paginated.
 * Keep this in the same read transaction as the effective projection. */
export function hydrateStatisticsRows<T extends { enterpriseId: number; titleCode: string }>(db: Database.Database, rows: T[], asOf: number) {
  const reader = createCurrentQualificationAssessmentReader(db)
  return rows.map(row => {
    const assessed = reader.readTitle(row.enterpriseId, row.titleCode as CurrentTitle, asOf)
    return { ...row, notes: assessed.row.notes, basis: assessed.row.basis, references: assessed.row.references }
  })
}
