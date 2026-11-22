import { spawn, execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import Database from 'better-sqlite3'

const [snapshot, schemaName, mode, ...extra] = process.argv.slice(2)
const verifyOnly = mode === '--verify-only'
const resume = mode === '--resume'
if (!snapshot || !/^[a-z][a-z0-9_]{0,62}$/.test(schemaName ?? '') || (mode && !verifyOnly && !resume) || extra.length) {
  throw new Error('Usage: node upgrade/postgresql/stage-sqlite.mjs OFFLINE_SQLITE_SNAPSHOT STAGING_SCHEMA [--verify-only|--resume]')
}
if (!process.env.PGHOST || !process.env.PGDATABASE) throw new Error('Set PGHOST and PGDATABASE for the isolated PostgreSQL target')

const ordinal = '_sqlite_copy_order'
const sqlName = name => '"' + name.replaceAll('"', '""') + '"'
const sqlText = value => "'" + value.replaceAll("'", "''") + "'"
const schema = sqlName(schemaName)
const bin = process.env.PGSQL_BIN
const psql = bin && statSync(bin, { throwIfNoEntry: false })?.isDirectory() ? join(bin, 'psql') : bin ?? 'psql'
const psqlArgs = ['-X', '-w', '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=terse']
const copyHeader = Buffer.from('5047434f50590aff0d0a000000000000000000', 'hex')
const copyEnd = Buffer.from([255, 255])
const nullLength = Buffer.from([255, 255, 255, 255])
// SQLite's exact evidence cells can hold raw text, binary or numeric values.
const officialRawColumns = new Set(['name_raw', 'uscc_raw', 'district_raw'])
const exactCells = new Set([
  'platform_collection_condition.witness_value',
  'platform_business_observation.witness_rdjb_value',
  'platform_business_observation.witness_page_value',
  'platform_apply_projection.exact_status',
  'platform_apply_projection.exact_declare_kind',
  'platform_apply_projection.exact_applied_at',
  'platform_apply_projection.exact_year',
  'platform_apply_projection.exact_title_raw',
  'platform_business_projection.exact_status',
  'platform_business_projection.exact_declare_kind',
  'platform_business_projection.exact_applied_at',
  'platform_business_projection.exact_year',
  'platform_business_projection.exact_title_raw',
  'platform_business_projection.exact_batch',
  'platform_business_projection.exact_award_batch_label',
  'platform_business_projection.exact_province',
  'platform_recognized_projection.exact_title_raw',
  'platform_recognized_projection.source_valid_flag',
  'platform_business_projection.stored_status',
  'platform_business_projection.reconciled_status',
])
const toBigEndian = number => {
  const result = Buffer.allocUnsafe(8)
  result.writeBigInt64BE(number)
  return result
}

function query(sql) {
  return execFileSync(psql, [...psqlArgs, '-A', '-t', '-c', sql], { encoding: 'utf8' }).trim()
}

function postgresType(table, column) {
  if (table === 'sqlite_sequence') {
    if (column.name === 'name') return 'text'
    if (column.name === 'seq') return 'bigint'
  }
  const declaration = column.type.toUpperCase()
  if (declaration === 'INTEGER' || declaration === 'SERIAL' || declaration === 'NUMERIC') return 'bigint'
  if (declaration === 'TEXT') return 'text'
  if (declaration === 'BLOB') return 'bytea'
  if (declaration === 'REAL') return 'double precision'
  throw new Error(`Unsupported declared type at ${table}.${column.name}: ${declaration}`)
}

function fieldBytes(table, column, sqliteType, value) {
  if (sqliteType === 'null') return null
  // Keep NUL-bearing captured raw strings representable in PostgreSQL.
  if (table === 'official_evidence_row_revision' && officialRawColumns.has(column.name) && sqliteType === 'text') {
    const text = value.toString('utf8')
    if (Buffer.from(text).equals(value)) return Buffer.from(JSON.stringify(text))
    throw new Error(`Invalid UTF-8 in SQLite text at ${table}.${column.name}`)
  }
  if ((column.exact || column.target === 'bigint') && sqliteType === 'integer') return toBigEndian(value)
  if (column.target === 'text' && sqliteType === 'text' && !value.includes(0)) return value
  if ((column.target === 'bytea' && sqliteType === 'blob') || (column.exact && sqliteType === 'text')) return value
  if ((column.exact || column.target === 'double precision') && sqliteType === 'real') {
    const result = Buffer.allocUnsafe(8)
    result.writeDoubleBE(value)
    return result
  }
  throw new Error(`Incompatible SQLite value at ${table}.${column.name}: ${sqliteType} cannot be copied to ${column.target}`)
}

function fieldLength(bytes) {
  if (bytes === null) return nullLength
  const result = Buffer.allocUnsafe(4)
  result.writeInt32BE(bytes.length)
  return result
}

function* binaryRows(table, columns, statement, metrics) {
  yield copyHeader
  for (const row of statement.iterate()) {
    const values = [toBigEndian(++metrics.rows)]
    for (let index = 0; index < columns.length; index++) {
      const column = columns[index]
      const sqliteType = row[2 * index]
      values.push(fieldBytes(table, column, sqliteType, row[2 * index + 1]))
      if (column.exact) values.push(Buffer.from(sqliteType))
    }
    const header = Buffer.allocUnsafe(2)
    header.writeInt16BE(values.length)
    const chunks = [header]
    let size = header.length
    for (const value of values) {
      chunks.push(fieldLength(value))
      size += 4
      if (value !== null) {
        chunks.push(value)
        size += value.length
      }
    }
    if (size < 64 * 1024) yield Buffer.concat(chunks, size)
    else yield* chunks
  }
  yield copyEnd
}

function waitForProcess(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`psql exited with ${code ?? signal}`))
    })
  })
}

