import { and, eq, gt, inArray, max, notExists, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { storedFile } from '../../../../db/postgresql/file-tables'
import { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import { titleCycleDispositionRevision as revision, titleCycleDispositionReceipt as receipt } from '../../../../db/postgresql/qualification-tables'
import type { DispositionFact } from '../../../../db/title-cycle-disposition'
import {
  dispositionDependencies, DispositionError, dispositionHash, projectCurrentDispositions, simulateDispositions,
  type DispositionRequest, type DispositionRow,
} from './title-cycle-disposition'

type Reader = Pick<NodePgDatabase, 'select'>
const snapshot = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const
const newer = alias(revision, 'newer')
const heads = (db: Reader) => notExists(db.select({ id: newer.id }).from(newer)
  .where(and(eq(newer.id, revision.id), gt(newer.revision, revision.revision))))

async function currentVersion(db: Reader) {
  const [row] = await db.select({ n: max(revision.revisionId) }).from(revision)
  return dispositionHash({ n: row!.n })
}

async function dispositionRows(db: Reader, enterpriseIds: readonly number[], latest = false): Promise<DispositionRow[]> {
  const rows = await db.select().from(revision)
    .where(and(inArray(revision.enterpriseId, enterpriseIds), latest ? heads(db) : undefined)).orderBy(revision.revisionId)
  return rows.map(row => ({ ...row, titleCode: row.titleCode as DispositionRow['titleCode'],
    status: row.status as DispositionRow['status'], kind: row.kind as DispositionRow['kind'],
    effectivePrecision: row.effectivePrecision as DispositionRow['effectivePrecision'],
    fact: JSON.parse(row.fact), audit: JSON.parse(row.audit) }))
}

async function loadDependencies(db: Reader, enterpriseIds: readonly number[], facts: readonly DispositionFact[], lock: boolean) {
  const fileIds = [...new Set(facts.map(fact => fact.source.fileId))]
  const eventIds = [...new Set(facts.flatMap(fact => [fact.cycle?.eventId, fact.formalEvent?.eventId].filter(id => id !== undefined)))]
  const enterpriseQuery = db.select().from(enterprise).where(inArray(enterprise.id, enterpriseIds)).orderBy(enterprise.id)
  const enterprises = (await (lock ? enterpriseQuery.for('share') : enterpriseQuery))
    .map(row => ({ ...row, qualityFlags: row.qualityFlags === null ? null : JSON.parse(row.qualityFlags) }))
  const fileQuery = db.select().from(storedFile).where(inArray(storedFile.id, fileIds)).orderBy(storedFile.id)
  const files = (await (lock ? fileQuery.for('update') : fileQuery)).map(row => ({ ...row, bytes: Number(row.bytes) }))
  const eventQuery = db.select().from(recordEvent).where(inArray(recordEvent.id, eventIds)).orderBy(recordEvent.id)
  // Preflight hashes the dependency object with the established JSON field order.
  const events = (await (lock ? eventQuery.for('update') : eventQuery)).map(({ revision, formalValidity, ...event }) => ({
    ...event, formalValidity: formalValidity === null ? null : JSON.parse(formalValidity), revision,
  }))
  const recordQuery = db.select().from(record).where(inArray(record.id, events.map(event => event.recordId))).orderBy(record.id)
  const records = (await (lock ? recordQuery.for('share') : recordQuery))
    .map(row => ({ ...row, qualityFlags: row.qualityFlags === null ? null : JSON.parse(row.qualityFlags) }))
  const evidenceQuery = db.select().from(recordEvidence).where(inArray(recordEvidence.recordEventId, eventIds)).orderBy(recordEvidence.id)
  const evidence = await (lock ? evidenceQuery.for('update') : evidenceQuery)
  const enterpriseById = new Map(enterprises.map(row => [row.id, row]))
  const fileById = new Map(files.map(row => [row.id, row]))
  const eventById = new Map(events.map(row => [row.id, row]))
  const recordById = new Map(records.map(row => [row.id, row]))
  const evidenceByEvent = Map.groupBy(evidence, row => row.recordEventId)
  return (id: number, fact: DispositionFact) => dispositionDependencies({
    enterprise: id => enterpriseById.get(id),
    file: id => fileById.get(id),
    event: id => eventById.get(id),
    record: id => recordById.get(id),
    evidence: id => evidenceByEvent.get(id) ?? [],
  }, id, fact)
}

export function readPostgresDispositions(db: NodePgDatabase, enterpriseIds: number[], latest: boolean) {
  return db.transaction(async tx => {
    const rows = await dispositionRows(tx, enterpriseIds, latest)
    if (!latest) return { rows }
    const resolve = await loadDependencies(tx, enterpriseIds, rows.map(row => row.fact), false)
    return projectCurrentDispositions(await currentVersion(tx), rows, resolve)
  }, snapshot)
}

async function prepare(tx: Reader, request: DispositionRequest, committedAt?: string) {
  const requestHash = dispositionHash(request)
  const [prior] = await tx.select().from(receipt).where(eq(receipt.key, request.idempotencyKey))
  if (prior) {
    if (prior.requestHash !== requestHash) throw new DispositionError('idempotency_conflict')
    return { prior: JSON.parse(prior.receipt) as { ids: string[]; version: string; committedAt: string }, planHash: dispositionHash({ requestHash }) }
  }
  if (await currentVersion(tx) !== request.expectedVersion) throw new DispositionError('version_conflict')
  const targets = request.operations.flatMap(op => 'id' in op ? [op.id] : [])
  const rows = await tx.select({ id: revision.id, enterpriseId: revision.enterpriseId }).from(revision)
    .where(and(inArray(revision.id, targets), heads(tx)))
  const owners = new Map(rows.map(row => [row.id, row.enterpriseId]))
  const enterpriseIds = [...new Set(request.operations.map(op => {
    const id = 'enterpriseId' in op ? op.enterpriseId : owners.get(op.id)
    if (id === undefined) throw new DispositionError('revision_conflict')
    return id
  }))]
  const existing = await dispositionRows(tx, enterpriseIds, true)
  const byId = new Map(existing.map(row => [row.id, row.fact]))
  const facts = request.operations.flatMap(op => 'fact' in op ? [op.fact]
    : op.action === 'confirm' && byId.has(op.id) ? [byId.get(op.id)!] : [])
  const resolve = await loadDependencies(tx, enterpriseIds, facts, committedAt !== undefined)
  const { deps, appended, ids } = simulateDispositions(existing, request, resolve, committedAt ?? '')
  return { prior: null, planHash: dispositionHash({ requestHash, deps }), requestHash, appended, ids }
}

export function preflightPostgresDisposition(db: NodePgDatabase, request: DispositionRequest) {
  return db.transaction(async tx => {
    const plan = await prepare(tx, request)
    return { planHash: plan.planHash, replay: Boolean(plan.prior) }
  }, snapshot)
}

export function commitPostgresDisposition(db: NodePgDatabase, request: DispositionRequest, planHash: string) {
  return db.transaction(async tx => {
    // Drizzle has no builder for PostgreSQL transaction advisory locks and hashtext.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(144815, hashtext('title-cycle-disposition'))`)
    const committedAt = new Date().toISOString()
    const plan = await prepare(tx, request, committedAt)
    if (plan.prior) return plan.prior
    if (plan.planHash !== planHash) throw new DispositionError('plan_conflict')
    for (const row of plan.appended!) {
      await tx.insert(revision).values({ ...row, fact: JSON.stringify(row.fact), audit: JSON.stringify(row.audit) })
    }
    const result = { ids: plan.ids!, version: await currentVersion(tx), committedAt }
    await tx.insert(receipt).values({ key: request.idempotencyKey, requestHash: plan.requestHash, receipt: JSON.stringify(result) })
    return result
  })
}
