/** Source-owned platform business facts shared by qualification and business timelines.
 * This reader does not adjudicate current qualification or synthesize published events. */
import { and, eq, inArray, notExists, or, gt } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { targetSchema as s } from '../platform/target-schema'
import { normalizeUscc } from '../domain'
import { isValidUscc } from './uscc-research'
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

/** Latest observed content per stable business record, before filtering identity/title.
 * A failed query with no observations cannot erase a previously captured fact.
 * Re-observing an old content version makes that observed version current again.
 * Enumerate raw identity keys through covering indexes, then read only matched typed rows. */
export function readPlatformQualificationFacts(db: BetterSQLite3Database<typeof s>, subjects: readonly PlatformFactSubject[]): PlatformQualificationFact[] {
  const owners = new Map<string, Set<number>>()
  for (const subject of subjects) {
    const code = normalizeUscc(subject.uscc)
    if (!isValidUscc(code)) continue
    const ids = owners.get(code) ?? new Set<number>()
    ids.add(subject.enterpriseId); owners.set(code, ids)
  }
  if (!owners.size) return []
  const newer = alias(s.platformBusinessObservation, 'qualification_newer_observation')
  const collection = alias(s.platformCollection, 'qualification_newer_collection')
  const o = s.platformBusinessObservation, c = s.platformCollection
  const latest = notExists(db.select({ id: newer.id }).from(newer)
    .innerJoin(collection, eq(collection.id, newer.collectionId))
    .where(and(eq(newer.recordId, o.recordId), eq(newer.contentState, 'verified'), or(gt(collection.queriedAt, c.queriedAt), and(eq(collection.queriedAt, c.queriedAt), gt(newer.id, o.id))))))
  const facts: PlatformQualificationFact[] = []
  // Keep raw values: SQL upper/trim is not equivalent to JS normalizeUscc.
  // Only keys are streamed; unrelated typed payloads and observations are not loaded.
  function matchingKeys(rows: Iterable<{ raw: string | null }>) {
    const keys: string[] = []
    for (const { raw } of rows) {
      if (raw != null && owners.has(normalizeUscc(raw))) keys.push(raw)
    }
    return keys
  }
  const recognizedKeys = matchingKeys(db.selectDistinct({ raw: s.platformRecognizedProjection.usccRaw }).from(s.platformRecognizedProjection).iterate())
  const businessKeys = matchingKeys(db.selectDistinct({ raw: s.platformBusinessProjection.usccRaw }).from(s.platformBusinessProjection).iterate())
  const applyKeys = matchingKeys(db.selectDistinct({ raw: s.platformApplyProjection.usccRaw }).from(s.platformApplyProjection).iterate())
  // Multiple raw spellings may normalize to one subject; chunk raw keys, not owners.
  for (let offset = 0; offset < Math.max(recognizedKeys.length, businessKeys.length, applyKeys.length); offset += 400) {
    const recognizedScope = recognizedKeys.slice(offset, offset + 400)
    const businessScope = businessKeys.slice(offset, offset + 400)
    const applyScope = applyKeys.slice(offset, offset + 400)
    const common = { recordId: o.recordId, versionId: o.versionId, observationId: o.id, collectedAt: c.queriedAt }
    const recognized = recognizedScope.length ? db.select({ ...common, p: s.platformRecognizedProjection }).from(o)
      .innerJoin(c, eq(c.id, o.collectionId))
      .innerJoin(s.platformRecognizedProjection, eq(s.platformRecognizedProjection.versionId, o.versionId))
      .where(and(latest, inArray(s.platformRecognizedProjection.usccRaw, recognizedScope))).all() : []
    const business = businessScope.length ? db.select({ ...common, p: s.platformBusinessProjection }).from(o)
      .innerJoin(c, eq(c.id, o.collectionId))
      .innerJoin(s.platformBusinessProjection, eq(s.platformBusinessProjection.versionId, o.versionId))
      .where(and(latest, inArray(s.platformBusinessProjection.usccRaw, businessScope))).all() : []
    const declarations = applyScope.length ? db.select({ ...common, p: s.platformApplyProjection }).from(o)
      .innerJoin(c, eq(c.id, o.collectionId))
      .innerJoin(s.platformApplyProjection, eq(s.platformApplyProjection.versionId, o.versionId))
      .where(and(latest, inArray(s.platformApplyProjection.usccRaw, applyScope))).all() : []
    for (const row of [...recognized.map(r => ({ ...r, source: 'recognized_list' as const })), ...business.map(r => ({ ...r, source: 'business_list' as const })), ...declarations.map(r => ({ ...r, source: 'apply_list' as const }))]) {
      const p = row.p, uscc = normalizeUscc(p.usccRaw)
      const ids = owners.get(uscc)!
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
      facts.push(fact)
    }
  }
  return facts.sort((a, b) => a.recordId - b.recordId)
}
