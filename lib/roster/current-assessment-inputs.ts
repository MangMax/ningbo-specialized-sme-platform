import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../db/schema'
import { hasEnterpriseMergeIdentity } from './enterprise-identity'
import { CURRENT_TITLES, type CurrentTitle } from './current-titles'
import type { EnterpriseFactEffectRow } from './enterprise-fact-effects'

type Executor = Pick<BetterSQLite3Database<typeof s>, 'select'>
function byTitle<T extends { enterpriseId: number; titleCode: string }>(rows: T[]) {
  const result = new Map<number, Map<CurrentTitle, T[]>>()
  for (const row of rows) {
    const title = CURRENT_TITLES.find(title => title === row.titleCode)
    if (!title) continue
    let titles = result.get(row.enterpriseId)
    if (!titles) { titles = new Map(); result.set(row.enterpriseId, titles) }
    const group = titles.get(title) ?? []
    group.push(row); titles.set(title, group)
  }
  return result
}

/** Caller-owned snapshot and bounded ID block; no rows survive this invocation. */
export function createCurrentAssessmentInputs(db: Executor, ids: readonly number[]) {
  const merged = hasEnterpriseMergeIdentity(db)
  const next = new Map<number, number>()
  if (merged) {
    let frontier = [...new Set(ids)]
    const visited = new Set<number>()
    while (frontier.length) {
      for (const id of frontier) visited.add(id)
      const rows = db.select({ from: s.enterpriseMerge.fromEnterpriseId, into: s.enterpriseMerge.intoEnterpriseId })
        .from(s.enterpriseMerge).where(inArray(s.enterpriseMerge.fromEnterpriseId, frontier)).all()
      for (const row of rows) next.set(row.from, row.into)
      frontier = [...new Set(rows.map(row => row.into))].filter(id => !visited.has(id))
    }
  }
  const canonical = new Map<number, number>()
  for (const original of ids) {
    const seen = new Set<number>()
    let id = original
    while (next.has(id)) {
      if (seen.has(id)) throw new Error('Enterprise identity merge cycle')
      seen.add(id); id = next.get(id)!
    }
    canonical.set(original, id)
  }
  const selected = [...new Set(canonical.values())]
  const enterprises = new Map(db.select({ id: s.enterprise.id, name: s.enterprise.name, name_norm: s.enterprise.nameNorm,
    uscc_norm: s.enterprise.usccNorm, district: s.enterprise.district, city: s.enterprise.city }).from(s.enterprise)
    .where(inArray(s.enterprise.id, selected)).all().map(row => [row.id, row]))
  const scope = { enterpriseId: s.record.enterpriseId, titleCode: s.record.titleCode }
  const events = byTitle(db.select({ ...scope, id: s.recordEvent.id, eventType: s.recordEvent.eventType, year: s.recordEvent.year,
    decidedYear: s.recordEvent.decidedYear, batchSeq: s.recordEvent.batchSeq, reviewOutcome: s.recordEvent.reviewOutcome,
    revision: s.recordEvent.revision, nameRaw: s.record.nameRaw, usccRaw: s.record.usccRaw, source: s.record.source })
    .from(s.record).innerJoin(s.recordEvent, eq(s.recordEvent.recordId, s.record.id))
    .where(inArray(s.record.enterpriseId, selected)).orderBy(asc(s.recordEvent.id)).all())
  const evidence = byTitle(db.select({ ...scope, id: s.recordEvidence.id, eventId: s.recordEvidence.recordEventId,
    sourceFile: s.recordEvidence.sourceFile, attachment: s.recordEvidence.attachment, listNo: s.recordEvidence.listNo, page: s.recordEvidence.page })
    .from(s.record).innerJoin(s.recordEvent, eq(s.recordEvent.recordId, s.record.id))
    .innerJoin(s.recordEvidence, eq(s.recordEvidence.recordEventId, s.recordEvent.id))
    .where(inArray(s.record.enterpriseId, selected)).orderBy(asc(s.recordEvidence.id)).all())
  const validityRows = byTitle(db.select({ ...scope, id: s.recordEvent.id, recordId: s.recordEvent.recordId,
    value: sql<string | null>`${s.recordEvent.formalValidity}` }).from(s.record)
    .innerJoin(s.recordEvent, eq(s.recordEvent.recordId, s.record.id)).where(inArray(s.record.enterpriseId, selected))
    .orderBy(asc(s.recordEvent.id)).all())
  const aliases = Map.groupBy(db.select({ enterpriseId: s.enterpriseAlias.enterpriseId, id: s.enterpriseAlias.id,
    name: s.enterpriseAlias.name, version: s.enterpriseAlias.version }).from(s.enterpriseAlias)
    .where(and(inArray(s.enterpriseAlias.enterpriseId, selected), eq(s.enterpriseAlias.verificationStatus, 'confirmed')))
    .orderBy(asc(s.enterpriseAlias.id)).all(), row => row.enterpriseId)
  const paths = [...new Set([...evidence.values()].flatMap(titles => [...titles.values()].flatMap(rows => rows.map(row => row.sourceFile))))]
  const files = new Map(db.select({ relPath: s.storedFile.relPath, id: s.storedFile.id, sha256: s.storedFile.sha256,
    bytes: s.storedFile.bytes, removedAt: s.storedFile.removedAt }).from(s.storedFile)
    .where(inArray(s.storedFile.relPath, paths)).all().map(({ relPath, ...row }) => [relPath, row]))
  const members = new Map(selected.map(id => [id, new Set([id])]))
  const edges: { from: number; into: number }[] = []
  if (merged) {
    let frontier = selected
    const visited = new Set(selected)
    while (frontier.length) {
      const rows = db.select({ from: s.enterpriseMerge.fromEnterpriseId, into: s.enterpriseMerge.intoEnterpriseId })
        .from(s.enterpriseMerge).where(inArray(s.enterpriseMerge.intoEnterpriseId, frontier)).all()
      edges.push(...rows)
      frontier = [...new Set(rows.map(row => row.from))].filter(id => !visited.has(id))
      for (const id of frontier) visited.add(id)
    }
  }
  for (const [id, ancestors] of members) {
    const pending = [id]
    while (pending.length) {
      const parent = pending.pop()!
      for (const edge of edges) if (edge.into === parent && !ancestors.has(edge.from)) {
        ancestors.add(edge.from); pending.push(edge.from)
      }
    }
  }
  const factIds = [...new Set([...members.values()].flatMap(group => [...group]))]
  const revisions = db.select({ enterpriseId: s.enterpriseFactRevision.enterpriseId, factId: s.enterpriseFactRevision.factId,
    revision: s.enterpriseFactRevision.revision, status: s.enterpriseFactRevision.status,
    fact: sql<string>`${s.enterpriseFactRevision.fact}`, basis: s.enterpriseFactRevision.basis })
    .from(s.enterpriseFactRevision).where(inArray(s.enterpriseFactRevision.enterpriseId, factIds))
    .orderBy(asc(s.enterpriseFactRevision.id)).all()
  const facts = new Map<number, EnterpriseFactEffectRow[]>(selected.map(id => [id, revisions.filter(row => members.get(id)!.has(row.enterpriseId))]))
  return { canonical, enterprises, events, evidence, validityRows, aliases, files, facts }
}
export type CurrentAssessmentInputs = ReturnType<typeof createCurrentAssessmentInputs>
