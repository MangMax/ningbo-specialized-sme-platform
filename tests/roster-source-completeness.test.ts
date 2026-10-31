import { describe, it, expect } from 'vitest'
import { verifySourceCompleteness } from '../scripts/verify-roster-source-completeness.mjs'

function fixture(): any {
  const hash = 'a'.repeat(64)
  const facts = { eventType: 'review', year: 2021, batchSeq: null, decidedYear: 2024, reviewOutcome: 'passed', formalValidity: { evidenceId: 71, sourceSha256: hash, statementPages: [1], interval: { validFrom: '2024-01-01', validThrough: '2026-12-31' }, continuation: 'until_this_review_results' } }
  return { manifest: { sourceFile: 'synthetic.pdf', sourceSha256: hash, declaredRowCount: 1, rows: [{ eventId: 51, evidenceId: 71, attachment: '附件2', listNo: 1, page: 2, basis: '正文第1页结论及期限；附件第2页第1行', facts }] }, readbacks: [{ event: { id: 51, ...structuredClone(facts) }, evidence: [{ id: 71, sourceFile: 'synthetic.pdf', attachment: '附件2', listNo: 1, page: 2 }], files: [{ relPath: 'synthetic.pdf', sha256: hash }] }] }
}
const run = (f: any) => verifySourceCompleteness(f.manifest, f.readbacks)
describe('source fact completion gate', () => {
  it('accepts independently declared facts and reports legitimate unknowns', () => {
    expect(run(fixture())).toEqual({ ok: true, expectedRows: 1, checkedRows: 1, issues: [], unknown: [{ row: 0, field: 'batchSeq' }] })
  })
  it.each(['year', 'decidedYear', 'reviewOutcome', 'formalValidity'])('rejects missing known consumable %s despite source text', field => {
    const f = fixture(); f.readbacks[0].event[field] = null
    f.readbacks[0].event.notes = '复核通过，结论年2024，有效期至2026年12月31日'
    expect(run(f).issues).toContainEqual({ code: 'fact_mismatch', row: 0, field })
  })
  it('detects conclusion year copied into original year', () => {
    const f = fixture(); f.readbacks[0].event.year = 2024
    expect(run(f).issues).toContainEqual({ code: 'fact_mismatch', row: 0, field: 'year' })
  })
  it.each(['sourceFile', 'attachment', 'listNo', 'page'])('rejects wrong evidence %s', field => {
    const f = fixture(); f.readbacks[0].evidence[0][field] = null
    // sourceFile null is a malformed raw response rather than a valid coordinate.
    if (field === 'sourceFile') expect(() => run(f)).toThrow()
    else expect(run(f).issues).toContainEqual({ code: 'source_coordinate', row: 0, field })
  })
  it('rejects hash mismatch and missing event readback', () => {
    const f = fixture(); f.readbacks[0].files[0].sha256 = 'b'.repeat(64)
    expect(run(f).issues).toContainEqual({ code: 'source_hash', row: 0 })
    f.readbacks = []; expect(run(f).issues).toContainEqual({ code: 'missing_readback', row: 0 })
  })
  it('rejects omitted and duplicate file rows even with matching counts', () => {
    const f = fixture(); f.manifest.declaredRowCount = 2
    expect(run(f).issues.map(x => x.code)).toEqual(['manifest_count', 'file_coverage'])
    f.manifest.rows.push(structuredClone(f.manifest.rows[0]))
    f.readbacks[0].evidence.push(structuredClone(f.readbacks[0].evidence[0]))
    expect(run(f).issues.map(x => x.code)).toContain('duplicate_manifest_row')
    expect(run(f).issues.map(x => x.code)).toContain('file_coverage')
  })
  it('rejects unexpected source rows and repeated responses', () => {
    const f = fixture(); f.readbacks[0].evidence.push({ ...f.readbacks[0].evidence[0], id: 72 })
    expect(run(f).issues).toContainEqual({ code: 'file_coverage', row: null })
    f.readbacks.push(structuredClone(f.readbacks[0]))
    expect(run(f).issues).toContainEqual({ code: 'duplicate_readback', row: null })
  })
  it('requires explicit fact inventory and rejects invalid validity or binding', () => {
    const f = fixture(); delete f.manifest.rows[0].facts.reviewOutcome
    expect(() => run(f)).toThrow()
    const g = fixture(); g.manifest.rows[0].facts.formalValidity.evidenceId = 99
    expect(run(g).issues).toContainEqual({ code: 'validity_binding', row: 0 })
    g.manifest.rows[0].facts.formalValidity.interval.validThrough = '2023-01-01'
    expect(() => run(g)).toThrow()
  })
  it.each(['until_next_review_results', 'until_this_review_results'])('checks structured continuation %s without requiring origin award', continuation => {
    const f = fixture(); f.manifest.rows[0].facts.formalValidity = { evidenceId: 71, sourceSha256: 'a'.repeat(64), statementPages: [1], continuation }
    f.readbacks[0].event.formalValidity = structuredClone(f.manifest.rows[0].facts.formalValidity)
    expect(run(f).ok).toBe(true)
    f.readbacks[0].event.formalValidity.continuation = null
    expect(run(f).issues).toContainEqual({ code: 'fact_mismatch', row: 0, field: 'formalValidity' })
  })
})

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
it('CLI returns 0 for reconciled facts, 1 for missing known facts, 2 for malformed inputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'source-completeness-test-'))
  try {
    const f = fixture(), manifest = join(dir, 'manifest.json'), readback = join(dir, 'readback.json')
    writeFileSync(manifest, JSON.stringify(f.manifest)); writeFileSync(readback, JSON.stringify(f.readbacks))
    const cli = () => spawnSync(process.execPath, ['scripts/verify-roster-source-completeness.mjs', manifest, readback], { encoding: 'utf8' })
    expect(cli().status).toBe(0)
    f.readbacks[0].event.reviewOutcome = null
    writeFileSync(readback, JSON.stringify(f.readbacks))
    const missing = cli(); expect(missing.status).toBe(1)
    expect(JSON.parse(missing.stdout).issues).toContainEqual({ code: 'fact_mismatch', row: 0, field: 'reviewOutcome' })
    writeFileSync(manifest, '{}')
    const invalid = cli(); expect(invalid.status).toBe(2)
    expect(invalid.stderr).toContain('Invalid completeness inputs')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