async function copyTable(db, table) {
  const mixedSequence = table === 'sqlite_sequence'
    && db.prepare("SELECT 1 FROM sqlite_sequence WHERE typeof(seq) NOT IN ('integer','null') LIMIT 1").get()
  const columns = db.prepare('SELECT name,type,hidden FROM pragma_table_xinfo(?) ORDER BY cid').all(table).map(column => {
    const exact = exactCells.has(`${table}.${column.name}`) || Boolean(mixedSequence && column.name === 'seq')
    return { ...column, exact, target: exact ? 'bytea' : postgresType(table, column) }
  })
  const fields = [[ordinal, 'bigint NOT NULL'], ...columns.flatMap(column => [
    [column.name, column.target],
    ...(column.exact ? [[`${column.name}_sqlite_storage`, 'text NOT NULL']] : []),
  ])]
  if (!columns.length || columns.some(column => column.hidden !== 0)
    || new Set(fields.map(([name]) => name)).size !== fields.length) {
    throw new Error(`Unexpected columns in ${table}`)
  }
  const tableName = sqlName(table)
  const target = `${schema}.${tableName}`
  const names = fields.map(([name]) => sqlName(name))
  const resultColumns = columns.flatMap(({ name }) => {
    const col = sqlName(name)
    return [`typeof(${col})`, `CASE WHEN typeof(${col})='text' THEN CAST(${col} AS BLOB) ELSE ${col} END`]
  })
  const statement = db.prepare(`SELECT ${resultColumns.join(', ')} FROM ${tableName} ORDER BY rowid`).raw(true).safeIntegers(true)
  const metrics = { rows: 0n }
  const sourceHash = createHash('sha256')
  const sourceChunks = (function* () {
    for (const chunk of binaryRows(table, columns, statement, metrics)) {
      sourceHash.update(chunk)
      yield chunk
    }
  })()
  const existing = verifyOnly || (resume && query(`SELECT to_regclass(${sqlText(target)}) IS NOT NULL`) === 't')
  const createTable = `CREATE TABLE ${target} (${fields.map(([name, type]) => `${sqlName(name)} ${type}`).join(', ')})`
  let copied = false

  try {
    if (existing) {
      for (const _chunk of sourceChunks) {  }
    } else {
      const copyIn = spawn(psql, [...psqlArgs, '--single-transaction', '-c', createTable, '-c', `COPY ${target} (${names.join(', ')}) FROM STDIN (FORMAT binary)`],
        { stdio: ['pipe', 'ignore', 'inherit'] })
      const transfer = pipeline(Readable.from(sourceChunks), copyIn.stdin).catch(error => {
        copyIn.kill()
        throw error
      })
      const results = await Promise.allSettled([transfer, waitForProcess(copyIn)])
      const failure = results.find(result => result.status === 'rejected')
      if (failure) throw failure.reason
      copied = true
    }

    const copyOut = spawn(psql, [...psqlArgs, '-c',
      `COPY (SELECT ${names.join(', ')} FROM ${target} ORDER BY ${names[0]}) TO STDOUT (FORMAT binary)`],
      { stdio: ['ignore', 'pipe', 'inherit'] })
    const targetHash = createHash('sha256')
    const reading = (async () => { for await (const chunk of copyOut.stdout) targetHash.update(chunk) })()
    await Promise.all([reading, waitForProcess(copyOut)])
    const digest = sourceHash.digest('hex')
    if (digest !== targetHash.digest('hex')) throw new Error(`Copy verification failed for ${table}`)
    return { table, rows: metrics.rows.toString(), sha256: digest }
  } catch (error) {
    if (copied) query(`DROP TABLE ${target}`)
    throw error
  }
}

const db = new Database(snapshot, { readonly: true, fileMustExist: true })
try {
  db.exec('BEGIN')
  if (db.pragma('encoding', { simple: true }) !== 'UTF-8' || query('SHOW server_encoding') !== 'UTF8') {
    throw new Error('SQLite and PostgreSQL must both use UTF-8')
  }
  const tables = db.prepare(`SELECT name FROM sqlite_schema
    WHERE type='table' AND name NOT IN ('sqlite_stat1','sqlite_stat4') ORDER BY name`).pluck().all()
  if (!tables.length) throw new Error('Source has no tables')
  const version = Number(query("SHOW server_version_num"))
  if (version < 190000 || version >= 200000) throw new Error('This staging tool requires PostgreSQL 19')
  if (!verifyOnly) query(`CREATE SCHEMA ${resume ? 'IF NOT EXISTS ' : ''}${schema}`)
  const verified = []
  for (const table of tables) {
    const result = await copyTable(db, table)
    verified.push(result)
    process.stderr.write(`${result.table}: ${result.rows} rows verified\n`)
  }
  console.log(JSON.stringify({ schema: schemaName, postgresVersion: version, tables: verified }, null, 2))
} finally {
  db.close()
}
