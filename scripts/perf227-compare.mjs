#!/usr/bin/env node
// Compare two runs over the exact same frozen requests/snapshot; aggregates only.
// node scripts/perf227-compare.mjs BASELINE_RUN CANDIDATE_RUN NEW_REPORT.json
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const [baselineDir, candidateDir, target] = process.argv.slice(2)
assert.ok(!existsSync(target), 'preserve earlier comparison')
const read = (dir, name) => JSON.parse(readFileSync(join(dir, name), 'utf8'))
const lines = (dir, name) => readFileSync(join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
const baseManifest = read(baselineDir, 'manifest.json'), candidateManifest = read(candidateDir, 'manifest.json')
assert.equal(baseManifest.matrixSha256, candidateManifest.matrixSha256, 'request matrix changed')
assert.equal(baseManifest.snapshotSha256, candidateManifest.snapshotSha256, 'input data changed')
const key = row => `${row.cell}/c${row.concurrency}`
const baseLines = lines(baselineDir, 'results.ndjson'), candidateLines = lines(candidateDir, 'results.ndjson')
const base = new Map(baseLines.map(r => [key(r), r]))
const candidate = new Map(candidateLines.map(r => [key(r), r]))
assert.equal(baseLines.length, base.size, 'duplicate baseline cell receipts')
assert.equal(candidateLines.length, candidate.size, 'duplicate candidate cell receipts')
assert.deepEqual([...base.keys()].sort(), [...candidate.keys()].sort(), 'missing A/B cells')
const expectedKeys = read(baselineDir, 'matrix.json').cells.flatMap(c => [1, 2, 5].map(concurrency => key({ cell: c.name, concurrency }))).sort()
assert.deepEqual([...base.keys()].sort(), expectedKeys, 'matrix cell inventory incomplete')
assert.deepEqual(read(baselineDir, 'matrix.json'), read(candidateDir, 'matrix.json'), 'matrix contents differ')
const rawBase = lines(baselineDir, 'samples.ndjson'), rawCandidate = lines(candidateDir, 'samples.ndjson')
const percentile = (samples, p) => samples.map(s => s.ms).sort((a, b) => a - b)[Math.ceil(samples.length * p) - 1]
const validate = (dir, rows, raw) => {
  const failures = []
  for (const [cell, row] of rows) {
    const hot = raw.filter(s => key(s) === cell && s.label.startsWith('hot-'))
    const all = raw.filter(s => key(s) === cell)
    const request = read(dir, 'matrix.json').cells.find(c => c.name === row.cell)
    if (all.length !== (request.tool ? 23 : 22) || all.filter(s => s.label === 'fresh-process').length !== 1 || all.filter(s => s.label === 'warmup-excluded-from-hot').length !== 1 || all.filter(s => s.label === 'parity-excluded-from-hot').length !== (request.tool ? 1 : 0)) failures.push({ cell, reason: 'complete-request-inventory' })
    if (hot.length !== 20 || new Set(hot.map(s => s.label)).size !== 20) failures.push({ cell, reason: 'hot-sample-inventory' })
    if (all.find(s => s.label === 'fresh-process')?.canonicalSha256 !== row.first?.canonicalSha256 || hot.some(s => s.canonicalSha256 !== row.first?.canonicalSha256)) failures.push({ cell, reason: 'aggregate-differs-from-raw-response-hashes' })
    for (const p of [.5, .95, .99]) if (percentile(hot, p) !== row.hot?.['p' + p * 100]) failures.push({ cell, reason: 'percentile-recalculation', p })
    if (!row.stable || row.errors.length || row.parityEqual === false || hot.some(s => s.error)) failures.push({ cell, reason: 'recorded-request-or-parity-failure' })
    if (new Set(hot.map(s => s.canonicalSha256)).size !== 1) failures.push({ cell, reason: 'unstable-canonical-response' })
  }
  const summary = read(dir, 'summary.json')
  if (!summary.immutableUnchanged || !summary.artifactUnchanged) failures.push({ reason: 'snapshot-or-artifact-mutated' })
  return failures
}
const failures = [...validate(baselineDir, base, rawBase).map(r => ({ lane: 'baseline', ...r })), ...validate(candidateDir, candidate, rawCandidate).map(r => ({ lane: 'candidate', ...r }))]
const comparisons = []
for (const [cell, b] of base) {
  const c = candidate.get(cell)
  if (b.requestSha256 !== c.requestSha256) failures.push({ cell, reason: 'request-digest-differs' })
  const equal = b.first?.canonicalSha256 === c.first?.canonicalSha256 && b.first?.factsSha256 === c.first?.factsSha256
  if (!equal) failures.push({ cell, reason: 'business-response-differs' })
  const select = r => ({ firstMs: r.first?.ms, p50: r.hot?.p50, p95: r.hot?.p95, p99: r.hot?.p99, responseBytes: r.hot?.responseBytes, mainPeakHeap: r.hotTelemetry?.peakHeap, mainPeakRss: r.hotTelemetry?.peakRss, workerPeakHeap: r.hotTelemetry?.workerPeakHeap, workerPeakRss: r.hotTelemetry?.workerPeakRss, conservativeRss: (r.hotTelemetry?.peakRss ?? 0) + (r.hotTelemetry?.workerPeakRss ?? 0), mainLoopP95Ms: r.hotTelemetry?.loopP95Ms, mainLoopMaxMs: r.hotTelemetry?.loopMaxMs, firstLoopMaxMs: r.firstTelemetry?.loopMaxMs, errors: r.errors.length })
  comparisons.push({ cell, equal, baseline: select(b), candidate: select(c), candidateToBaselineP95: c.hot?.p95 / b.hot?.p95, responseSha256: b.first?.canonicalSha256 })
}
const result = { baselineSha: baseManifest.sourceSha, candidateSha: candidateManifest.sourceSha, snapshotSha256: baseManifest.snapshotSha256, matrixSha256: baseManifest.matrixSha256, cells: base.size, failures, status: failures.length ? 'FAIL' : 'PASS-semantic-and-inventory-checks-only', comparisons, limitations: '20 samples/cell; nearest-rank p99 equals maximum; descriptive shared-host observations, not population-tail, SLO, CI or production capacity proof' }
writeFileSync(target, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ cells: result.cells, failures: failures.length, status: result.status }))
if (failures.length) process.exitCode = 1
