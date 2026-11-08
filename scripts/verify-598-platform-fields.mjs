/** Read an external frozen raw manifest and independent literal expectations.
 * Run only against a disposable loopback server with an isolated SQLite DB.
 * Usage: NUXT_API_TOKEN=<isolated-token> node scripts/verify-598-platform-fields.mjs <base> <source.json> <expected.json> <receipt.json>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const [base, sourcePath, expectedPath, outputPath] = process.argv.slice(2)
const url = new URL(base)
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Isolated loopback server required')
assert(process.env.NUXT_API_TOKEN, 'An isolated server token is required')
const source = JSON.parse(readFileSync(sourcePath, 'utf8'))
const expected = JSON.parse(readFileSync(expectedPath, 'utf8'))
assert.equal(source.samples.length, 15, 'Five controlled enterprises across three sources required')
assert.equal(new Set(source.samples.map(row => `${row.search}/${row.interface}`)).size, 15)
const paths = { apply_list: 'declarations', business_list: 'business-processes', recognized_list: 'recognized-directory' }
const queries = source.samples.map(sample => {
  const raw = JSON.parse(sample.rawFields)
  const query = { interface: sample.interface, queryKey: `598:${sample.search}:${sample.interface}`, rdjb: sample.rdjb, queriedAt: sample.queriedAt, status: 'success', relations: [{ sequenceNo: 1, relationKey: sample.relationKey, nameRaw: raw.qymc ?? null, usccRaw: raw.tyshxydm ?? null, rawFields: raw }] }
  if (sample.interface === 'recognized_list') {
    // This is a controlled replay envelope, not a new vendor collection receipt.
    query.rdjb = raw.rdjb
    query.titleCode = { 1: 'innovative_sme', 2: 'specialized_sme', 3: 'little_giant' }[raw.rdjb]
    query.collectionEvidence = { source: 'queryBusList', status: 'success', effectiveConditions: { combination: 'and' }, titleScope: { mode: 'selected', rdjb: [raw.rdjb] }, queriedAt: sample.queriedAt, completedAt: sample.queriedAt, rows: [raw], fetchedCount: 1, declaredTotal: 1, pages: [{ source: 'queryBusList', rdjb: raw.rdjb, page: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, maxPage: 1, error: null }], completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { pageSize: 50, maxRequests: 100, maxRows: 5000, maxDurationMs: 60000 } }
  }
  return query
})
const maintenance = process.env.ACCEPTANCE_598_RELATIONS
const payload = maintenance ? { platformRecordObservations: JSON.parse(readFileSync(maintenance, 'utf8')) } : { platformQueries: queries }
const request = { idempotencyKey: process.env.ACCEPTANCE_598_KEY ?? '598-real-controlled-replay-v1', sourceKind: 'platform_archive', sourceIdentity: '598/read-only-extracted-controlled-replay', payload }
const post = async action => {
  const response = await fetch(`${base}/api/roster/import/${action}`, { method: 'POST', headers: { authorization: `Bearer ${process.env.NUXT_API_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(request) })
  assert.equal(response.status, 200)
  return response.json()
}
const preflight = await post('preflight')
assert.deepEqual(preflight.preflight.conflicts, [])
const receipt = await post('commit')
assert.equal(receipt.status, 'committed')
assert.deepEqual(await post('commit'), receipt, 'Same-key retry must return the original receipt')
if (!maintenance) {
  assert.equal(receipt.summary.platformFields.status, 'ready')
  assert.equal(receipt.summary.platformFields.eligibleVersions, 15)
}
const readbacks = []
for (const sample of source.samples) {
  const response = await fetch(`${base}/api/platform/${paths[sample.interface]}?platformKey=${encodeURIComponent(sample.relationKey)}`)
  assert.equal(response.status, 200)
  const data = await response.json()
  assert.equal(data.total, 1)
  const literal = expected[`${sample.search}/${sample.interface}`]
  assert(literal && Object.keys(literal).length >= 3, 'Independent expected fields required')
  for (const [field, value] of Object.entries(literal)) assert.deepEqual(data.rows[0].matchedVersion[field], value, `${sample.search}/${sample.interface}/${field}`)
  const detail = await (await fetch(`${base}/api/platform/${paths[sample.interface]}/${data.rows[0].record.id}`)).json()
  for (const [field, value] of Object.entries(literal)) assert.deepEqual(detail.versions[0][field], value)
  readbacks.push({ search: sample.search, interface: sample.interface, originalRelationId: sample.relationId, originalVersionId: sample.versionId, originalHash: sample.contentHash, row: data.rows[0], detail })
}
writeFileSync(outputPath, JSON.stringify({ source: source.source, capturedAt: source.capturedAt, preflight, receipt, readbacks }, null, 2))
console.log('PASS: 15 source records, three public lists and exact-version details; isolated replay only')
