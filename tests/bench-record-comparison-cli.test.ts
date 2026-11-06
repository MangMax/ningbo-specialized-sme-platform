import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { initializeDb, schema } from '../db/client'

const root = fileURLToPath(new URL('..', import.meta.url))
const cleanup: string[] = []
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'bench-comparison-cli-'))
  cleanup.push(dir)
  return dir
}
function fixture() {
  const dir = directory(), path = join(dir, 'synthetic.db')
  const db = initializeDb({ dbPath: path, create: true, readOnly: false, migrationsFolder: join(root, 'db/migrations') })
  try {
    db.insert(schema.enterprise).values({ id: 1, name: 'Synthetic 581', nameNorm: 'Synthetic 581' }).run()
    db.insert(schema.sourceDocument).values({ id: 1, source: 'jxj', title: 'Synthetic declaration', path: 'synthetic-581.pdf' }).run()
    db.insert(schema.platformQuery).values({ id: 1, interface: 'business_list', queryKey: 'synthetic-581', queriedAt: '2026-10-18T00:00:00Z', status: 'partial' }).run()
  } finally { db.$client.close() }
  return { dir, path }
}
function run(path: string, mode: string, rounds: string, env: NodeJS.ProcessEnv = {}, nodeArgs: string[] = []) {
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PERF_') && !key.startsWith('NUXT_DB') && key !== 'NODE_OPTIONS'))
  const result = spawnSync(process.execPath, [...nodeArgs, join(root, 'scripts/bench-record-comparison.mjs'), path, mode, rounds], {
    cwd: root, env: { ...cleanEnv, ...env }, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024,
  })
  // Optional external raw receipts, never a source of expected results.
  if (process.env.ISSUE581_EVIDENCE_DIR) {
    const dir = mkdtempSync(join(process.env.ISSUE581_EVIDENCE_DIR, 'cli-'))
    writeFileSync(join(dir, 'stdout'), result.stdout ?? '')
    writeFileSync(join(dir, 'stderr'), result.stderr ?? '')
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify({ path, mode, rounds, env, nodeArgs, status: result.status, signal: result.signal, error: result.error?.message }))
  }
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  return result
}

it('rejects zero hot rounds on a real synthetic SQLite fixture', () => {
  const { path } = fixture()
  const result = run(path, 'comparison', '0')
  expect(result.status, result.stdout + result.stderr).toBe(1)
  expect(result.stderr).toContain('rounds must be a positive safe integer')
})

// PERF_SOURCE_ROOT is the existing process seam. These literal services prove
// CLI control flow only; they are not product-service or domain correctness tests.
function literalService(dir: string, changeAt: number) {
  mkdirSync(join(dir, 'server/utils'), { recursive: true })
  writeFileSync(join(dir, 'server/utils/record-comparison.ts'), `
let calls = 0
function result(db) {
  db.$client.prepare("SELECT 'abc' AS text, 7 AS count").get()
  return ++calls === ${changeAt} ? { rows: [{ id: 12 }], total: 1 } : { rows: [{ id: 11 }], total: 1 }
}
export const getRecordComparison = result
export const listRecordComparisonSources = result
`)
  return { PERF_SOURCE_ROOT: dir }
}

it.each([
  ['comparison', 2], ['comparison', 3], ['sources', 2], ['sources', 3],
] as const)('rejects literal drift in %s at call %i', (mode, changeAt) => {
  const { dir, path } = fixture()
  const result = run(path, mode, '2', literalService(dir, changeAt))
  expect(result.status, result.stdout + result.stderr).toBe(1)
  expect(result.stderr).toContain(`result drift at sample ${changeAt - 1}`)
  expect(result.stdout).not.toContain('"samples":')
})

const invalidRounds = [
  { name: 'zero', value: '0' }, { name: 'negative', value: '-1' },
  { name: 'not-a-number', value: 'NaN' }, { name: 'fractional', value: '1.5' },
  { name: 'infinity', value: 'Infinity' }, { name: 'unsafe-integer', value: '9007199254740992' },
]
// Native open trap is a process-control observation, not a real SQLite test.
function openTrap(dir: string) {
  const preload = join(dir, 'open-trap.cjs')
  writeFileSync(preload, `
require('node:module').registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/better-sqlite3/lib/index.js')) return {
      format: 'commonjs', shortCircuit: true,
      source: "module.exports = function() { throw Error('TEST_DB_OPEN_ATTEMPT') }",
    }
    return nextLoad(url, context)
  },
})
`)
  return ['--require', preload]
}
it.each(invalidRounds)('rejects $name before opening SQLite', ({ value }) => {
  const dir = directory(), path = join(dir, 'must-not-exist.db')
  const result = run(path, 'comparison', value, {}, openTrap(dir))
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('rounds must be a positive safe integer')
  expect(result.stderr).not.toContain('TEST_DB_OPEN_ATTEMPT')
  expect(() => readFileSync(path)).toThrow()
})
it('open trap detects the native DB boundary for valid rounds', () => {
  const dir = directory()
  const result = run(join(dir, 'must-not-exist.db'), 'comparison', '2', {}, openTrap(dir))
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('TEST_DB_OPEN_ATTEMPT')
})

function report(result: ReturnType<typeof run>) {
  expect(result.status, result.stderr).toBe(0)
  const line = result.stdout.split('\n').find(line => line.startsWith('{"mode":'))
  expect(line).toBeDefined()
  return JSON.parse(line!)
}
function twoHotSamples(output: ReturnType<typeof report>) {
  expect(output.samples.map((sample: { phase: string }) => sample.phase)).toEqual(['cold-process', 'hot', 'hot'])
  const [, first, second] = output.samples
  // For exactly two hot observations, nearest-rank p50 is the smaller and
  // p95/p99 the larger. The cold observation must not enter this population.
  expect(output.hot).toEqual({ p50: Math.min(first.ms, second.ms), p95: Math.max(first.ms, second.ms), p99: Math.max(first.ms, second.ms) })
}
it.each(['comparison', 'sources'])('keeps two hot rounds and literal SQL statistics in %s control flow', (mode) => {
  const { dir, path } = fixture()
  const output = report(run(path, mode, '2', literalService(dir, 0)))
  twoHotSamples(output)
  for (const sample of output.samples) {
    // Frozen digest of the literal UTF-8 {"rows":[{"id":11}],"total":1}.
    expect(sample).toMatchObject({ sqlCalls: 1, sqlRows: 1, sqlBytes: 11, responseBytes: 30, sha256: 'b761fb53ed8b430a07a7003268a9b03ce6d278e5ac339c90777c5e17df67a33e' })
  }
  expect(output.input).toEqual(mode === 'comparison'
    ? { queryIds: [1], exportBatchIds: [], officialSourceDocumentIds: [1], enterpriseId: 1, page: 1, pageSize: 25 }
    : { kind: 'query', page: 1, pageSize: 25 })
})
it.each(['comparison', 'sources'])('runs stable real SQLite services with two hot rounds in %s', (mode) => {
  const { path } = fixture()
  const before = readFileSync(path)
  const output = report(run(path, mode, '2'))
  twoHotSamples(output)
  expect(new Set(output.samples.map((sample: { sha256: string }) => sample.sha256)).size).toBe(1)
  for (const sample of output.samples) {
    expect(sample.sqlCalls).toBeGreaterThan(0)
    expect(sample.sqlRows).toBeGreaterThan(0)
    expect(sample.sqlBytes).toBeGreaterThan(0)
  }
  expect(readFileSync(path)).toEqual(before)
})
