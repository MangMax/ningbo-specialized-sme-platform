import { and, count as countRows, desc, eq, gt, gte, inArray, isNull, lt, lte, sql, sum, type SQL } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg, { type PoolClient } from 'pg'
import { postgresLogTables } from '../../../../db/postgresql/log-tables'
import { LOG_DEFAULTS, UNLABELED_LOG_MODULE, type LogEvent, type LogFilter, type LogPolicyPatch } from './contract'
import { LOG_FIELD_PROFILES, defaultFieldControls, mergeFieldControls, projectLogFields, validateCompleteFieldControls, validateFieldControlsPatch } from './field-controls'
import { boundedLogOutput } from './output'
import { collectionAllows, decodeStoredLogCollection, defaultLogCollection, validateCollection } from './policy'

type Filter = LogFilter & { limit: number; beforeSeq?: number }
const accounting = 'UTF-8 bytes of stored event JSON; excludes duplicated filter columns, indexes, PostgreSQL storage overhead and container stdout'
const profiles = LOG_FIELD_PROFILES
const dayMs = 86400000
const policyId = BigInt(1)
const maxSignedBigint = BigInt('9223372036854775807')
const filterColumns = ['level', 'source', 'operation', 'outcome', 'requestId', 'traceId', 'taskId', 'batchId', 'resourceId'] as const

export class PostgresLogError extends Error {
  constructor(readonly code: string, readonly writeOutcome: 'unknown' | 'not_written') { super(code) }
}

type LogTables = ReturnType<typeof postgresLogTables>
type LogTransaction = Parameters<Parameters<ReturnType<typeof drizzle>['transaction']>[0]>[0]

function count(value: bigint | string) {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid_log_counter')
  return n
}

function parseFileId(value: string | number) {
  // SQLite compares an INTEGER column using numeric affinity when the filter
  // text denotes a number. Other permitted filter tokens match no rows.
  const text = String(value)
  if (/^[0-9]+$/.test(text)) {
    const integer = BigInt(text)
    return integer <= maxSignedBigint ? integer : null
  }
  if (!/^[0-9]+(?:\.[0-9]*)?(?:e[+-]?[0-9]+)?$/i.test(text)) return null
  const integer = Number(text)
  if (!Number.isInteger(integer) || BigInt(integer) > maxSignedBigint) return null
  return BigInt(integer)
}

function predicate(events: LogTables['events'], filter: Filter) {
  const clauses: SQL[] = []
  for (const column of filterColumns) {
    const value = filter[column]
    if (value !== undefined) clauses.push(eq(events[column], String(value)))
  }
  if (filter.fileId !== undefined) {
    const fileId = parseFileId(filter.fileId)
    if (fileId === null) return { matches: false as const }
    clauses.push(eq(events.fileId, fileId))
  }
  if (filter.module === UNLABELED_LOG_MODULE) clauses.push(isNull(events.module))
  else if (filter.module !== undefined) clauses.push(eq(events.module, filter.module))
  if (filter.from) clauses.push(gte(events.timestamp, filter.from))
  if (filter.to) clauses.push(lte(events.timestamp, filter.to))
  return { matches: true as const, where: and(...clauses) }
}

function failureCode(error: unknown) {
  const failure = error as { code?: string; cause?: { code?: string } } | null
  const code = failure?.code ?? failure?.cause?.code
  return code === '53100' ? 'storage_full' : code === '25006' ? 'storage_readonly' : 'storage_unavailable'
}

async function readPolicy(tx: LogTransaction, { policy, collection: settings }: LogTables) {
  const [row] = await tx.select({
    retentionDays: policy.retentionDays, maxBytes: policy.maxBytes, logicalBytes: policy.logicalBytes,
    pruned: policy.pruned, cleared: policy.cleared, collection: settings.collection, revision: settings.revision,
  }).from(policy).innerJoin(settings, eq(policy.id, settings.id)).where(eq(policy.id, policyId))
  if (!row) throw new Error('invalid_log_policy')
  const { collection, fieldControls } = decodeStoredLogCollection(
    JSON.parse(row.collection), defaultLogCollection(), profiles, validateCollection, defaultFieldControls,
    (value, definitions) => validateCompleteFieldControls(value, definitions, validateFieldControlsPatch),
  )
  return {
    retentionDays: count(row.retentionDays), maxBytes: count(row.maxBytes), storageBytes: count(row.logicalBytes),
    pruned: count(row.pruned), cleared: count(row.cleared), revision: count(row.revision),
    collection, fieldControls, accounting,
  }
}

