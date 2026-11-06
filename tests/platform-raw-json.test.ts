import { expect, it } from 'vitest'
import { parsePlatformPage } from '../lib/platform/adapter'
import { runPlatformLiveQuery } from '../server/utils/platform-live-query'

const row = JSON.parse('{"id":"same","x":null,"n":1,"b":true,"o":{"a":1},"a":[null,2,{"x":false}],"__proto__":{"kept":true},"constructor":"own","unknown":"🙂"}')
function body(rows: unknown[], extra = '') {
  return ` ${JSON.stringify({ zrarData: { grid: { businessGrid: { page: 1, pageSize: 1, maxCount: rows.length, maxPage: 1, pageSet: rows } } } })}${extra}`
}
const query = { source: 'queryBusList', name: '合成', rdjb: ['2'], pageSize: 1, rawDataVersion: 1 }
const context = (raw: string, maxResultBytes?: number) => ({ cookie: 'sid=synthetic-raw-json-secret', maxResultBytes, transport: { fetchImpl: async () => ({ ok: true, status: 200, text: async () => raw }) } })
it('page parser retains types missing keys arrays unknown and prototype-named own keys separately from legacy strings', () => {
  const parsed = parsePlatformPage(body([row]), 'businessGrid')
  expect(parsed.rawRows).toEqual([row])
  expect(Object.hasOwn(parsed.rawRows[0]!, '__proto__')).toBe(true)
  expect(Object.hasOwn(parsed.rawRows[0]!, 'missing')).toBe(false)
  expect(parsed.rows[0]).toMatchObject({ x: '', n: '1', b: 'true', o: '{"a":1}' })
  const second = parsePlatformPage(body([{ id: 'same', x: '', n: '1', b: 'true', o: '{"a":1}' }]), 'businessGrid')
  expect(parsed.rawRows[0]!).not.toEqual(second.rawRows[0])
})
it('live result retains an unmodified response and typed rows in a versioned additive envelope', async () => {
  const raw = body([row], '\n')
  const result = await runPlatformLiveQuery(query, context(raw))
  expect(result.status).toBe('success')
  expect(result.rawData).toEqual({ version: 1, rows: [row], pages: [{ source: 'queryBusList', rdjb: '2', page: 1, format: 'json', body: raw }] })
  expect(result.rows[0]).toMatchObject({ n: '1', b: 'true', x: '' })
})
it('whole-result admission budgets include large original response text and typed rows without truncation', async () => {
  const raw = body([{ id: 'large', n: 1 }], ' '.repeat(70000))
  const rejected = await runPlatformLiveQuery(query, context(raw, 65536))
  expect(rejected).toMatchObject({ status: 'partial', fetchedCount: 0, error: { code: 'safety_limit' }, rawData: { rows: [], pages: [] }, unfinished: [{ page: 1 }] })
  expect(Buffer.byteLength(JSON.stringify(rejected))).toBeLessThan(65536)
  const accepted = await runPlatformLiveQuery(query, context(raw, 100000))
  expect(accepted.status).toBe('success')
  expect(accepted.rawData!.pages[0]!.body).toBe(raw)
})
it.each([
  ['nested_key', body([{ nested: { accessToken: 'private' } }])],
  ['envelope_key', body([{ id: 'safe' }]).replace('"zrarData"', '"sessionToken":"private","zrarData"')],
  ['credential_echo', body([{ id: 'safe' }], ' synthetic-raw-json-secret')],
])('rejects sensitive original or nested values without returning source material case %s', async (_label, raw) => {
  const result = await runPlatformLiveQuery(query, context(raw))
  expect(result).toMatchObject({ status: 'failed', error: { code: 'sensitive_response' }, rawData: { rows: [], pages: [] } })
  expect(JSON.stringify(result)).not.toContain('private')
  expect(JSON.stringify(result)).not.toContain('synthetic-raw-json-secret')
})

