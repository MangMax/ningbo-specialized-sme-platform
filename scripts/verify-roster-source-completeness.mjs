import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'

const positive = z.number().int().positive()
const year = z.number().int().min(1900).max(9999).nullable()
const sha = z.string().regex(/^[a-f0-9]{64}$/)
const validity = z.strictObject({
  evidenceId: positive, sourceSha256: sha, statementPages: z.array(positive).min(1),
  publishedOn: z.iso.date().optional(), originAwardEventId: positive.optional(),
  interval: z.strictObject({ validFrom: z.iso.date(), validThrough: z.iso.date() })
    .refine(v => v.validFrom <= v.validThrough).optional(),
  continuation: z.enum(['until_next_review_results', 'until_this_review_results']).optional(),
}).refine(v => v.interval !== undefined || v.continuation !== undefined)
const facts = z.strictObject({
  eventType: z.enum(['award', 'review', 'nurture']), year,
  batchSeq: positive.nullable(), decidedYear: year,
  reviewOutcome: z.enum(['passed', 'failed']).nullable(), formalValidity: validity.nullable(),
})
const manifestSchema = z.strictObject({
  sourceFile: z.string().min(1), sourceSha256: sha, declaredRowCount: positive,
  rows: z.array(z.strictObject({
    eventId: positive, evidenceId: positive, attachment: z.string().nullable(),
    listNo: positive.nullable(), page: positive,
    basis: z.string().trim().min(1), facts,
  })).min(1),
})

/** Offline only. Readbacks are unmodified GET /api/roster/events/{id} response bodies. */
export function verifySourceCompleteness(manifest, readbacks) {
  const source = manifestSchema.parse(manifest)
  const responses = z.array(z.object({
    event: z.object({ id: positive }).passthrough(),
    evidence: z.array(z.object({ id: positive, sourceFile: z.string() }).passthrough()),
    files: z.array(z.object({ relPath: z.string(), sha256: z.string().nullable() }).passthrough()),
  }).passthrough()).parse(readbacks)
  const issues = []
  const add = (code, row, field) => issues.push({ code, row, ...(field ? { field } : {}) })
  if (source.rows.length !== source.declaredRowCount) add('manifest_count', null)
  const seen = new Set()
  const events = new Map()
  for (const response of responses) {
    if (events.has(response.event.id)) add('duplicate_readback', null)
    events.set(response.event.id, response)
  }
  for (const [i, row] of source.rows.entries()) {
    if (seen.has(row.evidenceId)) add('duplicate_manifest_row', i)
    seen.add(row.evidenceId)
    const response = events.get(row.eventId)
    if (!response) { add('missing_readback', i); continue }
    const matches = response.evidence.filter(e => e.id === row.evidenceId)
    if (matches.length !== 1) add('evidence_identity', i)
    const evidence = matches[0]
    for (const field of ['sourceFile', 'attachment', 'listNo', 'page']) {
      const expected = field === 'sourceFile' ? source.sourceFile : row[field]
      if (!isDeepStrictEqual(evidence?.[field], expected)) add('source_coordinate', i, field)
    }
    const files = response.files.filter(f => f.relPath === source.sourceFile)
    if (files.length !== 1 || files[0]?.sha256 !== source.sourceSha256) add('source_hash', i)
    for (const [field, expected] of Object.entries(row.facts)) {
      // Unknown source facts impose no invented value; always report them below.
      if (expected === null) continue
      const actual = response.event[field]
      // Optional validity facts outside this source manifest may already have
      // been independently verified. Compare only the declared known facts.
      const matches = field === 'formalValidity' && actual && typeof actual === 'object'
        ? Object.entries(expected).every(([key, value]) => isDeepStrictEqual(actual[key], value))
        : isDeepStrictEqual(actual, expected)
      if (!matches) add('fact_mismatch', i, field)
    }
    const v = row.facts.formalValidity
    if (v && (v.evidenceId !== row.evidenceId || v.sourceSha256 !== source.sourceSha256)) add('validity_binding', i)
  }
  const actual = responses.flatMap(r => r.evidence.filter(e => e.sourceFile === source.sourceFile).map(e => e.id))
  if (actual.length !== source.declaredRowCount || new Set(actual).size !== actual.length || actual.some(id => !seen.has(id))) add('file_coverage', null)
  const unknown = source.rows.flatMap((r, i) => Object.entries(r.facts).filter(([, v]) => v === null).map(([field]) => ({ row: i, field })))
  return { ok: issues.length === 0, expectedRows: source.declaredRowCount, checkedRows: source.rows.length, issues, unknown }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node scripts/verify-roster-source-completeness.mjs manifest.json readbacks.json')
    const result = verifySourceCompleteness(...process.argv.slice(2).map(p => JSON.parse(readFileSync(p, 'utf8'))))
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.ok ? 0 : 1
  } catch {
    // Avoid echoing raw source data or credentials on malformed input.
    console.error('Invalid completeness inputs; use the documented manifest and raw event readback shapes.')
    process.exitCode = 2
  }
}