async function deleteOldest(tx: LogTransaction, { events, policy }: LogTables, where: SQL | undefined, counter: 'pruned' | 'cleared') {
  const oldest = tx.select({ seq: events.seq }).from(events).where(where)
    .orderBy(events.seq).limit(LOG_DEFAULTS.clearBatchSize)
  const removed = tx.$with('removed').as(tx.delete(events).where(inArray(events.seq, oldest)).returning({
    // Drizzle 0.45.4 has no octet length or arithmetic expression builders.
    bytes: sql<bigint>`octet_length(${events.detail})::bigint`.as('bytes'),
  }))
  const totals = tx.$with('totals').as(tx.select({
    deleted: countRows().as('deleted'),
    bytes: sum(removed.bytes).as('bytes'),
  }).from(removed))
  // Keep these PostgreSQL arithmetic expressions in the atomic update.
  const [row] = await tx.with(removed, totals).update(policy).set({
    [counter]: sql`${policy[counter]} + ${totals.deleted}`,
    logicalBytes: sql`${policy.logicalBytes} - ${totals.bytes}`,
  }).from(totals).where(and(eq(policy.id, policyId), gt(totals.deleted, 0))).returning({
    deleted: totals.deleted, bytes: totals.bytes,
  })
  return row ? { deleted: row.deleted, bytes: count(row.bytes!) } : { deleted: 0, bytes: 0 }
}

async function maintain(tx: LogTransaction, tables: LogTables, now: number, retentionDays: number, limit: number, initialBytes: number) {
  const cutoff = new Date(now - retentionDays * dayMs).toISOString()
  let bytes = initialBytes - (await deleteOldest(tx, tables, lt(tables.events.timestamp, cutoff), 'pruned')).bytes
  for (let i = 0; i < 32 && bytes > limit; i++) {
    const removed = await deleteOldest(tx, tables, undefined, 'pruned')
    if (!removed.deleted) break
    bytes -= removed.bytes
  }
  return bytes
}