it('recognized archive validates typed source and legacy projection while accepting unchanged string-only history', async () => {
  const { recognizedEvidenceError, recognizedResultToImport } = await import('../lib/platform/recognized-evidence')
  const result = await runPlatformLiveQuery(query, context(body([row])))
  expect(recognizedEvidenceError(result)).toBeNull()
  expect(recognizedResultToImport(result).collectionEvidence!.rawData).toEqual(result.rawData)
  const old = structuredClone(result)
  delete old.rawData
  expect(recognizedEvidenceError(old)).toBeNull()
  expect(recognizedResultToImport(old).collectionEvidence).toEqual(old)
  for (const mutate of [
    (r: any) => { r.rawData.rows[0].n = '1' },
    (r: any) => { r.rawData.pages[0].page = 2 },
    (r: any) => { r.rawData.pages = [] },
    (r: any) => { r.rawData.version = 2 },
    (r: any) => { r.rows[0].n = '2' },
  ]) {
    const bad = structuredClone(result); mutate(bad)
    expect(recognizedEvidenceError(bad)).not.toBeNull()
    expect(() => recognizedResultToImport(bad)).toThrow()
  }
})

it('legacy live calls retain their payload and unsupported raw versions fail without fallback', async () => {
  const { rawDataVersion: _version, ...legacy } = query
  const result = await runPlatformLiveQuery(legacy, context(body([row])))
  expect(result.status).toBe('success')
  expect(Object.hasOwn(result, 'rawData')).toBe(false)
  await expect(runPlatformLiveQuery({ ...query, rawDataVersion: 2 }, context(body([row])))).rejects.toMatchObject({ statusCode: 400, code: 'invalid_input' })
})

it('embedded HTML retains typed JSON while rendered table observations remain strings with original source', async () => {
  const embedded = `<script>(function(data){} )(${body([row]).trim()});</script>`
  const result = await runPlatformLiveQuery(query, context(embedded))
  expect(result).toMatchObject({ status: 'success', rawData: { rows: [row], pages: [{ format: 'html-script', body: embedded }] } })
  const table = '<table name="businessGrid"><th id="id">ID</th><th id="n">N</th><tbody><tr><td>table</td><td>1</td></tr></tbody></table>'
  const parsed = parsePlatformPage(table, 'businessGrid')
  expect(parsed.rawRows).toEqual([{ id: 'table', n: '1' }])
  expect(parsed.source).toBe('html-table')
})

it('public result schema validates JSON without dropping prototype-named keys from typed observations', async () => {
  const { z } = await import('zod')
  const { platformQueryResultShape } = await import('../lib/platform/live-query')
  const original = await runPlatformLiveQuery(query, context(body([row])))
  const parsed = z.object(platformQueryResultShape).parse(original)
  expect(parsed.rawData!.rows).toEqual([row])
  expect(Object.hasOwn(parsed.rawData!.rows[0]!, '__proto__')).toBe(true)
})

it('typed result schema rejects non JSON values even under prototype-named unknown fields', async () => {
  const { z } = await import('zod')
  const { platformQueryResultShape } = await import('../lib/platform/live-query')
  const original = await runPlatformLiveQuery(query, context(body([row])))
  for (const invalid of [undefined, NaN, Infinity, 1n, new Date()]) {
    const value = structuredClone(original)
    Object.defineProperty(value.rawData!.rows[0]!, '__proto__', { value: invalid, enumerable: true, configurable: true })
    expect(z.object(platformQueryResultShape).safeParse(value).success).toBe(false)
  }
})

it.each([
  ['escaped_envelope_value', body([{ id: 'safe' }]).replace('"zrarData"', '"other":"synthetic-raw-json-\\u0073ecret","zrarData"')],
  ['escaped_envelope_key', body([{ id: 'safe' }]).replace('"zrarData"', '"tok\\u0065n":"private","zrarData"')],
])('original response rejects decoded JSON credentials outside row data case %s', async (_label, raw) => {
  const result = await runPlatformLiveQuery(query, context(raw))
  expect(result).toMatchObject({ status: 'failed', error: { code: 'sensitive_response' }, rawData: { rows: [], pages: [] } })
})

