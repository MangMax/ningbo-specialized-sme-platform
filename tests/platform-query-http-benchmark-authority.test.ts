import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { validateCurrentResponse, currentRequest, currentOptions, verifyCurrentInputs } from '../scripts/bench-platform-query-http.mjs'

const doc = JSON.parse(readFileSync(new URL('../scripts/fixtures/platform-query-current-authority.json', import.meta.url), 'utf8'))
// Captured-shape driver fixtures, not runtime receipts. Only frozen projection is synthesized.
function payload(s: any) {
  const e = structuredClone(s.expected)
  if (e.rows) for (const row of e.rows) {
    row.relations = row.relationIds.map((id: number) => ({ id }))
    const query = { ...row }; delete query.relations; delete query.relationsIncluded
    delete query.relationIds; delete query.omittedQueryFields; delete query.rawHex
    for (const key of Object.keys(row)) if (!['relations', 'relationsIncluded'].includes(key)) delete row[key]
    row.query = query
  }
  delete e.decodedHex
  return e
}
function envelope(s: any, body: any, id = 7) {
  return s.transport === 'http' ? JSON.stringify(body) : JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(body) }] } })
}
function check(s: any, body: any, text = envelope(s, body), sent = currentRequest(s, 7)) {
  return validateCurrentResponse(s, sent, { status: 200, text, redirected: false, url: `http://127.0.0.1${s.request.path}${s.transport === 'http' ? '?' + new URLSearchParams(s.request.query) : ''}` }, 7)
}
for (const transport of ['http', 'mcp']) {
  const scenario = (mode: string) => doc.scenarios.find((s: any) => s.transport === transport && s.mode === mode)
  for (const mode of ['full', 'summary', 'interface', 'title', 'key', 'chunk']) it(`${transport} accepts frozen ${mode} projection`, () => {
    const s = scenario(mode); expect(check(s, payload(s))).toMatch(/^[a-f0-9]{64}$/)
  })
  it(`${transport} rejects wrong query IDs in five-row fixture`, () => {
    const s = scenario('full'), b = payload(s); b.rows[4].query.id = 99
    expect(() => check(s, b)).toThrow(/rows\[4\].id/)
  })
  it(`${transport} rejects empty chunk bytes despite correct declared length`, () => {
    const s = scenario('chunk'), b = payload(s); b.data = ''
    expect(() => check(s, b)).toThrow(/chunk.data/)
  })
  for (const field of ['rawResponse', 'collectionEvidence', 'relations']) it(`${transport} rejects nonfirst summary ${field} leak`, () => {
    const s = scenario('summary'), b = payload(s); (field === 'relations' ? b.rows[1] : b.rows[1].query)[field] = field === 'relations' ? [{ id: 103 }] : ''
    expect(() => check(s, b)).toThrow(field === 'relations' ? /relationIds/ : /omitted/)
  })
  it(`${transport} rejects warmup-only drift independently of cold and hot`, () => {
    const s = scenario('full')
    const run = () => { for (const phase of ['cold', 'warmup', ...Array(20).fill('hot')]) {
      const b = payload(s); if (phase === 'warmup') b.total = 99
      check(s, b)
    } }
    expect(run).toThrow(/total/)
  })
  it(`${transport} binds actual outgoing request and status`, () => {
    const s = scenario('full'), sent = currentRequest(s, 7); sent.path = '/wrong'
    expect(() => check(s, payload(s), envelope(s, payload(s)), sent)).toThrow(/request/)
    expect(() => validateCurrentResponse(s, currentRequest(s, 7), { status: 500, text: envelope(s, payload(s)) }, 7)).toThrow(/status/)
  })
}
for (const [label, mutate, error] of [
  ['wrong id', (b: any) => { b.id = 8 }, /rpc.id/],
  ['isError', (b: any) => { b.result.isError = true }, /rpc.isError/],
  ['error', (b: any) => { b.error = { code: -1 } }, /rpc.error/],
  ['version', (b: any) => { b.jsonrpc = '1.0' }, /rpc.jsonrpc/],
] as const) it(`mcp rejects ${label}`, () => {
  const s = doc.scenarios.find((s: any) => s.id === 'mcp-full'), b = JSON.parse(envelope(s, payload(s))); mutate(b)
  expect(() => check(s, payload(s), JSON.stringify(b))).toThrow(error)
})
it('mcp parses a complete SSE event and rejects multiple RPC responses', () => {
  const s = doc.scenarios.find((s: any) => s.id === 'mcp-full'), text = `event: message\r\ndata: ${envelope(s, payload(s))}\r\n\r\n`
  expect(check(s, payload(s), text)).toMatch(/^[a-f0-9]{64}$/)
  expect(() => check(s, payload(s), text + text)).toThrow(/rpc envelope count/)
})
it('current lane refuses unfrozen scheduling and missing explicit inputs', () => {
  for (const opts of [{ concurrency: 2 }, { samples: 19 }, { postvalidation: true }, {}]) {
    expect(() => currentOptions(opts)).toThrow(/REJECTED current-read/)
  }
})

