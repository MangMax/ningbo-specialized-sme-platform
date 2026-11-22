import { normalizeUscc } from '../domain'
import { RDJB_TITLE_CODES } from '../platform/recognized-evidence'
import type { CurrentTitle } from './current-titles'

export interface PlatformBusinessDate {
  raw: string | null
  value: string | null
  precision: 'day' | 'second' | 'unknown'
}
export function sourceDate(raw: string | null): PlatformBusinessDate {
  const unknown: PlatformBusinessDate = { raw, value: null, precision: 'unknown' }
  if (!raw || !/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?$/.test(raw)) return unknown
  const value = raw.replace(' ', 'T')
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00Z` : `${value}Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, value.length) !== value) return unknown
  return { raw, value, precision: value.length === 10 ? 'day' : 'second' }
}
/** Local business time, inclusive day cutoff; no mutation of the original date. */
export function periodContains(from: PlatformBusinessDate, until: PlatformBusinessDate, at: string): boolean | null {
  const point = sourceDate(at)
  if (!from.value || !until.value || !point.value) return null
  const start = from.precision === 'day' ? `${from.value}T00:00:00` : from.value
  const end = until.precision === 'day' ? `${until.value}T23:59:59` : until.value
  const current = point.precision === 'day' ? `${point.value}T00:00:00` : point.value
  return start <= current && current <= end
}

type ProcessSource = 'business_list' | 'apply_list'
interface ProcessFields { declareKind: string | null; status: string | null; year: number | null; appliedAt: string | null }
/** Dictionaries remain explicitly source-owned. Only observed final success is mapped.
 * Unknown negative values stay unknown until that interface's original sample confirms them. */
const processConclusions = {
  business_list: { '终审通过': 'passed', '待审核': 'processing', '市已审': 'processing', '省已审': 'processing' },
  apply_list: { '终审通过': 'passed', '待审核': 'processing', '市已审': 'processing', '省已审': 'processing' },
} as const
export function platformBusinessFact(source: ProcessSource, fields: ProcessFields) {
  const matter = fields.declareKind === 'apply' || fields.declareKind === 'review' || fields.declareKind === 'update' ? fields.declareKind : 'unknown'
  const dictionary = processConclusions[source]
  const conclusion: 'passed' | 'processing' | 'unknown' = fields.status && Object.hasOwn(dictionary, fields.status)
    ? dictionary[fields.status as keyof typeof dictionary] : 'unknown'
  return {
    matter, matterRaw: fields.declareKind, conclusion, statusRaw: fields.status,
    businessTime: sourceDate(fields.appliedAt), businessTimeKind: 'submission' as const,
    businessYear: fields.year,
    periodReason: matter === 'update' ? 'update_does_not_renew' : fields.year == null ? 'period_unknown' : 'explicit_business_year',
  }
}

export interface PlatformQualificationFact {
  enterpriseId: number | null
  uscc: string
  title: CurrentTitle | null
  source: 'recognized_list' | ProcessSource
  platformName: string | null
  recordId: number
  versionId: number
  observationId: number
  collectedAt: string
  matter: string
  matterRaw: string | null
  conclusion: 'passed' | 'processing' | 'unknown' | 'invalid'
  statusRaw: string | number | null
  businessTime: PlatformBusinessDate
  businessTimeKind: 'recognition' | 'submission'
  businessYear: number | null
  period: { from: PlatformBusinessDate; until: PlatformBusinessDate }
  periodReason: string
  location: { province: string | null; city: string | null; district: string | null }
  invalidatedAt: PlatformBusinessDate
  invalidationReason: string | null
  reasons: string[]
}
export interface PlatformFactSubject { enterpriseId: number; uscc: string }

export type PlatformQualificationFactsReader = (subjects: readonly PlatformFactSubject[]) => PlatformQualificationFact[]

type PlatformFactProjection = {
  usccRaw: string | null; titleRaw: string | null; nameRaw: string | null
} & ({
  qualificationFieldsRule: string | null; sourceValidFlag: unknown; sourceRecognizedAt: string | null
  sourceValidityDate: string | null; sourceProvinceName: string | null; sourceCityName: string | null
  sourceDistrictName: string | null; sourceInvalidatedAt: string | null; sourceInvalidationReason: string | null
} | {
  declareKind: string | null; status: string | null; appliedAt: string | null
} & ({ businessYear: number | null; province: string | null } | { declarationYear: number | null }))

export type PlatformQualificationInputRow = {
  recordId: number | null; versionId: number | null; observationId: number; collectedAt: string
  source: PlatformQualificationFact['source']; p: PlatformFactProjection
}

export function projectPlatformQualificationFact(row: PlatformQualificationInputRow, owners: ReadonlyMap<string, ReadonlySet<number>>): PlatformQualificationFact | null {
  const p = row.p, uscc = normalizeUscc(p.usccRaw)
  const ids = owners.get(uscc)
  if (!ids) return null
  const title = RDJB_TITLE_CODES[p.titleRaw ?? ''] as CurrentTitle | undefined
  const reasons = [...(ids.size === 1 ? [] : ['identity_ambiguous']), ...(title ? [] : ['title_unknown'])]
  let fact: PlatformQualificationFact = {
    enterpriseId: ids.size === 1 ? [...ids][0]! : null, uscc, title: title ?? null,
    source: row.source, platformName: p.nameRaw,
    recordId: row.recordId!, versionId: row.versionId!, observationId: row.observationId, collectedAt: row.collectedAt,
    matter: 'recognition', matterRaw: null, conclusion: 'unknown', statusRaw: null,
    businessTime: sourceDate(null), businessTimeKind: 'recognition', businessYear: null,
    period: { from: sourceDate(null), until: sourceDate(null) }, periodReason: 'period_unknown',
    location: { province: null, city: null, district: null }, invalidatedAt: sourceDate(null), invalidationReason: null, reasons,
  }
  if ('qualificationFieldsRule' in p) {
    fact.statusRaw = typeof p.sourceValidFlag === 'string' || typeof p.sourceValidFlag === 'number' ? p.sourceValidFlag : null
    fact.businessTime = sourceDate(p.sourceRecognizedAt)
    fact.period = { from: fact.businessTime, until: sourceDate(p.sourceValidityDate) }
    fact.periodReason = fact.period.from.value && fact.period.until.value ? 'explicit_period' : 'period_unknown'
    fact.location = { province: p.sourceProvinceName, city: p.sourceCityName, district: p.sourceDistrictName }
    fact.invalidatedAt = sourceDate(p.sourceInvalidatedAt); fact.invalidationReason = p.sourceInvalidationReason
    // Preserve invalidation timing for the asOf adjudicator; do not turn future invalidation into current cancellation.
    fact.conclusion = p.sourceValidFlag === '1' || p.sourceValidFlag === 1 ? 'passed' : p.sourceValidFlag === '0' || p.sourceValidFlag === 0 ? 'invalid' : 'unknown'
    if (!p.qualificationFieldsRule) reasons.push('qualification_fields_uncaptured')
  } else {
    const process = platformBusinessFact(row.source as ProcessSource, { declareKind: p.declareKind, status: p.status, year: 'businessYear' in p ? p.businessYear : p.declarationYear, appliedAt: p.appliedAt })
    fact = { ...fact, ...process }
    if ('province' in p) fact.location.province = p.province
    if (process.matter === 'unknown') reasons.push('matter_unknown')
  }
  if (fact.conclusion === 'unknown') reasons.push('status_unknown')
  if (fact.periodReason === 'period_unknown') reasons.push('period_unknown')
  return fact
}