it('Spec R1 P1 rejects escaped credentials in scripts outside the grid without accepting original pages', async () => {
  const html = `<script>window.config={"other":"synthetic-raw-json-\\u0073ecret"};</script><script>(function(data){} )(${body([{ id: 'safe' }]).trim()});</script>`
  const result = await runPlatformLiveQuery(query, context(html))
  expect(result).toMatchObject({ status: 'failed', completeness: 'partial', fetchedCount: 0, error: { code: 'sensitive_response' }, rawData: { version: 1, rows: [], pages: [] }, pages: [{ status: 'failed', fetchedCount: 0 }], unfinished: [{ source: 'queryBusList', rdjb: '2', page: 1 }] })
  expect(JSON.stringify(result)).not.toContain('window.config')
})

it.each([
  ['double_quote', '<input type="hidden" name="csrfToken" value="synthetic-other-token">'],
  ['single_quote', "<input name='username' value='synthetic-user'>"],
  ['unquoted_case', '<INPUT NAME=csrfToken VALUE=synthetic-other-token>'],
  ['entity_attribute', '<input name="csrf&#84;oken" value="synthetic-other-token">'],
  ['percent_attribute', '<input name="%75sername" value="synthetic-user">'],
  ['textarea', '<textarea name="username">synthetic-user</textarea>'],
])('Standards R1 P1 rejects entire HTML form response case %s', async (_label, control) => {
  const html = `${control}<script>(function(data){})(${body([{ id: 'safe' }]).trim()});</script>`
  const result = await runPlatformLiveQuery(query, context(html))
  expect(result).toMatchObject({ status: 'failed', completeness: 'partial', fetchedCount: 0, error: { code: 'sensitive_response' }, rawData: { version: 1, rows: [], pages: [] }, pages: [{ status: 'failed', fetchedCount: 0 }], unfinished: [{ source: 'queryBusList', rdjb: '2', page: 1 }] })
  expect(JSON.stringify(result)).not.toContain('synthetic-other-token')
  expect(JSON.stringify(result)).not.toContain('synthetic-user')
})

it('Spec R1 P2 table raw rows retain prototype-named own cells independently of the legacy projection', async () => {
  const table = '<table name="applyGrid"><thead><tr><th id="id">ID</th><th id="__proto__">raw</th><th id="constructor">ctor</th></tr></thead><tbody><tr><td>safe</td><td>original-cell</td><td>own</td></tr></tbody></table>'
  const parsed = parsePlatformPage(table, 'applyGrid')
  const expected = JSON.parse('{"id":"safe","__proto__":"original-cell","constructor":"own"}')
  expect(parsed.rawRows).toEqual([expected])
  const rawRow = parsed.rawRows[0]
  if (!rawRow) throw new Error('Expected a raw table observation')
  expect(Object.hasOwn(rawRow, '__proto__')).toBe(true)
  expect(Object.getPrototypeOf(rawRow)).toBe(Object.prototype)
  expect(parsed.rows).toEqual([{ id: 'safe', constructor: 'own' }])
  const result = await runPlatformLiveQuery({ source: 'queryList', name: '合成', rawDataVersion: 1, maxRequests: 1 }, context(table))
  expect(result).toMatchObject({ status: 'partial', fetchedCount: 1, rawData: { version: 1, rows: [expected], pages: [{ format: 'html-table', body: table }] } })
})

it.each(['json', 'html_wrapper', 'html_json_island'])('safe JSON and verifiable HTML remain byte exact case %s', async format => {
  const json = body([{ id: 'safe', missingNull: null, unknown: ['中文', 1, false] }])
  const raw = format === 'json' ? json : format === 'html_json_island'
    ? `<script type="application/json">${json}</script>`
    : `<html><head><title>合成页</title></head><body><div class="result"><script>(function(data){})(${json});</script></div></body></html>`
  const result = await runPlatformLiveQuery(query, context(raw))
  expect(result).toMatchObject({ status: 'success', fetchedCount: 1, rawData: { version: 1, rows: [{ id: 'safe', missingNull: null, unknown: ['中文', 1, false] }], pages: [{ body: raw }] } })
})

