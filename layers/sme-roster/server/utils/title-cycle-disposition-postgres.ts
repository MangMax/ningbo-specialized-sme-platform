import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { postgresRosterRow, readPostgresRosterRowsById } from '../../lib/roster/postgres-rows'
import type { DispositionFact } from '../../../../db/title-cycle-disposition'
import {
  dispositionDependencies, DispositionError, dispositionHash, projectCurrentDispositions, simulateDispositions,
  type DispositionRequest, type DispositionRow,
} from './title-cycle-disposition'

type Reader = Pick<NodePgDatabase, 'execute'>
const ids = (values: readonly number[]) => sql`${sql.param(values)}::bigint[]`
const heads = sql`NOT EXISTS (SELECT 1 FROM title_cycle_disposition_revision newer WHERE newer.id = p.id AND newer.revision > p.revision)`
const snapshot = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const

async function currentVersion(db: Reader) {
  const { rows: [row] } = await db.execute<{ n: number | null }>(sql`SELECT max(revision_id)::float8 AS n FROM title_cycle_disposition_revision`)
  return dispositionHash({ n: row!.n })
}

async function dispositionRows(db: Reader, enterpriseIds: readonly number[], latest = false) {
  const { rows } = await db.execute<{ row: DispositionRow }>(sql`
    SELECT ${postgresRosterRow(schema.titleCycleDispositionRevision, 'p')} AS row
    FROM title_cycle_disposition_revision p WHERE p.enterprise_id = ANY(${ids(enterpriseIds)})
      ${latest ? sql`AND ${heads}` : sql.empty()} ORDER BY p.revision_id`)
  return rows.map(({ row }) => row)
}

async function loadDependencies(db: Reader, enterpriseIds: readonly number[], facts: readonly DispositionFact[], lock: boolean) {
  const fileIds = ids([...new Set(facts.map(fact => fact.source.fileId))])
  const eventIds = ids([...new Set(facts.flatMap(fact => [fact.cycle?.eventId, fact.formalEvent?.eventId].filter(id => id !== undefined)))])
  const fence = lock ? sql`FOR UPDATE` : sql.empty()
  const enterprises = await readPostgresRosterRowsById(db, schema.enterprise, sql`
    FROM (SELECT * FROM enterprise WHERE id = ANY(${ids(enterpriseIds)}) ORDER BY id ${lock ? sql`FOR SHARE` : sql.empty()}) p`)
  const files = await readPostgresRosterRowsById(db, schema.storedFile, sql`
    FROM (SELECT * FROM stored_file WHERE id = ANY(${fileIds}) ORDER BY id ${fence}) p`)
  const events = await readPostgresRosterRowsById(db, schema.recordEvent, sql`
    FROM (SELECT * FROM record_event WHERE id = ANY(${eventIds}) ORDER BY id ${fence}) p`)
  const records = await readPostgresRosterRowsById(db, schema.record, sql`
    FROM (SELECT * FROM record WHERE id = ANY(${ids(events.map(event => event.recordId))}) ORDER BY id ${lock ? sql`FOR SHARE` : sql.empty()}) p`)
  const evidence = await readPostgresRosterRowsById(db, schema.recordEvidence, sql`
    FROM (SELECT * FROM record_evidence WHERE record_event_id = ANY(${eventIds}) ORDER BY id ${fence}) p`)
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
  const { rows: [prior] } = await tx.execute<{ requestHash: string; receipt: { ids: string[]; version: string; committedAt: string } }>(sql`
    SELECT request_hash AS "requestHash", receipt::json AS receipt FROM title_cycle_disposition_receipt WHERE key = ${request.idempotencyKey}`)
  if (prior) {
    if (prior.requestHash !== requestHash) throw new DispositionError('idempotency_conflict')
    return { prior: prior.receipt, planHash: dispositionHash({ requestHash }) }
  }
  if (await currentVersion(tx) !== request.expectedVersion) throw new DispositionError('version_conflict')
  const targets = request.operations.flatMap(op => 'id' in op ? [op.id] : [])
  const { rows } = await tx.execute<{ id: string; enterpriseId: number }>(sql`
    SELECT id, enterprise_id::float8 AS "enterpriseId" FROM title_cycle_disposition_revision p
    WHERE id = ANY(${sql.param(targets)}::text[]) AND ${heads}`)
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
    await tx.execute(sql`SELECT pg_advisory_xact_lock(144815, hashtext('title-cycle-disposition'))`)
    const committedAt = new Date().toISOString()
    const plan = await prepare(tx, request, committedAt)
    if (plan.prior) return plan.prior
    if (plan.planHash !== planHash) throw new DispositionError('plan_conflict')
    for (const row of plan.appended!) {
      await tx.execute(sql`INSERT INTO title_cycle_disposition_revision
        (id, revision, enterprise_id, title_code, cycle_event_id, status, kind, source_file_id, source_sha256, cycle_revision,
          effective_precision, effective_value, fact, audit)
        VALUES (${row.id}, ${row.revision}, ${row.enterpriseId}, ${row.titleCode}, ${row.cycleEventId}, ${row.status}, ${row.kind},
          ${row.sourceFileId}, ${row.sourceSha256}, ${row.cycleRevision}, ${row.effectivePrecision}, ${row.effectiveValue},
          ${JSON.stringify(row.fact)}, ${JSON.stringify(row.audit)})`)
    }
    const receipt = { ids: plan.ids!, version: await currentVersion(tx), committedAt }
    await tx.execute(sql`INSERT INTO title_cycle_disposition_receipt (key, request_hash, receipt)
      VALUES (${request.idempotencyKey}, ${plan.requestHash}, ${JSON.stringify(receipt)})`)
    return receipt
  })
}
