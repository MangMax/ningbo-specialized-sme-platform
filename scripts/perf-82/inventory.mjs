// Re-runnable static coverage ledger. Locations are candidates, not proof that
// each lexical match executes. Manual disposition is in docs/performance/82.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
const files = execFileSync('git', ['ls-files', 'db', 'lib', 'server', 'scripts', 'composables', 'pages'], { encoding: 'utf8' }).trim().split('\n').filter(p => /\.(ts|mjs|vue)$/.test(p) && !p.includes('/perf-82/'))
const changedSinceBaseline = new Set(execFileSync('git', ['diff', '--name-only', 'd198a09f5a6fab2d5358d442d1b6ce47670c7506', '--', 'db', 'lib', 'server', 'scripts', 'composables', 'pages'], { encoding: 'utf8' }).trim().split('\n'))
const result = { sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  limits: 'Lexical coverage candidates, including comments. No dynamic completeness claim. Dispositions are conservative and backed by the human report; MCP shared-core inference is not transport measurement.', files: [] }
function ownership(path) {
  if (path === 'server/api/export.get.ts') return 'follow-up F82-05: record Excel workbook memory (parent #81)'
  if (['server/api/comparison.get.ts', 'lib/comparison-platform.ts', 'lib/curation.ts'].includes(path)) return 'follow-up F82-04: legacy comparison payload (parent #81)'
  if (path === 'server/api/jobs/index.get.ts' || path === 'server/utils/job-store.ts') return 'follow-up F82-01: bounded job history (parent #81)'
  if (path === 'server/api/platform/snapshots/diff.get.ts' || path === 'lib/platform-snapshots.ts') return 'follow-up F82-02: snapshot diff workload (parent #81)'
  if (/platform.*quer|platform\/quer|platform\/read/.test(path)) return '#83'
  if (/enterprise|recognition|roster\/differences|list_differences|mcp-roster|stats.get/.test(path)) return '#84'
  if (/record-comparison|comparison[_-]scope|list_record_comparison|preview_record_correspondence_impact/.test(path)) return '#86'
  if (/correspondence/.test(path)) return '#85'
  if (/schema|db\//.test(path)) return '#87'
  if (/Credential|credentials|credential-state|RetainedQuerySnapshot/.test(path)) return '#89'
  if (/query.ts|quality.get|records.get|comparison.get|comparison-platform|curation|lib\/comparison|lib\/reconcile/.test(path)) return 'follow-up: legacy-record-statistics (parent #81; separate scope decision)'
  return '#88 (triage; select narrow slice before implementation)'
}
function disposition(path) {
  if (changedSinceBaseline.has(path)) return 'changed/new since d198a09 baseline; current implementation requires remeasurement, do not reuse baseline hotspot label'
  if (['server/api/stats.get.ts', 'server/api/roster/recognitions.get.ts', 'server/api/roster/differences.get.ts', 'server/api/roster/export.get.ts', 'lib/roster/recognitions.ts'].includes(path)) return 'confirmed full-distribution OOM through shared roster snapshot; see report'
  if (path === 'server/api/export.get.ts') return 'confirmed concurrent workbook heap budget excess; F82-05'
  if (['server/api/comparison.get.ts', 'lib/comparison-platform.ts', 'lib/curation.ts'].includes(path)) return 'confirmed legacy payload amplification; F82-04; already partly enterprise-scoped'
  if (['server/api/platform/queries.get.ts', 'lib/platform/read.ts', 'server/api/roster/enterprises.get.ts', 'server/api/roster/enterprises/[id].get.ts', 'lib/roster/enterprise-roster.ts', 'server/utils/record-comparison.ts', 'server/api/roster/record-comparison.get.ts', 'server/api/roster/record-comparison/sources.get.ts'].includes(path)) return 'confirmed hotspot: measured on isolated full distribution; see report'
  if (['server/utils/record-correspondence-read.ts', 'server/utils/record-correspondence-candidates.ts'].includes(path)) return 'bounded in measured sample; broader fan-out/long-history pending'
  if (path === 'server/api/jobs/index.get.ts' || path === 'server/utils/job-store.ts') return 'confirmed payload hotspot: 12.45MB list response; independent follow-up F82-01'
  if (path === 'server/api/platform/snapshots/diff.get.ts' || path === 'lib/platform-snapshots.ts') return 'measured full diff: 17.3MB SQL payload and concurrency event-loop pressure; follow-up F82-02'
  if (['server/api/ocr-results/index.get.ts', 'server/api/ocr-results/markdown.get.ts', 'server/utils/ocr-files.ts', 'server/utils/mcp-files.ts'].includes(path)) return 'cold readonly fixture backfill failure, warm successful; readiness failure publication follow-up F82-03; external OCR pending'
  if (['server/api/records.get.ts', 'server/api/quality.get.ts', 'server/api/files/index.get.ts', 'server/api/platform/snapshots.get.ts'].includes(path)) return 'bounded in full-distribution measured sample; see counts/limits in report'
  if (/^server\/mcp\//.test(path)) return 'pending per-tool transport measurement; shared core inspected, list_platform_queries transport measured separately'
  return 'pending measured disposition; static coverage only unless explicitly listed in report'
}
function budgetClass(path, entry) {
  if (!entry) return 'internal: inherit caller budget; no independent endpoint SLO'
  if (/preflight/.test(path)) return 'preflight: p95 3s/p99 6s; <=300 rows, heap delta<=256MiB'
  if (/commit|save_roster_batch|replay|save_record_correspondences/.test(path)) return 'commit: p95 5s/p99 10s; <=300 rows, heap delta<=256MiB'
  if (/record-comparison|record_comparison|candidates|correspondence_impact|snapshots\/diff/.test(path)) return 'comparison: p95 2s/p99 4s for <=100 records; larger full scope uses full-processing budget'
  if (/export|render|ocr.*post|parse_result|query_platform|query.post/.test(path)) return 'full processing: <=60s/10k rows, working heap<=256MiB; external service/transfer time unfrozen and unverified'
  if (/\[id\]|get_|reveal|credentials.*(patch|delete)/.test(path)) return 'ID/metadata: p95 750ms/p99 1.5s, heap delta<=64MiB; explicit raw<=2x body+64MiB'
  return 'list/metadata: p95 500ms/p99 1s, <=256KiB response, heap delta<=64MiB; nominal page<=50'
}
for (const path of files) {
  const source = readFileSync(path, 'utf8')
  const sites = []
  source.split('\n').forEach((line, i) => {
    const kinds = []
    if (/\.(select|insert|update|delete)\(/.test(line)) kinds.push('orm')
    if (/\.prepare\(|\.exec\(|sql`|sql</.test(line)) kinds.push('native-sql-or-fragment')
    if (/\.transaction\(|\.pragma\(|new Database/.test(line)) kinds.push('database-lifecycle-or-transaction')
    if (/JSON\.(parse|stringify)/.test(line)) kinds.push('json')
    if (/readFile|writeFile|createReadStream|sendStream|writeBuffer|loadDocument/.test(line)) kinds.push('files-or-buffer')
    if (/\bcache\b|cached|Cache|new Map|no-store|max-age|filesReady|backfilled|inflight/.test(line)) kinds.push('cache-or-map-candidate')
    if (kinds.length) sites.push({ line: i + 1, kinds })
  })
  const entry = path.startsWith('server/api/') ? 'REST' : path.startsWith('server/mcp/tools/') ? 'MCP tool' : path.startsWith('server/mcp/resources/') ? 'MCP resource' : null
  if (sites.length || entry) result.files.push({ path, entry, owner: ownership(path), disposition: disposition(path), budgetClass: budgetClass(path, entry), imports: [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]), sites })
}
const output = process.argv[2]
if (!output) throw new Error('Usage: node inventory.mjs OUTPUT_JSON')
writeFileSync(output, `{"sourceHead":${JSON.stringify(result.sourceHead)},"limits":${JSON.stringify(result.limits)},"files":[\n${result.files.map(x => JSON.stringify(x)).join(',\n')}\n]}\n`)
console.log(JSON.stringify({ files: result.files.length, rest: result.files.filter(x => x.entry === 'REST').length, mcpTools: result.files.filter(x => x.entry === 'MCP tool').length, sites: result.files.reduce((n, x) => n + x.sites.length, 0) }))