for (const transport of ['http', 'mcp']) {
  const s = doc.scenarios.find((s: any) => s.id === `${transport}-key`)
  for (const [label, mutate, error] of [
    ['order', (b: any) => { b.rows.reverse() }, /rows\[0\].id/],
    ['count', (b: any) => { b.counts.success = 2 }, /counts/],
    ['relation count', (b: any) => { b.rows[0].query.relationCount = 3 }, /relationCount/],
    ['relation IDs', (b: any) => { b.rows[0].relations.reverse() }, /relationIds/],
    ['raw normalization', (b: any) => { b.rows[0].query.rawResponse = b.rows[0].query.rawResponse.normalize('NFC') }, /rawResponse/],
    ['collection evidence', (b: any) => { b.rows[0].query.collectionEvidence = null }, /collectionEvidence/],
  ] as const) it(`${transport} rejects changed ${label} projection`, () => {
    const selected = label === 'order' ? doc.scenarios.find((s: any) => s.id === `${transport}-full`) : s
    const b = payload(selected); mutate(b)
    expect(() => check(selected, b)).toThrow(error)
  })
  const chunk = doc.scenarios.find((s: any) => s.id === `${transport}-chunk`)
  for (const field of ['queryId', 'field', 'encoding', 'offset', 'byteLength', 'totalBytes', 'isNull', 'hasMore']) it(`${transport} rejects changed chunk ${field}`, () => {
    const b = payload(chunk); b[field] = typeof b[field] === 'boolean' ? !b[field] : typeof b[field] === 'number' ? b[field] + 1 : 'wrong'
    expect(() => check(chunk, b)).toThrow(`chunk.${field}`)
  })
}
it('current lane accepts only explicit frozen scheduling inputs', () => {
  const paths = Object.fromEntries(['artifactPath', 'envelopePath', 'workloadPath', 'fixturePath', 'deliveryDir', 'outputDir'].map(k => [k, '/supplied']))
  expect(currentOptions({ ...paths, concurrency: 1, samples: 20, postvalidation: false })).toMatchObject({ samples: 20 })
  for (const field of Object.keys(paths)) expect(() => currentOptions({ ...paths, [field]: undefined, concurrency: 1, samples: 20, postvalidation: false })).toThrow(`explicit ${field}`)
})

it('rejects changed fixture bytes before opening any external artifact or DB', () => {
  const dir = mkdtempSync(join(tmpdir(), '622-input-test-'))
  try {
    const file = join(dir, 'fixture.json'); const changed = structuredClone(doc)
    changed.scenarios[0].expected.rows[0].id = 99
    writeFileSync(file, JSON.stringify(changed))
    const opts = Object.fromEntries(['artifactPath', 'envelopePath', 'workloadPath', 'fixturePath', 'deliveryDir', 'outputDir'].map(k => [k, '/must-not-read']))
    expect(() => verifyCurrentInputs({ ...opts, fixturePath: file, concurrency: 1, samples: 20, postvalidation: false }, '/must-not-open', 'http', 'full')).toThrow(/fixture document bytes/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

for (const transport of ['http', 'mcp']) it(`${transport} rejects redirected or mismatched response URL`, () => {
  const s = doc.scenarios.find((s: any) => s.id === `${transport}-full`), sent = currentRequest(s, 7)
  const text = envelope(s, payload(s))
  expect(() => validateCurrentResponse(s, sent, {status: 200, text, redirected: true, url: 'http://127.0.0.1/wrong'}, 7)).toThrow(/response redirect/)
  expect(() => validateCurrentResponse(s, sent, {status: 200, text, redirected: false, url: 'http://127.0.0.1/wrong'}, 7)).toThrow(/response path/)
  expect(() => validateCurrentResponse(s, sent, {status: 200, text, redirected: false, url: `http://127.0.0.1${s.request.path}?wrong=1`}, 7)).toThrow(/response query/)
})
