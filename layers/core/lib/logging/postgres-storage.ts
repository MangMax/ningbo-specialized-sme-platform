import pg, { type PoolClient } from 'pg'
import { LOG_DEFAULTS, UNLABELED_LOG_MODULE, type LogEvent, type LogFilter, type LogPolicyPatch } from './contract'
import { LOG_FIELD_PROFILES, defaultFieldControls, mergeFieldControls, projectLogFields, validateCompleteFieldControls, validateFieldControlsPatch } from './field-controls'
import { boundedLogOutput } from './output'
import { collectionAllows, decodeStoredLogCollection, defaultLogCollection, validateCollection } from './policy'

type Filter = LogFilter & { limit: number; beforeSeq?: number }
const schema = 'runtime_logs'
const accounting = 'UTF-8 bytes of stored event summary and detail JSON; excludes duplicated filter columns, indexes, PostgreSQL storage overhead and container stdout'
const profiles = LOG_FIELD_PROFILES
const dayMs = 86400000
const filterColumns = ['level', 'source', 'operation', 'outcome', 'requestId', 'traceId', 'taskId', 'fileId', 'batchId', 'resourceId'] as const

export class PostgresLogError extends Error {
  constructor(readonly code: string, readonly writeOutcome: 'unknown' | 'not_written') { super(code) }
}

type PolicyRow = {
  retentionDays: string; maxBytes: string; logical_bytes: string; pruned: string; cleared: string
  collection: string; revision: string
}

function count(value: string) {
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
    return integer <= 9223372036854775807n ? integer.toString() : null
  }
  if (!/^[0-9]+(?:\.[0-9]*)?(?:e[+-]?[0-9]+)?$/i.test(text)) return null
  const integer = Number(text)
  if (!Number.isInteger(integer) || BigInt(integer) > 9223372036854775807n) return null
  return BigInt(integer).toString()
}

function predicate(filter: Filter) {
  const values: (string | number)[] = []
  const clauses: string[] = []
  const add = (column: string, operator: string, value: string | number) => {
    values.push(value)
    clauses.push(`"${column}" ${operator} $${values.length}`)
  }
  for (const column of filterColumns) {
    const value = filter[column]
    if (value === undefined) continue
    const bound = column === 'fileId' ? parseFileId(value) : String(value)
    if (bound === null) clauses.push('FALSE')
    else add(column, '=', bound)
  }
  if (filter.module === UNLABELED_LOG_MODULE) clauses.push('module IS NULL')
  else if (filter.module !== undefined) add('module', '=', filter.module)
  if (filter.from) add('timestamp', '>=', filter.from)
  if (filter.to) add('timestamp', '<=', filter.to)
  return { values, add, sql: () => clauses.join(' AND ') || 'TRUE' }
}

function failureCode(error: unknown) {
  const code = (error as { code?: string } | null)?.code
  return code === '53100' ? 'storage_full' : code === '25006' ? 'storage_readonly' : 'storage_unavailable'
}

async function readPolicy(client: PoolClient) {
  const { rows } = await client.query<PolicyRow>(`
    SELECT p."retentionDays", p."maxBytes", p.logical_bytes, p.pruned, p.cleared, c.collection, c.revision
    FROM ${schema}.log_policy p JOIN ${schema}.log_collection c USING (id)
    WHERE p.id = 1
  `)
  const row = rows[0]
  if (!row) throw new Error('invalid_log_policy')
  const { collection, fieldControls } = decodeStoredLogCollection(
    JSON.parse(row.collection), defaultLogCollection(), profiles, validateCollection, defaultFieldControls,
    (value, definitions) => validateCompleteFieldControls(value, definitions, validateFieldControlsPatch),
  )
  return {
    retentionDays: count(row.retentionDays), maxBytes: count(row.maxBytes), storageBytes: count(row.logical_bytes),
    pruned: count(row.pruned), cleared: count(row.cleared), revision: count(row.revision),
    collection, fieldControls, accounting,
  }
}

async function deleteOldest(client: PoolClient, where: string, values: (string | number)[], counter: 'pruned' | 'cleared') {
  const { rows } = await client.query<{ deleted: string; bytes: string }>(`
    WITH removed AS (
      DELETE FROM ${schema}.log_events
      WHERE seq IN (SELECT seq FROM ${schema}.log_events WHERE ${where} ORDER BY seq LIMIT ${LOG_DEFAULTS.clearBatchSize})
      RETURNING summary, detail
    ), totals AS (
      SELECT count(*) AS deleted, coalesce(sum(octet_length(summary)::bigint + octet_length(detail)), 0)::bigint AS bytes
      FROM removed
    )
    UPDATE ${schema}.log_policy p
    SET ${counter} = p.${counter} + totals.deleted, logical_bytes = p.logical_bytes - totals.bytes
    FROM totals WHERE p.id = 1 AND totals.deleted > 0
    RETURNING totals.deleted, totals.bytes
  `, values)
  return rows[0] ? { deleted: count(rows[0].deleted), bytes: count(rows[0].bytes) } : { deleted: 0, bytes: 0 }
}

async function maintain(client: PoolClient, now: number, retentionDays: number, limit: number, initialBytes: number) {
  const cutoff = new Date(now - retentionDays * dayMs).toISOString()
  let bytes = initialBytes - (await deleteOldest(client, 'timestamp < $1', [cutoff], 'pruned')).bytes
  for (let i = 0; i < 32 && bytes > limit; i++) {
    const removed = await deleteOldest(client, 'TRUE', [], 'pruned')
    if (!removed.deleted) break
    bytes -= removed.bytes
  }
  return bytes
}