export function createPostgresLogStorage(connectionString: string, maxEventBytes: number, timeoutMs: number, enableStdout: boolean, schemaName?: string) {
  const tables = postgresLogTables(schemaName)
  const { events: logEvents, policy: logPolicy, collection: logCollection } = tables
  const pool = new pg.Pool({
    connectionString, max: 1, connectionTimeoutMillis: timeoutMs,
    statement_timeout: timeoutMs, lock_timeout: timeoutMs,
  })
  pool.on('error', () => { /* The pool removes idle failed connections. */ })
  const stdout = enableStdout ? boundedLogOutput(process.stdout, maxEventBytes + 1) : undefined
  let closing: Promise<void> | undefined

  async function execute(action: string, data: unknown, now: number, signal: AbortSignal): Promise<unknown> {
    let client: PoolClient | undefined
    let released = false
    let commitSent = false
    const abort = () => {
      if (client && !released) { released = true; client.release(true) }
    }
    try {
      if (signal.aborted) throw new Error('logging_timeout')
      client = await pool.connect()
      if (signal.aborted) throw new Error('logging_timeout')
      signal.addEventListener('abort', abort, { once: true })
      const readOnly = action === 'detail' || (action === 'policy' && !data)
      const db = drizzle({ client })
      return await db.transaction(async tx => {
        // Take the writer lock in its own statement. A READ COMMITTED snapshot
        // taken before waiting for the lock could otherwise see an old joined
        // collection row alongside the new storage policy.
        if (!readOnly) await tx.select({ id: logPolicy.id }).from(logPolicy).where(eq(logPolicy.id, policyId)).for('update')
        const policy = await readPolicy(tx, tables)
        const cutoff = new Date(now - policy.retentionDays * dayMs).toISOString()
        let result: unknown
        switch (action) {
          case 'policy': {
            if (!data) { result = policy; break }
            const patch = data as LogPolicyPatch
            const bytes = await maintain(tx, tables, now, patch.retentionDays, patch.maxBytes, policy.storageBytes)
            if (bytes > patch.maxBytes) { result = { transitionPending: true }; break }
            const collection = {
              sources: { ...policy.collection.sources, ...patch.collection?.sources },
              integrations: { ...policy.collection.integrations, ...patch.collection?.integrations },
            }
            const fieldControls = mergeFieldControls(policy.fieldControls, patch.fieldControls ?? {}, profiles)
            await tx.update(logPolicy).set({
              retentionDays: BigInt(patch.retentionDays), maxBytes: BigInt(patch.maxBytes),
            }).where(eq(logPolicy.id, policyId))
            await tx.update(logCollection).set({
              collection: JSON.stringify({ version: 2, collection, fieldControls }),
              revision: BigInt(policy.revision) + BigInt(1),
            }).where(eq(logCollection.id, policyId))
            result = await readPolicy(tx, tables)
            break
          }
          case 'maintain':
            await maintain(tx, tables, now, policy.retentionDays, policy.maxBytes, policy.storageBytes)
            result = null
            break
          case 'clear': {
            const filter = predicate(logEvents, data as Filter)
            if (!filter.matches) { result = { deleted: 0, hasMore: false }; break }
            const { deleted } = await deleteOldest(tx, tables, filter.where, 'cleared')
            const more = await tx.select({ seq: logEvents.seq }).from(logEvents).where(filter.where).limit(1)
            result = { deleted, hasMore: more.length > 0 }
            break
          }
          case 'list': {
            await maintain(tx, tables, now, policy.retentionDays, policy.maxBytes, policy.storageBytes)
            const input = data as Filter
            const filter = predicate(logEvents, input)
            if (!filter.matches) { result = { rows: [], nextSeq: null }; break }
            const rows = await tx.select({ seq: logEvents.seq, module: logEvents.module, detail: logEvents.detail })
              .from(logEvents).where(and(
                filter.where,
                gte(logEvents.timestamp, cutoff),
                input.beforeSeq === undefined ? undefined : lt(logEvents.seq, BigInt(input.beforeSeq)),
              )).orderBy(desc(logEvents.seq)).limit(input.limit + 1)
            const more = rows.length > input.limit
            if (more) rows.pop()
            result = {
              rows: rows.map(row => {
                const { auditId, receiptId, parentEventId, ...summary } = JSON.parse(row.detail) as LogEvent
                return { ...summary, module: row.module }
              }),
              nextSeq: more ? count(rows.at(-1)!.seq) : null,
            }
            break
          }
          case 'detail': {
            const [row] = await tx.select({ module: logEvents.module, detail: logEvents.detail }).from(logEvents)
              .where(and(eq(logEvents.id, data as string), gte(logEvents.timestamp, cutoff)))
            result = row ? { ...JSON.parse(row.detail), module: row.module } : null
            break
          }
          case 'write': {
            const events = data as LogEvent[]
            const collected = events.filter(event => collectionAllows(event, policy.collection))
            const projected = collected.map(event => projectLogFields(event, policy.fieldControls, policy.revision, profiles))
            const allowed = projected.flatMap(event => {
              const detail = JSON.stringify(event)
              if (Buffer.byteLength(detail) > maxEventBytes) return []
              return [{ event, detail }]
            })
            const added = allowed.reduce((sum, row) => sum + Buffer.byteLength(row.detail), 0)
            const bytes = await maintain(tx, tables, now, policy.retentionDays, policy.maxBytes - added, policy.storageBytes)
            let stored = 0
            let code: string | undefined
            if (allowed.length && bytes + added <= policy.maxBytes) {
              try {
                await tx.transaction(async batch => {
                  await batch.insert(logEvents).values(allowed.map(({ event, detail }) => ({
                    id: event.id, timestamp: event.timestamp, level: event.level, source: event.source,
                    module: event.module ?? null, operation: event.operation, outcome: event.outcome,
                    requestId: event.requestId ?? null, traceId: event.traceId ?? null, taskId: event.taskId ?? null,
                    fileId: event.fileId == null ? null : BigInt(event.fileId),
                    batchId: event.batchId === undefined ? null : String(event.batchId),
                    resourceId: event.resourceId === undefined ? null : String(event.resourceId),
                    detail,
                  })))
                  await batch.update(logPolicy).set({ logicalBytes: BigInt(bytes + added) }).where(eq(logPolicy.id, policyId))
                })
                stored = allowed.length
              } catch (error) {
                // A rejected savepoint recovery leaves the outer transaction aborted.
                if (signal.aborted || client?.getTransactionStatus() !== 'T') throw error
                code = failureCode(error)
              }
            } else if (allowed.length) code = 'storage_full'
            let fallbackSkipped = 0
            if (stdout) for (const { detail } of allowed) if (!stdout.write(detail + '\n')) fallbackSkipped++
            result = { stored, filtered: events.length - collected.length, oversized: projected.length - allowed.length, fallbackSkipped, code }
            break
          }
          default: throw new Error('unsupported_log_command')
        }
        if (signal.aborted) throw new Error('logging_timeout')
        commitSent = action === 'write'
        return result
      }, readOnly ? { isolationLevel: 'repeatable read', accessMode: 'read only' } : undefined)
    } catch (error) {
      if (client && !released && client.getTransactionStatus() !== 'I') abort()
      throw new PostgresLogError(failureCode(error), commitSent ? 'unknown' : 'not_written')
    } finally {
      signal.removeEventListener('abort', abort)
      if (client && !released) client.release(signal.aborted)
    }
  }

  return {
    execute,
    close() {
      stdout?.close()
      return closing ??= pool.end()
    },
  }
}