it.each([
  ['unicode_braces', '<script>window.config={other:"synthetic-raw-json-\\u{73}ecret"}</script>'],
  ['hex_escape', '<script>window.config={other:"synthetic-raw-json-\\x73ecret"}</script>'],
  ['concatenated_script', '<script>window.config={other:"synthetic-raw-json-"+"secret"}</script>'],
  ['entity_text', '<p>&#115;ynthetic-raw-json-secret</p>'],
  ['percent_text', '<p>%73ynthetic-raw-json-secret</p>'],
  ['escaped_text', '<p>synthetic-raw-json-\\u0073ecret</p>'],
])('credential echoes remain refused in encoded HTML case %s', async (_label, prefix) => {
  const raw = `${prefix}<script>(function(data){})(${body([{ id: 'safe' }]).trim()});</script>`
  const result = await runPlatformLiveQuery(query, context(raw))
  expect(result).toMatchObject({ status: 'failed', fetchedCount: 0, error: { code: 'sensitive_response' }, rawData: { rows: [], pages: [] }, unfinished: [{ page: 1 }] })
})

it('stores the actual DWZ wrapper unchanged without executing its scripts', async () => {
  const raw = `<script>(function(data){throw new Error('must not run')})(${body([{ id: 'safe' }]).trim()});</script>`
  const result = await runPlatformLiveQuery(query, context(raw))
  expect(result).toMatchObject({ status: 'success', rawData: { rows: [{ id: 'safe' }], pages: [{ body: raw }] } })
  expect(result.rows).toEqual([{ id: 'safe' }])
})

it.each([
  '<div onclick="globalThis.platformArchiveExecuted=true">合成页</div>',
  '<div data-private="opaque" style="display:block">合成页 &amp; 数据</div>',
  '<script>globalThis.platformArchiveExecuted=true</script>',
])('preserves surrounding platform markup as data rather than requiring an HTML whitelist: %s', async prefix => {
  const raw = `${prefix}<script>(function(data){})(${body([{ id: 'safe' }]).trim()});</script>`
  const result = await runPlatformLiveQuery(query, context(raw))
  expect(result).toMatchObject({ status: 'success', rawData: { rows: [{ id: 'safe' }], pages: [{ body: raw }] } })
  expect(Object.hasOwn(globalThis, 'platformArchiveExecuted')).toBe(false)
})

it('safe HTML original bytes count in the complete result budget without silent truncation', async () => {
  const raw = `<script>(function(data){})(${body([{ id: 'large-safe' }]).trim()});</script>` + ' '.repeat(70000)
  const rejected = await runPlatformLiveQuery(query, context(raw, 65536))
  expect(rejected).toMatchObject({ status: 'partial', error: { code: 'safety_limit' }, rawData: { rows: [], pages: [] }, unfinished: [{ page: 1 }] })
  const accepted = await runPlatformLiveQuery(query, context(raw, 100000))
  expect(accepted).toMatchObject({ status: 'success', rawData: { pages: [{ body: raw }] } })
})

it('legacy callers retain only their string projection and raw opt-in never silently falls back', async () => {
  const raw = `<input name="csrfToken" value="synthetic-unpublished"><script>(function(data){})(${body([{ id: 'safe' }]).trim()});</script>`
  const { rawDataVersion: _version, ...legacyQuery } = query
  const legacy = await runPlatformLiveQuery(legacyQuery, context(raw))
  expect(legacy.status).toBe('success')
  expect(legacy.rows).toEqual([{ id: 'safe' }])
  expect(Object.hasOwn(legacy, 'rawData')).toBe(false)
  expect(JSON.stringify(legacy)).not.toContain('synthetic-unpublished')
  const original = await runPlatformLiveQuery(query, context(raw))
  expect(original).toMatchObject({ status: 'failed', rows: [], rawData: { rows: [], pages: [] }, error: { code: 'sensitive_response' } })
})