export function createPostgresLogStorage(connectionString: string, maxEventBytes: number, timeoutMs: number, enableStdout: boolean) {
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
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN')
      // Take the writer lock in its own statement. A READ COMMITTED snapshot
      // taken before waiting for the lock could otherwise see an old joined
      // collection row alongside the new storage policy.
      if (!readOnly) await client.query(`SELECT id FROM ${schema}.log_policy WHERE id = 1 FOR UPDATE`)
      const policy = await readPolicy(client)
      const cutoff = new Date(now - policy.retentionDays * dayMs).toISOString()
      let result: unknown
      switch (action) {
        case 'policy': {
          if (!data) { result = policy; break }
          const patch = data as LogPolicyPatch
          const bytes = await maintain(client, now, patch.retentionDays, patch.maxBytes, policy.storageBytes)
          if (bytes > patch.maxBytes) { result = { transitionPending: true }; break }
          const collection = {
            sources: { ...policy.collection.sources, ...patch.collection?.sources },
            integrations: { ...policy.collection.integrations, ...patch.collection?.integrations },
          }
          const fieldControls = mergeFieldControls(policy.fieldControls, patch.fieldControls ?? {}, profiles)
          await client.query(`UPDATE ${schema}.log_policy SET "retentionDays" = $1, "maxBytes" = $2 WHERE id = 1`, [patch.retentionDays, patch.maxBytes])
          await client.query(`UPDATE ${schema}.log_collection SET collection = $1, revision = revision + 1 WHERE id = 1`, [
            JSON.stringify({ version: 2, collection, fieldControls }),
          ])
          result = await readPolicy(client)
          break
        }
        case 'maintain':
          await maintain(client, now, policy.retentionDays, policy.maxBytes, policy.storageBytes)
          result = null
          break
        case 'clear': {
          const filter = predicate(data as Filter)
          const { deleted } = await deleteOldest(client, filter.sql(), filter.values, 'cleared')
          const more = await client.query(`SELECT 1 FROM ${schema}.log_events WHERE ${filter.sql()} LIMIT 1`, filter.values)
          result = { deleted, hasMore: !!more.rowCount }
          break
        }
        case 'list': {
          await maintain(client, now, policy.retentionDays, policy.maxBytes, policy.storageBytes)
          const input = data as Filter
          const filter = predicate(input)
          filter.add('timestamp', '>=', cutoff)
          if (input.beforeSeq !== undefined) filter.add('seq', '<', input.beforeSeq)
          const { rows } = await client.query<{ seq: string; module: string | null; summary: string }>(`
            SELECT seq, module, summary FROM ${schema}.log_events
            WHERE ${filter.sql()} ORDER BY seq DESC LIMIT $${filter.values.length + 1}
          `, [...filter.values, input.limit + 1])
          const more = rows.length > input.limit
          if (more) rows.pop()
          result = {
            rows: rows.map(row => ({ ...JSON.parse(row.summary), module: row.module })),
            nextSeq: more ? count(rows.at(-1)!.seq) : null,
          }
          break
        }
        case 'detail': {
          const { rows } = await client.query<{ module: string | null; detail: string }>(`
            SELECT module, detail FROM ${schema}.log_events WHERE id = $1 AND timestamp >= $2
          `, [data, cutoff])
          const row = rows[0]
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
            const { auditId, receiptId, parentEventId, ...summary } = event
            return [{ event, detail, summary: JSON.stringify(summary) }]
          })
          const added = allowed.reduce((sum, row) => sum + Buffer.byteLength(row.summary) + Buffer.byteLength(row.detail), 0)
          const bytes = await maintain(client, now, policy.retentionDays, policy.maxBytes - added, policy.storageBytes)
          let stored = 0
          let code: string | undefined
          if (allowed.length && bytes + added <= policy.maxBytes) {
            await client.query('SAVEPOINT insert_logs')
            try {
              const values: (string | number | null)[] = []
              const tuples = allowed.map(({ event, summary, detail }) => {
                const row = [
                  event.id, event.timestamp, event.level, event.source, event.module ?? null, event.operation, event.outcome,
                  event.requestId ?? null, event.traceId ?? null, event.taskId ?? null, event.fileId ?? null,
                  event.batchId === undefined ? null : String(event.batchId),
                  event.resourceId === undefined ? null : String(event.resourceId), summary, detail,
                ]
                const placeholders = row.map((_, index) => '$' + (values.length + index + 1))
                values.push(...row)
                return '(' + placeholders.join(', ') + ')'
              })
              await client.query(`
                INSERT INTO ${schema}.log_events (id, timestamp, level, source, module, operation, outcome,
                  "requestId", "traceId", "taskId", "fileId", "batchId", "resourceId", summary, detail)
                VALUES ${tuples.join(', ')}
              `, values)
              await client.query(`UPDATE ${schema}.log_policy SET logical_bytes = logical_bytes + $1 WHERE id = 1`, [added])
              stored = allowed.length
            } catch (error) {
              await client.query('ROLLBACK TO SAVEPOINT insert_logs')
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
      await client.query('COMMIT')
      return result
    } catch (error) {
      if (client && !released && !signal.aborted) {
        try { await client.query('ROLLBACK') } catch { abort() }
      }
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
